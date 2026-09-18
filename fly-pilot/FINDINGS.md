# What this actually does, and what it does not

Evidence grades follow the convention used by the other docs at the repo root:
**verified** means measured here and reproducible with a named command, **partial**
means it works with caveats, **unverified** means untested against a running game.

Every number came out of `flypilot/experiments.py`, `flypilot/tuning.py` or
`flypilot/selftest.py`. Nothing was tuned to make a result come out, and the negatives
are reported as negatives.

---

## Corrections to an earlier version of this document

Two claims in the first version were wrong. Both are corrected below, and both were
wrong in the same way: the model was measured with a broken instrument.

**Retracted: "per-neuron time constants do not create a usable delay; Mi1 and Mi9 are
1.6 degrees apart in phase."** That measurement projected the signal onto the stimulus
frequency over a window of 1.4 cycles without removing the mean. The DC component
(mean membrane potential, about -52 mV) leaked into every frequency bin and swamped the
real signal, which is why every cell type returned the same phase and the same
"modulation depth" of about 1.6. With the mean subtracted and an integer number of
cycles, **the delay line works**: see the phase table below.

**Corrected: the tonic drive for graded cells.** The first version set it by sweeping
until cells fired, landing on a flat 4.0 mV per step. A cell's steady offset above rest
is (drive per step) x (tau / dt), so that put Tm9 at **280 mV above a 7 mV threshold**.
At that operating point a cell's rate is set by its own bias and its presynaptic
partners are a rounding error — the connectome was barely participating in its own
simulation. Measured modulation at Mi1 was **0.013 mV** under that scheme against
**0.628 mV** under the corrected one.

---

## The build

| Fact | Value | Grade |
|---|---|---|
| Source | Janelia FlyEM male CNS v1.0, CC-BY, minconf 0.5 | verified |
| Neurons after filtering to `status == Traced` | 165,122 | verified |
| Neurons after compartmentalisation | 168,730 | verified |
| Connections at `--min-weight 2` | 15,270,273 (10.1% of the 151.9M raw rows) | verified |
| Synapses represented | 113,732,120 | verified |
| Inhibitory edges | 38% | verified |
| Speed under visual load | 0.53 ms per 1 ms step — **1.90x real time** on one core | verified |
| Speed idle (silent network) | 0.22 ms per step — 4.5x real time | verified |
| Resident memory | 146 MB | verified |

The C kernel and the numpy reference produce **bit-identical spike trains** over 60
steps (`selftest.py`), so a result can be attributed to the connectome rather than to a
bug in the fast path.

---

## Four things that had to be fixed before anything worked

### 1. The lamina was dead, because inhibition needs something to inhibit

Photoreceptors are histaminergic, so R1-R6 **inhibit** L1 and L2. In a network resting
at 0 Hz that does nothing: L1 sat at 0.00 Hz in light and 0.01 Hz in darkness.

The ON pathway is a double inhibition — R1-R6 ⊣ L1 ⊣ Mi1 → T4, and L1 makes 142,045
inhibitory synapses onto Mi1 — so a model that cannot represent *dis*inhibition cannot
carry a visual signal at all. Real lamina and medulla columnar cells are graded, not
spiking; their resting release is the carrier. 42,115 of them get a working point.
**verified**

### 2. That working point has to be the cell's own threshold, not a number

See the correction above. The drive is now expressed as a fraction of what it takes
that cell to reach threshold — 1.0 leaves it exactly at the point where synaptic input
decides whether it fires, which is the entire purpose of a resting release level. It
ranges from 0.100 mV per step for slow cells to 0.583 for fast ones, and it is uniform
across types, so it can let signals through but cannot invent selectivity. **verified**

### 3. CT1 as one node holds the entire motion system below threshold

CT1 is a single neuron with **201,248 synapses whose arbor covers all 892 columns**.
As one isopotential point neuron it fired at **191.8 Hz** and delivered **−262 mV/ms to
every T4 cell in both eyes at once**.

That is a modelling artifact: an arbor spanning the whole retinotopic map cannot be at
one potential, and CT1's per-column processes are known to act independently.
`compartments.py` splits it (and Am1, an amacrine cell, on the same grounds) into 3,608
per-column compartments. No synapse is created, destroyed or reweighted.

CT1 191.8 → 0.74 Hz, and T4a's net drive **flipped sign**, −0.197 → +0.069 mV/ms.
**verified**

Deliberately *not* split: LC, LPi, LT and Li cells. They also span the field, but they
are genuine wide-field integrators — the LC loom detectors pool the field on purpose.

### 4. Background drive was drowning the signal it was supposed to support

With graded cells sitting at threshold, a 3 mV background kick fires them outright, so
the artificial background was doing most of the spiking. Measured as the ratio of
modulation under a drifting grating to the same measurement under a static one:

| background | L1 | Mi1 | Tm9 | T4a | T4b |
|---|---|---|---|---|---|
| 8 Hz @ 3.0 mV | 1.1x | 1.7x | 1.1x | 1.0x | 1.3x |
| 3 Hz @ 1.5 mV | 2.9x | 5.6x | 4.6x | 2.2x | 2.1x |
| **off** | **92x** | **42x** | **837x** | **1606x** | **1670x** |

It is now off by default. The network is silent with no input, which is correct: it has
no other senses to be spontaneously active from. **verified**

---

## What works

| Result | Measurement | Grade |
|---|---|---|
| Photoreceptors respond to light | R1-R6 11.9 → 58.3 Hz; R7 13.3 → 81.5; R8 12.1 → 85.8 | verified |
| The histamine synapse inverts sign | driving photoreceptors *suppresses* L1 | verified |
| Retinotopy recovered from connectivity | 106,826 cells placed; 1,392/1,394 R1-R6 | verified |
| Eye geometry is plausible | ~152° azimuth x 168° elevation per eye, ~40° binocular overlap | verified |
| Visual signal reaches the motion detectors | T4a/T4b modulate 1.6 mV against a 0.00 mV static floor | verified |
| Motor pools track the stimulus | neck imbalance swings **+1.195 Hz** between drift directions | verified |
| Real-time budget | 30 fps preview, brain holding 1.0x real time with headroom | verified |
| Whole pathway alive under motion | L1 9.3, T4a 1.8, DN 4.6, neck 13.0, proboscis 3.5 Hz | verified |

### The correlator has both of its ingredients

A Hassenstein–Reichardt detector needs its two arms separated in **space** and in
**time**. Both are now measured.

Space, from the connectome (column offset of each input arm relative to its T4 target):

| target | Mi1 (fast) | Mi9 (slow) | Mi4 (slow) |
|---|---|---|---|
| T4a | −0.055, +0.026 | **+0.381, −0.599** | −0.376, +0.553 |
| T4b | +0.027, −0.032 | **−0.408, +0.570** | +0.423, −0.615 |
| T4c | +0.122, +0.099 | **−0.745, −0.578** | — |
| T4d | −0.060, −0.091 | **+0.672, +0.788** | — |

The fast arm sits on the target column; the slow arms are displaced, and displaced
**oppositely** for the a/b pair and for the c/d pair. That is four cardinal directions
written into the wiring, and it is a property of the data, not of this model.

Time, measured (membrane potential, mean-subtracted, exactly 6 stimulus cycles, right
eye, 2.4 Hz drift):

| arm | amplitude | phase relative to Mi1 |
|---|---|---|
| Mi1 (fast) | 0.50 mV | 0° |
| Mi9 (slow) | 0.37 mV | **−96.2°** |
| Mi4 (slow) | 1.00 mV | **−105.0°** |
| Tm9 (slow, feeds T5) | 0.78 mV | **−145.6°** |

Roughly a quarter cycle of lag on the arms the connectome places in the neighbouring
column. **verified**

---

## What still does not work

### A static scene fades to nothing (this is correct)

The retina adapts with a 400 ms time constant, so an unchanging image decays to zero
drive and the network goes quiet — a fly staring at a still picture stops seeing it.
Worth knowing because it makes any benchmark or test on a static scene measure almost
nothing; the benchmark in `sim.py` drives a moving grating for exactly this reason.
**verified**

### Direction selectivity: not established

Horizontal opponency (how much T4a prefers one direction minus how much T4b does), per
eye, over a 1.5 s trial:

| eye | horizontal opponency | vertical control |
|---|---|---|
| left | **+0.066** | +0.015 |
| right | **−0.012** | −0.028 |

The two eyes now come out with **opposite signs**, which is the mirror symmetry the
anatomy demands and which the earlier version did not produce. The left eye's
horizontal signal is about 4x its own vertical control. But the right eye's signal is
*smaller* than its control, which means it is noise, and one eye behaving is not a
result. Single trial, no error bars.

Honest status: the substrate is present, both correlator ingredients are present, and
the output is in the right direction on one side. That is not the same as direction
selectivity, and it should not be described as such until it survives repeated trials
with per-cell statistics on both eyes.

### Looming: not reproduced

Giant-fiber (DNp01) spikes over an identical window: **loom 35, receding 41, static
35**. Unchanged by any of the fixes above. The giant fiber is firing at whatever its
synaptic drive gives it and is not detecting expansion.

### Consequence for the control map

Pitch was to be driven by the vertical motion detectors. Since direction selectivity is
not established, that channel would not mean what it claimed, so **pitch is hard-wired
to zero** in both `motor.py` and `flypilot.cpp`. The remaining channels rest on anatomy
— which nerve a motor neuron leaves through, which neuromere it sits in — not on any
behavioural claim.

---

## Honest summary

A whole-connectome simulation that runs faster than real time, whose early visual
system demonstrably works, whose motion-detection circuitry now has both of the
ingredients it needs, and whose motor pools respond to what the eyes are doing about
four times more strongly than before.

It still does not reproduce direction selectivity or looming detection. It responds to
light and contrast, not to what is in the scene, so **it is not seeing the game the way
a fly would see the world.**

Anyone extending this should start with repeated-trial statistics on the optomotor
test, because that is now the measurement standing between "the ingredients are there"
and an actual result. The second question is whether a spiking point-neuron model of
graded optic-lobe neurons can produce direction selectivity at all — and if the answer
is no, the fix is graded transmission in the optic lobe, not more tuning.
