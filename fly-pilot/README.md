# Fly pilot

A simulation of a real fly's brain, flying a pawn in Fortnite.

The brain is the [Janelia FlyEM male CNS connectome v1.0](https://male-cns.janelia.org/download/)
(CC-BY): **168,730 neurons, 15,270,273 connections, 113,732,120 synapses.** Every
weight is a counted synapse from the electron-microscopy reconstruction, and every
edge takes the sign of the presynaptic cell's predicted transmitter. Nothing is
trained and nothing is fitted to behaviour.

Under a moving stimulus it runs at **1.9x real time on one CPU core** (0.53 ms per 1 ms step); idle it is 4.5x.

> **Read [FINDINGS.md](FINDINGS.md) before believing anything about this.** The early
> visual system works and is measured, and the motion-detection circuitry has both of
> the ingredients it needs. But **direction selectivity is not established and looming
> does not reproduce**, so the fly responds to light and contrast rather than to what is
> in the scene. That document also records two claims an earlier version got wrong.
> This is an experiment.

---

## Where it runs

Inside the game server, not on your desktop. The fly is a participant in the match; it
never touches your keyboard or mouse, and there is no input injection anywhere in this
project.

That also buys a better eye. A compound eye is a bundle of ~892 fixed-direction
sampling tubes per side, so rather than scraping a rendered frame, **each ommatidium
gets its own direction into the world** and the scene is built from actor positions.
The retinotopy is recovered from the connectome itself.

```
  world  ->  per-ommatidium directions  ->  lamina  ->  medulla  ->  ...
                                                                      |
     pawn  <-  leg / neck / wing motor pools  <-  descending neurons  <-
```

| Piece | Where |
|---|---|
| Offline: download, build, validate, export | `fly-pilot/flypilot/*.py` |
| Server module | `Project-Reboot-DLL/Project Reboot/flypilot.{h,cpp}` |
| Launcher toggle | Settings → Experimental → **Fly pilot** |
| Config the DLL reads | `<build>\FortniteGame\Binaries\Win64\flypilot.json` |
| Brain data | `<build>\FortniteGame\Binaries\Win64\Reboot Resources\flybrain.bin` |

---

## Building the brain

Needs Python with `numpy`, `pyarrow`, `pandas`. Downloads ~1.1 GB and takes a few
minutes; the result is a 121 MB blob.

```bash
cd fly-pilot
./fetch.sh body-annotations-male-cns-v1.0-minconf-0.5.feather \
           body-neurotransmitters-male-cns-v1.0.feather \
           connectome-weights-male-cns-v1.0-minconf-0.5.feather

python flypilot/build_brain.py --min-weight 2   # 152M rows -> 15.3M signed edges
python flypilot/atlas.py                        # retinotopy, cell groups, time constants
python flypilot/compartments.py                 # split CT1 and Am1 per column
python flypilot/atlas.py                        # re-run so compartments get retinotopy
python flypilot/export_blob.py                  # -> dist/flybrain.bin
```

The order matters: `compartments.py` needs the retinotopy `atlas.py` produces, and the
compartments it creates then need retinotopy of their own, which is why `atlas.py` runs
twice. Each step prints what it did and is safe to re-run.

Then build the native kernel (optional — there is a numpy fallback, about 20x slower):

```bash
native/build.cmd
```

## Checking it

```bash
cd flypilot
python selftest.py          # 17 checks, incl. C kernel == numpy bit-for-bit
python tuning.py            # where the connectome is actually in the loop
python sim.py --ms 1000     # benchmark
python experiments.py       # the fly vision assays -- these are designed to fail
python preview.py --demo loom     # watch it, controlling nothing
```

`preview.py` is the bench version: same connectome, same scene, prints what the motor
pools are asking for, presses nothing.

## Installing it

1. Copy `dist/flybrain.bin` to `<build>\FortniteGame\Binaries\Win64\Reboot Resources\`.
2. Rebuild `Project Reboot.dll` (the module is already in the project file).
3. Launcher → Settings → Experimental → **Fly pilot**.

The switch writes `enabled` into `flypilot.json` and preserves any other keys, so
hand-tuned values survive a toggle. If the blob is missing the switch says so rather
than silently doing nothing.

---

## Where the fly's body comes from

Reboot spawns no bots — the AI hook in `dllmain.cpp` is commented out — and a second
Fortnite client costs gigabytes of RAM. Neither is needed: a pawn is a server-side
actor. The module spawns one near a player and tries two ways to move it.

1. Spawn an `AIController` and possess the pawn. The engine's character movement then
   does the walking, with gravity, collision and terrain following.
2. If that fails, keep the pawn and drive its transform with `K2_TeleportTo`. Still
   moves and is still visible, but hovers at its spawn height.

It logs which one it got. The whole brain is **146 MB resident**, so the fly costs
roughly a hundredth of what a second game client would.

## The control map

Every channel is a group of cells whose job is known from anatomy — which nerve a motor
neuron leaves through, which neuromere it sits in — not from a behavioural claim.

| Control | Read from | Why |
|---|---|---|
| forward / back | all six leg motor pools; MDN opposes | MDN is the moonwalker neuron |
| strafe | left vs right leg motor imbalance | separate hemi-neuromeres, separate legs |
| yaw | neck motor imbalance, nudged by DNa02 | neck muscles rotate the head |
| jump | DNp01 spike | the giant fiber launches an escape |
| sprint | wing power muscles (DLMn, DVMn) | the fly's go-fast system |
| freeze | DNp09 gates everything else | it drives walking arrest |
| pitch | **hard-wired to zero** | see FINDINGS.md — the vertical motion channel is not trustworthy |
| fire | reported, **not wired to a weapon** | see below |

Rates are read as z-scores against each pool's own slow baseline, so the fly calibrates
itself over the first few seconds instead of needing tuned thresholds.

**Firing is deliberately not connected.** Pulling a trigger server-side means driving
the weapon's fire path, and getting that wrong in a live match is a worse failure than
a fly that cannot shoot. The signal is reported in the stats so it can be watched
first.

---

## Safety

- No keyboard or mouse injection exists in this project.
- Off unless `flypilot.json` says `"enabled": true`.
- The network loads lazily on the first tick, and one failure disables the feature
  rather than retrying every tick.
- It runs on its own thread and never touches a `UObject`; the game thread only writes
  a small float image and reads a handful of floats. A stall costs fly reaction time,
  never a server hitch.
- Missing blob, bad header, out-of-range edge index, no pawn, failed function lookup —
  each one disables and logs.

---

## Tuning

`flypilot.json`, all optional:

| Key | Default | Meaning |
|---|---|---|
| `stepsPerTick` | 20 | ms of brain time per server tick |
| `synGain` | 0.10 | mV delivered by one synapse |
| `gradedBias` | 1.0 | graded cells sit at this fraction of their own firing threshold |
| `bgHz` | 0.0 | background drive. Leave at zero: it drowns the visual signal |
| `prGain` | 26.0 | mV per unit Weber contrast |
| `retinaW` / `retinaH` | 96 / 54 | resolution of the view before the eye samples it |
| `hfov` / `vfov` | 120 / 68 | degrees of the fly's field the view occupies |
| `sensitivity` | 1.0 | gain on the motor read-out |
| `targetPlayerName` | `""` | drive this player instead of spawning a pawn |
| `spawnOwnPawn` | true | give the fly its own pawn (no second client needed) |
| `spawnNearPlayer` | true | put it where you can watch it |
| `moveSpeedUnits` | 420 | speed when driving the transform directly |
| `allowMovement` / `allowLook` / `allowJump` | true | per-channel kill switches |

---

## Attribution

Connectome data: Janelia FlyEM, male CNS v1.0, CC-BY. If this goes anywhere public,
cite them — they did the hard part.
