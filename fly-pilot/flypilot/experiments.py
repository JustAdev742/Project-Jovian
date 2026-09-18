"""Does the simulated brain actually see? Classic fly vision assays.

These are experiments you would run on a real tethered fly, run instead on the
reconstruction. They are the difference between a pipeline that executes and a
pipeline that works, and they are designed to be able to fail.

  optomotor  a drifting grating should drive the direction-tuned T4/T5 cells
             asymmetrically, oppositely in the two eyes, and the asymmetry
             should reverse when the drift reverses.
  looming    an expanding dark disc should reach the giant fiber, the cell
             whose spike launches an escape.
  flash      light should drive the photoreceptors and, through a sign
             inverting histamine synapse, push the lamina the other way.

Nothing here is tuned to make a result come out. The numbers are whatever the
connectome gives, including when that is nothing.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sim import FlyBrain, load_atlas, load_groups   # noqa: E402
from vision import Retina                           # noqa: E402

W, H = 320, 180


def log(m):
    print(m, flush=True)


def new_rig(dt=1.0, hfov=120.0, vfov=68.0, gain=0.10, bg_hz=0.0, bias=1.0,
            mode="lamina"):
    brain = FlyBrain(dt=dt, syn_gain=gain, bg_hz=bg_hz)
    groups = load_groups()
    atlas = load_atlas()
    retina = Retina(groups, atlas, brain.n, mode=mode, hfov=hfov, vfov=vfov, dt=dt,
                    graded=brain.graded, graded_bias=bias)
    return brain, groups, retina


def eye_split(groups, atlas, name):
    """Indices of a cell type, separated by optic lobe."""
    idx = groups[name]["idx"]
    side = atlas["side"][idx]
    return {"L": idx[side == 0], "R": idx[side == 1]}


def settle(brain, retina, ms=800, frame=None):
    if frame is None:
        frame = np.full((H, W, 3), 0.35, dtype=np.float32)
    inj = retina.encode(frame)
    for _ in range(int(ms / brain.dt)):
        brain.step(inj)


def run(brain, retina, frames, ms_per_frame, probes):
    """Show a sequence of frames, return the mean rate per probe group."""
    acc = {k: [] for k in probes}
    steps = int(ms_per_frame / brain.dt)
    for f in frames:
        inj = retina.encode(f)
        for _ in range(steps):
            brain.step(inj)
        for k, idx in probes.items():
            acc[k].append(brain.group_rate(idx))
    return {k: float(np.mean(v[len(v) // 3:])) for k, v in acc.items()}


def grating(phase, cycles=6.0, contrast=0.9):
    _, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = 0.5 + 0.5 * contrast * np.sin((xx / W * cycles - phase) * 2 * np.pi)
    return np.repeat(g[:, :, None], 3, axis=2)


# ----------------------------------------------------------------------
def optomotor(args):
    log("")
    log("=== optomotor: a drifting grating ===")
    log("A grating drifts one way, then the other.")
    log("")
    log("The two eyes have to be scored separately. T4a prefers front-to-back in")
    log("its own eye's frame, and a single world direction is front-to-back for")
    log("one eye and back-to-front for the other, so pooling the eyes cancels the")
    log("very signal we are looking for. A real fly shows that mirror symmetry,")
    log("and it is the signature to look for here.")
    log("")

    atlas = load_atlas()
    rates = {}
    for direction, sign in (("rightward", +1.0), ("leftward", -1.0)):
        brain, groups, retina = new_rig(gain=args.gain, bg_hz=args.bg_hz, mode=args.mode)
        if direction == "rightward":
            log(f"  {retina.summary()}")
            log(f"  distinct eye columns receiving drive: "
                f"{retina.columns_lit(atlas['hex1'], atlas['hex2'])}")
            log("")
        probes = {}
        for ct in ("T4a", "T4b", "T4c", "T4d", "T5a", "T5b", "L1", "Mi1"):
            for eye, idx in eye_split(groups, atlas, ct).items():
                probes[f"{ct}_{eye}"] = idx
        for ct in ("neck_L", "neck_R", "leg_L", "leg_R", "DN_all"):
            probes[ct] = groups[ct]["idx"]
        settle(brain, retina, 900, grating(0.0))
        frames = [grating(sign * i * args.speed) for i in range(args.frames)]
        rates[direction] = run(brain, retina, frames, args.frame_ms, probes)

    r, l = rates["rightward"], rates["leftward"]
    log(f"  {'cell':8s} {'eye':>4s} {'rightward':>10s} {'leftward':>10s} {'difference':>11s}")
    for ct in ("T4a", "T4b", "T4c", "T4d", "T5a", "T5b", "Mi1", "L1"):
        for eye in ("L", "R"):
            k = f"{ct}_{eye}"
            log(f"  {ct:8s} {eye:>4s} {r[k]:10.3f} {l[k]:10.3f} {r[k] - l[k]:+11.3f}")

    log("")
    log("  horizontal opponency, per eye (T4a preference minus T4b preference):")
    verdict = {}
    for eye in ("L", "R"):
        a_pref = r[f"T4a_{eye}"] - l[f"T4a_{eye}"]    # how much T4a prefers rightward
        b_pref = r[f"T4b_{eye}"] - l[f"T4b_{eye}"]
        verdict[eye] = a_pref - b_pref
        log(f"    eye {eye}: T4a prefers rightward by {a_pref:+.3f} Hz, "
            f"T4b by {b_pref:+.3f} Hz   -> opponency {verdict[eye]:+.3f}")
    mirror = verdict["L"] * verdict["R"] < 0
    log("")
    log(f"    the eyes are {'MIRRORED, as they should be' if mirror else 'NOT mirrored'}"
        f"   (L {verdict['L']:+.3f} vs R {verdict['R']:+.3f})")

    log("")
    log("  T5 (OFF pathway), same measure:")
    for eye in ("L", "R"):
        a_pref = r[f"T5a_{eye}"] - l[f"T5a_{eye}"]
        b_pref = r[f"T5b_{eye}"] - l[f"T5b_{eye}"]
        log(f"    eye {eye}: opponency {a_pref - b_pref:+.3f}")

    log("")
    log("  vertical pair T4c/T4d, which should barely care about horizontal drift:")
    for eye in ("L", "R"):
        c_pref = r[f"T4c_{eye}"] - l[f"T4c_{eye}"]
        d_pref = r[f"T4d_{eye}"] - l[f"T4d_{eye}"]
        log(f"    eye {eye}: vertical opponency {c_pref - d_pref:+.3f}   "
            f"(horizontal control {verdict[eye]:+.3f})")

    nl = (r["neck_L"] - r["neck_R"]) - (l["neck_L"] - l["neck_R"])
    log("")
    log(f"  neck motor imbalance swing between the two directions: {nl:+.3f} Hz")
    return rates


# ----------------------------------------------------------------------
def looming(args):
    log("")
    log("=== looming: an expanding dark disc ===")
    log("The giant fiber DNp01 is one cell per side whose spike launches an")
    log("escape, and a looming object is its natural trigger. A receding disc")
    log("and a static one are the controls.")
    log("")

    out = {}
    for name in ("loom", "receding", "static"):
        brain, groups, retina = new_rig(gain=args.gain, bg_hz=args.bg_hz, mode=args.mode)
        gf = groups["DNp01"]["idx"]
        settle(brain, retina, 800)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        d = np.hypot(xx - W / 2, yy - H / 2)
        n = args.frames
        radii = {"loom": np.linspace(4, 110, n),
                 "receding": np.linspace(110, 4, n),
                 "static": np.full(n, 55.0)}[name]
        spikes, peak = 0, 0.0
        steps = int(args.frame_ms / brain.dt)
        for rad in radii:
            f = np.repeat(np.where(d < rad, 0.02, 0.8)[:, :, None].astype(np.float32), 3, 2)
            inj = retina.encode(f)
            for _ in range(steps):
                fired = brain.step(inj)
                if fired.size:
                    pos = np.clip(np.searchsorted(fired, gf), 0, fired.size - 1)
                    spikes += int((fired[pos] == gf).sum())
            peak = max(peak, brain.group_rate(gf))
        out[name] = {"spikes": spikes, "peak_hz": peak}
        log(f"  {name:9s} giant-fiber spikes {spikes:4d}   peak rate {peak:6.2f} Hz")
    return out


# ----------------------------------------------------------------------
def flash(args):
    log("")
    log("=== flash: light on, light off ===")
    log("Photoreceptors are histaminergic, so they inhibit the lamina. Light")
    log("should raise R1-R6 and push L1/L2 the other way.")
    log("")

    brain, groups, retina = new_rig(gain=args.gain, bg_hz=args.bg_hz,
                                    mode="photoreceptor")
    probes = {k: groups[k]["idx"] for k in
              ("R1-6", "R7", "R8", "L1", "L2", "L3", "L5", "Mi1", "T4a")}
    dark = np.full((H, W, 3), 0.02, dtype=np.float32)
    light = np.full((H, W, 3), 0.95, dtype=np.float32)

    settle(brain, retina, 1500, dark)
    base = {k: brain.group_rate(i) for k, i in probes.items()}
    on = run(brain, retina, [light] * 12, args.frame_ms, probes)
    off = run(brain, retina, [dark] * 12, args.frame_ms, probes)

    log(f"  {'cell':6s} {'dark':>9s} {'light on':>9s} {'light off':>10s} {'on - dark':>10s}")
    for k in probes:
        log(f"  {k:6s} {base[k]:9.2f} {on[k]:9.2f} {off[k]:10.2f} {on[k] - base[k]:+10.2f}")
    return {"dark": base, "on": on, "off": off}


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--which", default="all",
                    choices=["all", "optomotor", "looming", "flash"])
    ap.add_argument("--frames", type=int, default=44)
    ap.add_argument("--frame-ms", type=float, default=25.0)
    ap.add_argument("--speed", type=float, default=0.06, help="cycles per frame")
    ap.add_argument("--gain", type=float, default=0.10)
    ap.add_argument("--bg-hz", type=float, default=0.0)
    ap.add_argument("--mode", default="lamina",
                    choices=["lamina", "photoreceptor", "both"])
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    res = {}
    if a.which in ("all", "flash"):
        res["flash"] = flash(a)
    if a.which in ("all", "optomotor"):
        res["optomotor"] = optomotor(a)
    if a.which in ("all", "looming"):
        res["looming"] = looming(a)
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=2))
        log(f"\nwrote {a.out}")


if __name__ == "__main__":
    main()
