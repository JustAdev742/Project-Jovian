"""Watch the brain run, without it controlling anything.

This is the bench version. It loads the same connectome the server module
loads, shows it the same kind of scene, and prints what the motor pools are
asking for -- but it presses nothing and moves nothing. The thing that actually
flies a pawn is flypilot.cpp inside the game server.

    python preview.py --demo grating       a drifting grating
    python preview.py --demo loom          an expanding dark disc
    python preview.py --window Fortnite    whatever that window is showing

The window mode is read-only screen capture, for eyeballing how a real scene
lands on the retina. It still controls nothing.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hud import Hud                                  # noqa: E402
from motor import MotorDecoder                       # noqa: E402
from sim import FlyBrain, load_atlas, load_groups    # noqa: E402
from vision import Retina, downsample                # noqa: E402


def synthetic(t: float, w: int = 320, h: int = 180, mode: str = "grating") -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if mode == "grating":
        g = 0.5 + 0.45 * np.sin((xx / w * 6.0 - t * 2.4) * 2 * np.pi)
    elif mode == "loom":
        # an object closing in, then starting over
        phase = (t % 3.0) / 3.0
        g = np.where(np.hypot(xx - w / 2, yy - h / 2) < (6 + 100 * phase * phase),
                     0.05, 0.8).astype(np.float32)
    else:
        g = np.full((h, w), 0.4, dtype=np.float32)
    return np.repeat(g[:, :, None], 3, axis=2)


def main():
    ap = argparse.ArgumentParser(description="watch a fly brain, read only")
    ap.add_argument("--demo", choices=["grating", "loom", "grey"], default="grating")
    ap.add_argument("--window", default="", help="capture this window instead of the demo")
    ap.add_argument("--monitor", type=int, default=1)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--dt", type=float, default=1.0)
    ap.add_argument("--gain", type=float, default=0.10)
    ap.add_argument("--bg-hz", type=float, default=0.0)
    ap.add_argument("--retina", default="lamina",
                    choices=["lamina", "photoreceptor", "both"])
    ap.add_argument("--hfov", type=float, default=120.0)
    ap.add_argument("--vfov", type=float, default=68.0)
    ap.add_argument("--graded-bias", type=float, default=1.0)
    ap.add_argument("--sensitivity", type=float, default=1.0)
    ap.add_argument("--deadzone", type=float, default=0.22)
    ap.add_argument("--seconds", type=float, default=0.0)
    ap.add_argument("--no-hud", action="store_true")
    a = ap.parse_args()

    print("loading the connectome ...", flush=True)
    brain = FlyBrain(dt=a.dt, syn_gain=a.gain, bg_hz=a.bg_hz)
    groups, atlas = load_groups(), load_atlas()
    retina = Retina(groups, atlas, brain.n, mode=a.retina, hfov=a.hfov, vfov=a.vfov,
                    dt=a.dt, graded=brain.graded, graded_bias=a.graded_bias)
    decoder = MotorDecoder(groups, dt=a.dt, sensitivity=a.sensitivity)
    print(f"  {brain.n:,} neurons, {len(brain.indices):,} connections, "
          f"{brain.meta['synapses']:,.0f} synapses")
    print(f"  {retina.summary()}")

    screen = None
    if a.window:
        from capture import Screen
        screen = Screen(window=a.window, monitor=a.monitor)
        print(f"  capturing {screen.describe()}")
    time.sleep(0.8)

    steps_per_frame = max(1, int(round((1000.0 / a.fps) / a.dt)))
    period = 1.0 / a.fps
    hud = None if a.no_hud else Hud()
    t_start = time.perf_counter()
    frames, fps_ema = 0, a.fps
    cmd = decoder.cmd

    try:
        while True:
            t_frame = time.perf_counter()

            t0 = time.perf_counter()
            if screen is not None:
                if frames % 60 == 0:
                    screen.refresh()
                frame = downsample(screen.grab())
            else:
                frame = synthetic(t_frame - t_start, mode=a.demo)
            inject = retina.encode(frame)
            cap_ms = (time.perf_counter() - t0) * 1000.0

            t0 = time.perf_counter()
            for _ in range(steps_per_frame):
                fired = brain.step(inject)
                cmd = decoder.update(brain, fired)
            brain_ms = (time.perf_counter() - t0) * 1000.0

            frames += 1
            dtf = time.perf_counter() - t_frame
            fps_ema += (1.0 / max(dtf, 1e-4) - fps_ema) * 0.1
            if hud:
                hud.draw(brain, retina, cmd, {
                    "fps": fps_ema, "cap_ms": cap_ms, "brain_ms": brain_ms,
                    "steps": steps_per_frame, "deadzone": a.deadzone,
                    "ratio": (steps_per_frame * a.dt) / max(brain_ms, 1e-6),
                    "gf": decoder.gf_spikes,
                    "mode": f"stimulus: {a.window or a.demo}",
                    "target": screen.describe() if screen else "synthetic stimulus",
                })

            if a.seconds and (time.perf_counter() - t_start) > a.seconds:
                break
            slack = period - (time.perf_counter() - t_frame)
            if slack > 0:
                time.sleep(slack)
    except KeyboardInterrupt:
        pass
    finally:
        if hud:
            hud.close()
        el = time.perf_counter() - t_start
        print(f"\n{frames} frames in {el:.1f}s ({frames / max(el, 1e-6):.1f} fps), "
              f"{brain.steps:,} steps = {brain.steps * a.dt / 1000:.1f}s of brain time")


if __name__ == "__main__":
    main()
