"""A terminal dashboard for watching the fly fly.

Deliberately a terminal and not a window: the game usually owns the screen, and
a second window would fight it for focus. Half-block characters give two
vertical pixels per cell, which is enough to show what each eye is reporting.
"""
from __future__ import annotations

import os
import shutil

import numpy as np

ESC = "\x1b"
HOME = f"{ESC}[H"
CLEAR = f"{ESC}[2J"
HIDE = f"{ESC}[?25l"
SHOW = f"{ESC}[?25h"
RESET = f"{ESC}[0m"

DIM = f"{ESC}[2m"
BOLD = f"{ESC}[1m"


def enable_ansi():
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        k.GetConsoleMode(h, ctypes.byref(mode))
        k.SetConsoleMode(h, mode.value | 0x0004)   # VIRTUAL_TERMINAL_PROCESSING


def _ramp(v: float) -> tuple[int, int, int]:
    """Blue to cyan to amber to white, for firing rate."""
    v = float(np.clip(v, 0.0, 1.0))
    stops = [(0.0, (8, 10, 24)), (0.28, (26, 84, 140)), (0.55, (64, 186, 196)),
             (0.8, (238, 170, 66)), (1.0, (255, 250, 235))]
    for i in range(len(stops) - 1):
        a, ca = stops[i]
        b, cb = stops[i + 1]
        if v <= b:
            t = 0.0 if b == a else (v - a) / (b - a)
            return tuple(int(ca[j] + (cb[j] - ca[j]) * t) for j in range(3))
    return stops[-1][1]


def image_block(img: np.ndarray, scale: float) -> list[str]:
    """Render a 2D array as half-block rows of true-colour text."""
    h, w = img.shape
    rows = []
    for y in range(0, h - 1, 2):
        out = []
        prev = None
        for x in range(w):
            top = _ramp(img[y, x] / scale)
            bot = _ramp(img[y + 1, x] / scale)
            if (top, bot) != prev:
                out.append(f"{ESC}[38;2;{top[0]};{top[1]};{top[2]}m"
                           f"{ESC}[48;2;{bot[0]};{bot[1]};{bot[2]}m")
                prev = (top, bot)
            out.append("▀")
        out.append(RESET)
        rows.append("".join(out))
    return rows


def bar(v: float, width: int = 18, lo: float = -1.0, hi: float = 1.0) -> str:
    """A centred bar for signed values, a filled bar for unsigned ones."""
    v = float(np.clip(v, lo, hi))
    if lo < 0:
        half = width // 2
        n = int(round(abs(v) / hi * half))
        if v >= 0:
            return DIM + "·" * half + RESET + "█" * n + DIM + "·" * (half - n) + RESET
        return DIM + "·" * (half - n) + RESET + "█" * n + DIM + "·" * half + RESET
    n = int(round(v / hi * width))
    return "█" * n + DIM + "·" * (width - n) + RESET


SPARK = "▁▂▃▄▅▆▇█"


def spark(series, width: int = 48) -> str:
    s = list(series)[-width:]
    if not s:
        return ""
    lo, hi = min(s), max(s)
    rng = (hi - lo) or 1.0
    return "".join(SPARK[int((v - lo) / rng * (len(SPARK) - 1))] for v in s)


class Hud:
    def __init__(self):
        enable_ansi()
        print(CLEAR + HIDE, end="")
        self.history = []
        self.width = shutil.get_terminal_size((100, 30)).columns

    def close(self):
        print(SHOW + RESET)

    def draw(self, brain, retina, cmd, stats):
        self.history.append(brain.mean_rate())
        if len(self.history) > 200:
            self.history.pop(0)

        left = retina.eye_image(brain.rate, side=0, grid=32)
        right = retina.eye_image(brain.rate, side=1, grid=32)
        scale = max(2.0, float(np.percentile(np.concatenate([left.ravel(), right.ravel()]), 99)))
        lrows, rrows = image_block(left, scale), image_block(right, scale)

        z = cmd.z
        gauges = [
            ("forward   W", cmd.forward, 0.0),
            ("back      S", cmd.backward, 0.0),
            ("strafe  A/D", cmd.strafe, -1.0),
            ("yaw   mouse", cmd.yaw, -1.0),
            ("pitch mouse", cmd.pitch, -1.0),
            ("sprint  sft", cmd.sprint, 0.0),
            ("fire    LMB", cmd.fire, 0.0),
            ("freeze DNp09", cmd.freeze, 0.0),
        ]

        L = []
        L.append(f"{BOLD}  male CNS connectome  {RESET}{DIM}"
                 f"{brain.n:,} neurons   {len(brain.indices):,} connections   "
                 f"{brain.meta['synapses']:,.0f} synapses{RESET}")
        L.append("")
        L.append(f"  {DIM}left eye{RESET}                          "
                 f"{DIM}right eye{RESET}             {DIM}effector channels{RESET}")

        for i in range(max(len(lrows), len(rrows))):
            a = lrows[i] if i < len(lrows) else " " * 32
            b = rrows[i] if i < len(rrows) else " " * 32
            g = ""
            if i < len(gauges):
                name, val, lo = gauges[i]
                g = f"  {name:>11s} {bar(val, 18, lo, 1.0)}"
            L.append(f"  {a}  {b}{g}")

        L.append("")
        def lamp(on, text):
            return f"{BOLD}{text.upper()}{RESET}" if on else f"{DIM}{text}{RESET}"
        dz = stats.get("deadzone", 0.22)
        drive = " ".join([
            lamp(cmd.forward > dz, "fwd"), lamp(cmd.backward > dz, "back"),
            lamp(cmd.strafe < -dz, "left"), lamp(cmd.strafe > dz, "right"),
            lamp(cmd.sprint > dz, "sprint"), lamp(cmd.jump, "jump"),
            lamp(cmd.fire > dz, "fire")])
        L.append(f"  drive  {drive}      yaw {cmd.yaw:+.2f}"
                 f"   giant-fiber spikes {stats.get('gf', 0)}")
        L.append("")
        L.append(f"  {DIM}population rate{RESET} {spark(self.history)} "
                 f"{brain.mean_rate():.2f} Hz   {brain.n_fired:,} spikes/ms")
        L.append(f"  {DIM}DN {z.get('DN_all', 0):+.2f}   legs L{z.get('leg_L', 0):+.2f} "
                 f"R{z.get('leg_R', 0):+.2f}   neck L{z.get('neck_L', 0):+.2f} "
                 f"R{z.get('neck_R', 0):+.2f}   proboscis {z.get('proboscis', 0):+.2f}   "
                 f"MDN {z.get('MDN', 0):+.2f}{RESET}")
        L.append("")
        L.append(f"  {ESC}[100;97m preview only {RESET}  {DIM}nothing is being controlled; "
                 f"the server-side module is what drives a pawn{RESET}")
        L.append(f"  {DIM}{stats.get('mode', '')}{RESET}")
        L.append(f"  {DIM}brain {stats.get('brain_ms', 0):.1f} ms/frame "
                 f"({stats.get('steps', 0)} steps)   capture {stats.get('cap_ms', 0):.1f} ms   "
                 f"{stats.get('fps', 0):.1f} fps   {stats.get('ratio', 0):.2f}x real time{RESET}")
        L.append(f"  {DIM}target: {stats.get('target', '')}{RESET}")
        L.append(f"  {DIM}ctrl-c to stop{RESET}")

        pad = f"{ESC}[K"
        print(HOME + "\n".join(line + pad for line in L) + f"{ESC}[J", end="", flush=True)
