"""Find the operating point where the connectome is actually in the loop.

A cell's steady membrane offset above rest is (drive per step) x (tau / dt). The
first version of this model set the tonic drive for graded cells by sweeping
until they fired, which put Tm9 at 280 mV above a 7 mV threshold. At that point
a cell's rate is set by its bias and its presynaptic partners are a rounding
error -- measured modulation at Mi1 was 0.159 while the L1 driving it was at
1.589. The wiring was barely participating.

So bias is expressed here as a fraction of threshold instead: `k = 1.0` puts a
cell exactly at its own firing threshold, where synaptic input decides whether
it fires. This sweeps k against the synaptic gain and reports, for each
combination, how deeply each stage is modulated by a drifting grating.

Modulation depth is measured per cell and then averaged, because neighbouring
columns see different phases of the grating and a population average cancels
most of the signal.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sim import FlyBrain, load_atlas, load_groups   # noqa: E402
from vision import Retina                           # noqa: E402

W, H = 320, 180
V_SWING = FlyBrain.V_THRESH - FlyBrain.V_REST       # mV from rest to threshold


def threshold_bias(brain, k: float) -> np.ndarray:
    """Tonic drive that leaves each graded cell k of the way to its threshold."""
    per_step = V_SWING / (brain.tau / brain.dt)
    return np.where(brain.graded > 0, per_step * k, 0.0).astype(np.float32)


def grating(phase, cycles=6.0, contrast=0.9):
    _, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = 0.5 + 0.5 * contrast * np.sin((xx / W * cycles - phase) * 2 * np.pi)
    return np.repeat(g[:, :, None], 3, axis=2)


def modulation(brain, retina, probes, frames, frame_ms, freq_hz):
    """Per-cell F1/DC at the stimulus frequency, averaged over cells."""
    traces = {k: [] for k in probes}
    times = []
    steps = int(frame_ms / brain.dt)
    t = 0.0
    for f in frames:
        inj = retina.encode(f)
        for _ in range(steps):
            brain.step(inj)
            t += brain.dt / 1000.0
            if int(t * 1000) % 5 == 0:
                for k, idx in probes.items():
                    traces[k].append(brain.rate[idx].copy())
                times.append(t)
    out = {}
    tt = np.asarray(times)
    keep = tt > tt[-1] * 0.35        # drop the onset transient
    z = np.exp(-2j * np.pi * freq_hz * tt[keep])[:, None]
    for k, v in traces.items():
        V = np.asarray(v)[keep]
        dc = V.mean(0)
        comp = np.abs((V * z).mean(0) * 2)
        good = dc > 0.2
        out[k] = (float(np.mean(comp[good] / dc[good])) if good.sum() > 5 else 0.0,
                  float(dc.mean()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=36)
    ap.add_argument("--frame-ms", type=float, default=25.0)
    ap.add_argument("--speed", type=float, default=0.06)
    ap.add_argument("--k", type=float, nargs="*",
                    default=[0.80, 0.90, 0.95, 1.00])
    ap.add_argument("--gain", type=float, nargs="*", default=[0.10, 0.25, 0.5])
    a = ap.parse_args()

    groups, atlas = load_groups(), load_atlas()
    freq = a.speed * 1000.0 / a.frame_ms
    probe_types = ("L1", "Mi1", "Mi9", "Tm9", "T4a", "T4b")

    print(f"grating at {freq:.2f} Hz. Reporting per-cell F1/DC (modulation depth) and mean rate.")
    print("A stage that is being driven by the connectome should modulate; one that is being")
    print("driven by its own bias will not.")
    print()
    print(f"{'k':>5s} {'gain':>5s} {'mean':>6s} " +
          " ".join(f"{t:>13s}" for t in probe_types))

    for k in a.k:
        for gain in a.gain:
            brain = FlyBrain(syn_gain=gain, bg_hz=8.0)
            bias = threshold_bias(brain, k)
            retina = Retina(groups, atlas, brain.n, mode="lamina", dt=brain.dt,
                            graded=bias, graded_bias=1.0)
            probes = {t: groups[t]["idx"] for t in probe_types}
            inj = retina.encode(grating(0.0))
            for _ in range(700):
                brain.step(inj)
            frames = [grating(i * a.speed) for i in range(a.frames)]
            res = modulation(brain, retina, probes, frames, a.frame_ms, freq)
            cells = " ".join(f"{res[t][0]:6.3f}/{res[t][1]:6.1f}" for t in probe_types)
            print(f"{k:5.2f} {gain:5.2f} {brain.mean_rate():6.2f} {cells}")


if __name__ == "__main__":
    main()
