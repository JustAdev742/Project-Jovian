"""A leaky integrate-and-fire simulation of the whole male-CNS connectome.

165,122 neurons, 15.3M connections, 113.7M synapses. Every edge weight is a
real synapse count from the Janelia reconstruction, signed by the presynaptic
cell's predicted transmitter. Nothing here is trained or fitted to behaviour:
the free parameters are the single-synapse voltage step, the membrane
constants, and a background drive, which is the usual shape of this kind of
connectome model.

Propagation is event driven -- each step touches only the outgoing edges of the
neurons that actually fired. The two hot loops live in native/flykernel.c; if
the DLL is missing the numpy path below produces the same result, slower.
"""
from __future__ import annotations

import ctypes
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BRAIN = ROOT / "brain"
DLL = ROOT / "native" / "flykernel.dll"

c_i64p = ctypes.POINTER(ctypes.c_int64)
c_i32p = ctypes.POINTER(ctypes.c_int32)
c_i16p = ctypes.POINTER(ctypes.c_int16)
c_f32p = ctypes.POINTER(ctypes.c_float)


def _load_kernel():
    if not DLL.exists():
        return None
    lib = ctypes.CDLL(str(DLL))
    lib.fly_propagate.restype = None
    lib.fly_propagate.argtypes = [c_i64p, c_i32p, c_f32p, c_i64p, ctypes.c_int64,
                                  c_f32p, ctypes.c_int64, ctypes.c_float, ctypes.c_int]
    lib.fly_membrane.restype = ctypes.c_int64
    lib.fly_membrane.argtypes = ([c_f32p, c_f32p, c_i16p, c_f32p, c_f32p, c_f32p,
                                  c_i64p, ctypes.c_int64]
                                 + [c_f32p] + [ctypes.c_float] * 7
                                 + [ctypes.c_int64, ctypes.c_float, ctypes.c_float,
                                    ctypes.c_float, ctypes.c_int16])
    lib.fly_propagate_delayed.restype = None
    lib.fly_propagate_delayed.argtypes = [c_i64p, c_i32p, c_f32p, c_i64p, ctypes.c_int64,
                                          c_f32p, ctypes.c_int64, ctypes.c_int64,
                                          ctypes.c_int64, c_i16p, ctypes.c_float]
    lib.fly_seed.restype = None
    lib.fly_seed.argtypes = [ctypes.c_uint64, ctypes.c_uint64]
    return lib


_LIB = _load_kernel()


def _p(a, t):
    return a.ctypes.data_as(t)


class FlyBrain:
    # membrane constants, in millivolts and milliseconds
    V_REST = -52.0
    V_THRESH = -45.0
    V_RESET = -52.0
    TAU_MEM = 20.0
    REFRACTORY_MS = 2.2

    def __init__(
        self,
        dt: float = 1.0,
        syn_gain: float = 0.10,    # mV contributed by one synapse, one spike
        adapt_step: float = 2.0,   # mV of after-hyperpolarisation per spike
        adapt_tau: float = 150.0,  # ms
        bg_hz: float = 0.0,        # background events per neuron per second
        bg_mv: float = 3.0,        # size of one background event
        # bg_hz defaults to zero. With the graded cells sitting at threshold a 3 mV
        # background kick fires them outright, so any background at all drowns the
        # visual signal: measured drifting-vs-static contrast went from 1.1x with
        # bg_hz=8 to better than 40x with it off.
        brain_dir: Path = BRAIN,
        seed: int = 0,
        native: bool = True,
    ):
        self.dir = Path(brain_dir)
        self.indptr = np.ascontiguousarray(np.load(self.dir / "csr_indptr.npy"), np.int64)
        self.indices = np.ascontiguousarray(np.load(self.dir / "csr_indices.npy"), np.int32)
        self.weight = np.ascontiguousarray(np.load(self.dir / "csr_weight.npy"), np.float32)
        self.n = len(self.indptr) - 1
        self.meta = json.loads((self.dir / "meta.json").read_text())

        self.dt = float(dt)
        self.syn_gain = float(syn_gain)
        self.adapt_step = float(adapt_step)
        self.adapt_decay = float(np.exp(-dt / adapt_tau))
        self.bg_hz = float(bg_hz)
        self.bg_mv = float(bg_mv)
        tau_file = self.dir / "tau_ms.npy"
        tau = (np.load(tau_file).astype(np.float32) if tau_file.exists()
               else np.full(self.n, self.TAU_MEM, dtype=np.float32))
        self.tau = tau
        dfile = self.dir / "delay_ms.npy"
        delay_ms = (np.load(dfile).astype(np.float32) if dfile.exists()
                    else np.full(self.n, 2.0, dtype=np.float32))
        self.delay = np.ascontiguousarray(
            np.maximum(1, np.round(delay_ms / dt)).astype(np.int16))
        self.ring_len = int(self.delay.max()) + 1
        self.ring = np.zeros((self.ring_len, self.n), dtype=np.float32)
        gfile = self.dir / "graded.npy"
        self.graded = (np.load(gfile).astype(np.float32) if gfile.exists()
                       else np.zeros(self.n, dtype=np.float32))
        self.alpha = np.ascontiguousarray(dt / tau, dtype=np.float32)
        self.refrac_steps = max(1, int(round(self.REFRACTORY_MS / dt)))
        self.rng = np.random.default_rng(seed)
        self.lib = _LIB if native else None
        if self.lib:
            self.lib.fly_seed(ctypes.c_uint64(0x243F6A8885A308D3 ^ (seed * 2654435761)),
                              ctypes.c_uint64(0x13198A2E03707344 ^ seed))

        self.V = np.full(self.n, self.V_REST, dtype=np.float32)
        self.adapt = np.zeros(self.n, dtype=np.float32)
        self.refrac = np.zeros(self.n, dtype=np.int16)
        self.rate = np.zeros(self.n, dtype=np.float32)
        self._fired_buf = np.zeros(self.n, dtype=np.int64)
        self._rate_alpha = float(1.0 - np.exp(-dt / 50.0))
        self._bg_k = int(round(self.n * self.bg_hz * dt / 1000.0))
        self.t_ms = 0.0
        self.steps = 0
        self.n_fired = 0
        self.pending = self.ring[0]

    # ------------------------------------------------------------------
    def _propagate_np(self, fired_idx):
        out = np.zeros(self.n, dtype=np.float32)
        if fired_idx.size == 0:
            return out
        starts = self.indptr[fired_idx]
        counts = self.indptr[fired_idx + 1] - starts
        total = int(counts.sum())
        if total == 0:
            return out
        base = np.repeat(starts - np.concatenate(([0], np.cumsum(counts)[:-1])), counts)
        flat = base + np.arange(total, dtype=np.int64)
        return np.bincount(self.indices[flat], weights=self.weight[flat],
                           minlength=self.n).astype(np.float32) * self.syn_gain

    def _step_np(self, inject_mv):
        slot = self.steps % self.ring_len
        self.pending = self.ring[slot]
        V = self.V
        V *= (1.0 - self.alpha)
        V += self.alpha * self.V_REST
        V += self.pending
        V -= self.adapt
        if inject_mv is not None:
            V += inject_mv
        if self._bg_k:
            V[self.rng.integers(0, self.n, self._bg_k)] += self.bg_mv
        np.clip(V, -90.0, 20.0, out=V)
        busy = self.refrac > 0
        np.maximum(self.refrac - 1, 0, out=self.refrac)
        V[busy] = self.V_RESET
        fired = (V >= self.V_THRESH) & ~busy
        fired_idx = np.flatnonzero(fired)
        V[fired_idx] = self.V_RESET
        self.refrac[fired_idx] = self.refrac_steps
        self.adapt *= self.adapt_decay
        self.adapt[fired_idx] += self.adapt_step
        self.rate *= (1.0 - self._rate_alpha)
        self.rate[fired_idx] += self._rate_alpha * (1000.0 / self.dt)
        self.ring[slot] = 0.0
        if fired_idx.size:
            starts = self.indptr[fired_idx]
            counts = self.indptr[fired_idx + 1] - starts
            for i, (st, ct) in enumerate(zip(starts, counts)):
                if ct:
                    tgt = (self.steps + int(self.delay[fired_idx[i]])) % self.ring_len
                    np.add.at(self.ring[tgt], self.indices[st:st + ct],
                              self.weight[st:st + ct] * self.syn_gain)
        return fired_idx

    def step(self, inject_mv: np.ndarray | None = None) -> np.ndarray:
        """Advance one dt. `inject_mv` is an optional per-neuron drive in mV."""
        if self.lib is None:
            fired_idx = self._step_np(inject_mv)
        else:
            slot = self.steps % self.ring_len
            self.pending = self.ring[slot]
            inj = _p(inject_mv, c_f32p) if inject_mv is not None else None
            nf = self.lib.fly_membrane(
                _p(self.V, c_f32p), _p(self.adapt, c_f32p), _p(self.refrac, c_i16p),
                _p(self.rate, c_f32p), _p(self.pending, c_f32p), inj,
                _p(self._fired_buf, c_i64p), self.n,
                _p(self.alpha, c_f32p), self.V_REST, self.V_THRESH, self.V_RESET,
                self.adapt_decay, self.adapt_step,
                self._rate_alpha, 1000.0 / self.dt,
                self._bg_k, self.bg_mv, -90.0, 20.0, self.refrac_steps)
            fired_idx = self._fired_buf[:nf]
            self.ring[slot] = 0.0            # this slot has now been consumed
            self.lib.fly_propagate_delayed(
                _p(self.indptr, c_i64p), _p(self.indices, c_i32p),
                _p(self.weight, c_f32p), _p(fired_idx, c_i64p), nf,
                _p(self.ring, c_f32p), self.n, self.ring_len, self.steps,
                _p(self.delay, c_i16p), self.syn_gain)
        self.n_fired = len(fired_idx)
        self.t_ms += self.dt
        self.steps += 1
        return fired_idx

    # ------------------------------------------------------------------
    def group_rate(self, idx: np.ndarray) -> float:
        return float(self.rate[idx].mean()) if len(idx) else 0.0

    def mean_rate(self) -> float:
        return float(self.rate.mean())

    def reset(self):
        self.V[:] = self.V_REST
        self.adapt[:] = 0
        self.refrac[:] = 0
        self.ring[:] = 0
        self.rate[:] = 0
        self.t_ms = 0.0
        self.steps = 0


# ----------------------------------------------------------------------
def load_groups(brain_dir: Path = BRAIN) -> dict:
    raw = json.loads((Path(brain_dir) / "groups.json").read_text())
    return {k: {"note": v["note"], "idx": np.array(v["idx"], dtype=np.int64)}
            for k, v in raw.items()}


def load_atlas(brain_dir: Path = BRAIN) -> dict:
    return dict(np.load(Path(brain_dir) / "atlas.npz"))


# ----------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    import time

    ap = argparse.ArgumentParser(description="benchmark and sanity-check the network")
    ap.add_argument("--ms", type=int, default=1000)
    ap.add_argument("--dt", type=float, default=1.0)
    ap.add_argument("--gain", type=float, default=0.10)
    ap.add_argument("--bg-hz", type=float, default=0.0)
    ap.add_argument("--bg-mv", type=float, default=3.0)
    ap.add_argument("--numpy", action="store_true", help="force the numpy path")
    ap.add_argument("--dark", action="store_true",
                    help="benchmark with no input at all (will be silent)")
    a = ap.parse_args()

    b = FlyBrain(dt=a.dt, syn_gain=a.gain, bg_hz=a.bg_hz, bg_mv=a.bg_mv,
                 native=not a.numpy)
    print(f"neurons {b.n:,}  edges {len(b.indices):,}  "
          f"synapses {b.meta['synapses']:,.0f}  kernel={'native' if b.lib else 'numpy'}")
    groups = load_groups()

    # Benchmark under visual load. With the background drive off an undriven network is
    # silent, and timing a silent network measures nothing that matters.
    # Benchmark under visual load, and specifically under a MOVING stimulus. The retina
    # adapts with a 400 ms time constant, so a static scene fades to nothing -- correct
    # for a fly, useless for timing.
    retina = frames = None
    if not a.dark:
        from vision import Retina
        retina = Retina(groups, load_atlas(), b.n, dt=b.dt,
                        graded=b.graded, graded_bias=1.0)
        _, xx = np.mgrid[0:180, 0:320].astype(np.float32)
        frames = [np.repeat((0.5 + 0.45 * np.sin((xx / 320 * 6.0 - k * 0.06) * 2 * np.pi))
                            [:, :, None], 3, axis=2) for k in range(64)]
        for k in range(200):
            b.step(retina.encode(frames[k % len(frames)]))   # settle before timing

    t0 = time.perf_counter()
    nspk = 0
    for k in range(int(a.ms / a.dt)):
        inject = None if retina is None else retina.encode(frames[(k // 25) % len(frames)])
        nspk += len(b.step(inject))
    el = time.perf_counter() - t0
    print(f"{b.steps} steps of {a.dt} ms in {el:.2f}s -> "
          f"{b.steps * a.dt / (el * 1000):.2f}x real time, {1000 * el / b.steps:.2f} ms/step")
    print(f"mean rate {b.mean_rate():.2f} Hz   spikes {nspk:,}   "
          f"active {int((b.rate > 0.5).sum()):,}")
    for k in ("R1-6", "L1", "T4a", "DN_all", "leg_all", "neck_L", "proboscis"):
        print(f"   {k:10s} {b.group_rate(groups[k]['idx']):6.2f} Hz")
