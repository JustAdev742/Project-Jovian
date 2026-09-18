"""Grab what is on screen, either a named window or a whole monitor."""
from __future__ import annotations

import ctypes
from ctypes import wintypes

import mss
import numpy as np

user32 = ctypes.WinDLL("user32", use_last_error=True)


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


def find_window(substring: str):
    """First visible top-level window whose title contains `substring`."""
    match = []
    sub = substring.lower()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if sub in buf.value.lower():
                match.append((hwnd, buf.value))
                return False
        return True

    user32.EnumWindows(cb, 0)
    return match[0] if match else (None, None)


def window_rect(hwnd) -> dict | None:
    r = RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(r)):
        return None
    pt = wintypes.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    w, h = r.right - r.left, r.bottom - r.top
    if w < 16 or h < 16:
        return None
    return {"left": pt.x, "top": pt.y, "width": w, "height": h}


class Screen:
    def __init__(self, window: str | None = None, monitor: int = 1):
        self.sct = mss.mss()
        self.window = window
        self.hwnd = None
        self.title = None
        self.monitor_index = monitor
        self.region = None
        self.refresh()

    def refresh(self) -> bool:
        """Re-resolve the capture region. Returns True if a window was found."""
        if self.window:
            hwnd, title = find_window(self.window)
            if hwnd:
                rect = window_rect(hwnd)
                if rect:
                    self.hwnd, self.title, self.region = hwnd, title, rect
                    return True
        mons = self.sct.monitors
        i = min(self.monitor_index, len(mons) - 1)
        self.region = mons[i]
        self.hwnd, self.title = None, f"monitor {i}"
        return False

    def grab(self) -> np.ndarray:
        """BGRA frame as HxWx4 uint8."""
        shot = self.sct.grab(self.region)
        return np.frombuffer(shot.raw, dtype=np.uint8).reshape(
            shot.height, shot.width, 4)

    def describe(self) -> str:
        r = self.region
        return (f"{self.title}  {r['width']}x{r['height']} "
                f"at ({r['left']},{r['top']})")
