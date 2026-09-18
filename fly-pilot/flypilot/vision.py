"""Turn a screenshot into drive on the visual system.

Every cell in the optic lobe has a direction in the world, worked out in
atlas.py. A monitor occupies a rectangle of that sphere, so the mapping is
direct: project a cell's direction into the frame and read the pixel it looks
at. Cells pointing away from the monitor see the room, which for a fly means
near darkness.

Where to inject
---------------
The obvious answer is the photoreceptors, and that is what `--retina
photoreceptor` does. It has a problem: the male CNS reconstruction contains
about 1,400 of the roughly 9,600 outer photoreceptors, under one per column, so
half the columns looking at the monitor receive no light at all. That is fatal
for motion vision specifically, because an elementary motion detector compares
*neighbouring* columns, and a half-empty retina rarely gives it two lit
neighbours.

So the default injects into the lamina monopolar cells instead. There is one
L1, one L2 and one L3 per column, giving complete coverage, and they are the
direct and only targets of R1-R6. The drive is inverted, because the
photoreceptor synapse onto them is histaminergic and sign inverting: light
hyperpolarises L1 and L2 in a real fly. This substitutes for the unreconstructed
retina while preserving the sign the missing synapse would have imposed.

R7 and R8 are reconstructed well enough to drive directly, and they carry
colour: R7 is the short wavelength and UV receptor, R8 the long wavelength one,
so they read the blue and green planes.
"""
from __future__ import annotations

import numpy as np

# (group, colour plane, sign, gain scale)
MODES = {
    "photoreceptor": [("R1-6", "lum", +1.0, 1.0),
                      ("R7", "blue", +1.0, 1.0),
                      ("R8", "green", +1.0, 1.0)],
    "lamina": [("L1", "lum", -1.0, 1.0),
               ("L2", "lum", -1.0, 1.0),
               ("L3", "lum", -1.0, 0.7),
               ("R7", "blue", +1.0, 0.8),
               ("R8", "green", +1.0, 0.8)],
    "both": [("R1-6", "lum", +1.0, 1.0),
             ("L1", "lum", -1.0, 0.6),
             ("L2", "lum", -1.0, 0.6),
             ("L3", "lum", -1.0, 0.4),
             ("R7", "blue", +1.0, 1.0),
             ("R8", "green", +1.0, 1.0)],
}

LUMA = np.array([0.30, 0.59, 0.11], dtype=np.float32)


class Retina:
    def __init__(
        self,
        groups: dict,
        atlas: dict,
        n_neurons: int,
        mode: str = "lamina",
        hfov: float = 120.0,      # degrees of azimuth the monitor subtends
        vfov: float = 68.0,       # degrees of elevation
        pr_gain: float = 26.0,    # mV per unit Weber contrast
        pr_tonic: float = 4.2,    # standing drive for photoreceptors, mV
        adapt_ms: float = 400.0,  # light adaptation time constant
        dt: float = 1.0,
        dark: float = 0.04,       # what an ommatidium sees when it faces the room
        graded: np.ndarray | None = None,
        graded_bias: float = 1.0,   # global scale on the per-type tonic drive
    ):
        if mode not in MODES:
            raise ValueError(f"retina mode must be one of {list(MODES)}")
        self.n = n_neurons
        self.mode = mode
        self.hfov, self.vfov = float(hfov), float(vfov)
        self.pr_gain, self.pr_tonic, self.dark = pr_gain, pr_tonic, dark
        self.adapt_alpha = float(1.0 - np.exp(-dt / adapt_ms))

        az, el = atlas["azimuth"], atlas["elevation"]
        self.channels = {}
        for name, plane, sign, scale in MODES[mode]:
            idx = groups[name]["idx"]
            idx = idx[~np.isnan(az[idx])]
            a, e = az[idx].astype(np.float32), el[idx].astype(np.float32)
            u = (a + hfov / 2.0) / hfov           # position within the monitor
            v = (vfov / 2.0 - e) / vfov           # elevation up is row zero
            on = (u >= 0) & (u < 1) & (v >= 0) & (v < 1)
            self.channels[name] = {
                "idx": idx, "u": u, "v": v, "on": on, "plane": plane,
                "sign": sign, "scale": scale,
                "tonic": pr_tonic if name.startswith("R") else 0.0,
                "adapted": np.full(len(idx), dark, dtype=np.float32),
                "pix": None,
            }
        self.display = MODES[mode][0][0]

        self.bias = np.zeros(self.n, dtype=np.float32)
        if graded is not None:
            self.bias = graded.astype(np.float32) * graded_bias
        self.inject = self.bias.copy()
        self._shape = None
        self.side = atlas["side"]

    # ------------------------------------------------------------------
    @property
    def n_seeing(self) -> int:
        return int(sum(c["on"].sum() for c in self.channels.values()))

    def summary(self) -> str:
        parts = [f"{k} {int(c['on'].sum())}/{len(c['idx'])}"
                 for k, c in self.channels.items()]
        return f"injecting at the {self.mode}; cells facing the monitor: " + ", ".join(parts)

    def columns_lit(self, atlas_hex1, atlas_hex2) -> int:
        """How many distinct eye columns actually receive drive."""
        seen = set()
        for c in self.channels.values():
            idx = c["idx"][c["on"]]
            ok = ~np.isnan(atlas_hex1[idx])
            seen.update(zip(np.round(atlas_hex1[idx][ok]).astype(int),
                            np.round(atlas_hex2[idx][ok]).astype(int),
                            self.side[idx][ok]))
        return len(seen)

    def _bind(self, shape):
        h, w = shape[:2]
        for c in self.channels.values():
            col = np.clip((c["u"] * w).astype(np.int32), 0, w - 1)
            row = np.clip((c["v"] * h).astype(np.int32), 0, h - 1)
            c["pix"] = row * w + col
        self._shape = (h, w)

    # ------------------------------------------------------------------
    def encode(self, frame: np.ndarray) -> np.ndarray:
        """`frame` is HxWx3 float32 in 0..1 (RGB). Returns per-neuron mV."""
        if self._shape != frame.shape[:2]:
            self._bind(frame.shape)

        flat = frame.reshape(-1, 3)
        lum = None
        self.inject[:] = self.bias
        for c in self.channels.values():
            if c["plane"] == "lum":
                if lum is None:
                    lum = flat @ LUMA
                sampled = lum[c["pix"]]
            elif c["plane"] == "blue":
                sampled = flat[c["pix"], 2]
            else:
                sampled = flat[c["pix"], 1]

            sampled = np.where(c["on"], sampled, self.dark).astype(np.float32)
            a = c["adapted"]
            a += (sampled - a) * self.adapt_alpha
            # Weber contrast against the adapted level: a fly photoreceptor
            # reports change, not absolute brightness.
            contrast = (sampled - a) / (a + 0.15)
            self.inject[c["idx"]] += (c["tonic"]
                                      + c["sign"] * c["scale"] * self.pr_gain * contrast)
        return self.inject

    # ------------------------------------------------------------------
    def eye_image(self, rate: np.ndarray, side: int, grid: int = 48) -> np.ndarray:
        """Render what one eye is reporting, as a coarse image for the HUD."""
        c = self.channels[self.display]
        idx = c["idx"]
        m = self.side[idx] == side
        if not m.any():
            return np.zeros((grid, grid), dtype=np.float32)
        u = np.clip((c["u"][m] * grid).astype(int), 0, grid - 1)
        v = np.clip((c["v"][m] * grid).astype(int), 0, grid - 1)
        img = np.zeros(grid * grid, dtype=np.float32)
        cnt = np.zeros(grid * grid, dtype=np.float32)
        flat = v * grid + u
        np.add.at(img, flat, rate[idx[m]])
        np.add.at(cnt, flat, 1.0)
        return (img / np.maximum(cnt, 1)).reshape(grid, grid)


def downsample(bgra: np.ndarray, target_w: int = 320) -> np.ndarray:
    """BGRA screenshot -> small RGB float frame, cheaply.

    The eye samples the world at about five degrees, so there is nothing to be
    gained from feeding it a full resolution frame; a stride is both faster and
    closer to what the optics already do.
    """
    h, w = bgra.shape[:2]
    step = max(1, w // target_w)
    small = bgra[::step, ::step, :3].astype(np.float32)
    return small[:, :, ::-1] * (1.0 / 255.0)      # BGR -> RGB
