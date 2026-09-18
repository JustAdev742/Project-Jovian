"""Read the brain's own output channels and turn them into game commands.

Every control below is taken from a group of cells whose job is already known
from the anatomy, not from anything fitted. Left and right leg motor neurons
sit in separate hemi-neuromeres and drive separate legs, so their imbalance is
a turn. Neck motor neurons leave through the cervical nerve and rotate the
head, so their imbalance is a gaze shift. The giant fiber is one cell per side
whose spike launches an escape.

Rates are read as z-scores against each group's own slow running baseline. That
matters: absolute rates in a model like this are not meaningful, but a group
firing well above its own resting level is. It also means the fly calibrates
itself during the first few seconds instead of needing tuned thresholds.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Command:
    forward: float = 0.0
    backward: float = 0.0
    strafe: float = 0.0       # -1 left .. +1 right
    yaw: float = 0.0          # -1 look left .. +1 look right
    pitch: float = 0.0        # -1 look down .. +1 look up
    sprint: float = 0.0
    fire: float = 0.0
    jump: bool = False
    freeze: float = 0.0
    z: dict = field(default_factory=dict)


class Baseline:
    """Running mean and spread for one group's firing rate."""

    def __init__(self, tau_ms: float, dt: float):
        self.a = float(1.0 - np.exp(-dt / tau_ms))
        self.mean = None
        self.var = 1.0

    def update(self, x: float) -> float:
        if self.mean is None:
            self.mean = x
            return 0.0
        d = x - self.mean
        self.mean += self.a * d
        self.var += self.a * (d * d - self.var)
        return d / (np.sqrt(self.var) + 1e-3)


def _spiked(fired_idx: np.ndarray, idx: np.ndarray) -> bool:
    """Did any neuron in idx fire this step? fired_idx is sorted ascending."""
    if fired_idx.size == 0 or idx.size == 0:
        return False
    pos = np.searchsorted(fired_idx, idx)
    pos = np.clip(pos, 0, fired_idx.size - 1)
    return bool((fired_idx[pos] == idx).any())


class MotorDecoder:
    # groups that get a running baseline, and the time constant to use
    TRACKED = ("leg_L", "leg_R", "leg_all", "neck_L", "neck_R", "wing_power",
               "proboscis", "MDN", "DNp09", "DNa02_L", "DNa02_R",
               "T4c", "T5c", "T4d", "T5d", "DN_all")

    def __init__(self, groups: dict, dt: float = 1.0, baseline_ms: float = 4000.0,
                 smooth_ms: float = 90.0, sensitivity: float = 1.0):
        self.g = {k: groups[k]["idx"] for k in self.TRACKED if k in groups}
        self.gf = groups["DNp01"]["idx"]
        self.base = {k: Baseline(baseline_ms, dt) for k in self.g}
        self.smooth = float(1.0 - np.exp(-dt / smooth_ms))
        self.sens = float(sensitivity)
        self.cmd = Command()
        self._s = {k: 0.0 for k in self.g}
        self.gf_spikes = 0
        self.warmup = int(1500 / dt)
        self.t = 0

    # ------------------------------------------------------------------
    def update(self, brain, fired_idx: np.ndarray) -> Command:
        self.t += 1
        z = {}
        for k, idx in self.g.items():
            zz = self.base[k].update(brain.group_rate(idx))
            self._s[k] += (zz - self._s[k]) * self.smooth
            z[k] = self._s[k]

        gf = _spiked(fired_idx, self.gf)
        self.gf_spikes += int(gf)

        c = Command(z=z)
        if self.t < self.warmup:
            # the baselines are still settling; hold still rather than twitch
            return c

        s = self.sens
        squash = lambda v: float(np.tanh(v * 0.55 * s))

        # freezing gates everything else, which is what DNp09 does in the animal
        c.freeze = max(0.0, squash(z.get("DNp09", 0.0)))
        gate = 1.0 - min(1.0, c.freeze)

        walk = squash(z.get("leg_all", 0.0))
        c.forward = max(0.0, walk) * gate
        c.backward = max(0.0, squash(z.get("MDN", 0.0))) * gate

        turn = squash(z.get("leg_R", 0.0) - z.get("leg_L", 0.0))
        c.strafe = turn * gate

        # gaze: neck motor imbalance, nudged by the steering descending neurons
        neck = z.get("neck_R", 0.0) - z.get("neck_L", 0.0)
        dna = z.get("DNa02_R", 0.0) - z.get("DNa02_L", 0.0)
        c.yaw = squash(neck + 0.5 * dna) * gate

        # pitch from vertical optic flow: the upward and downward tuned motion
        # detectors, exactly the signal a fly uses to hold its attitude
        up = z.get("T4c", 0.0) + z.get("T5c", 0.0)
        dn = z.get("T4d", 0.0) + z.get("T5d", 0.0)
        c.pitch = squash(0.5 * (up - dn)) * gate

        c.sprint = max(0.0, squash(z.get("wing_power", 0.0))) * gate
        c.fire = max(0.0, squash(z.get("proboscis", 0.0))) * gate
        c.jump = gf
        self.cmd = c
        return c
