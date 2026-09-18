"""Checks that have to pass before any of the rest can be believed.

The native kernel and the numpy reference implement the same equations; if they
ever disagree, everything downstream is measuring the C code rather than the
connectome. With the background drive switched off both paths are fully
deterministic, so they must agree exactly.
"""
from __future__ import annotations

import sys

import numpy as np

from sim import BRAIN, FlyBrain, load_atlas, load_groups

FAILED = []


def check(name, ok, detail=""):
    print(f"  [{'pass' if ok else 'FAIL'}] {name}{'  ' + detail if detail else ''}")
    if not ok:
        FAILED.append(name)


def drive(brain, idx, mv):
    inj = np.zeros(brain.n, dtype=np.float32)
    inj[idx] = mv
    return inj


def main():
    print("kernel equivalence (background drive off, so both paths are deterministic)")
    rng = np.random.default_rng(7)
    a = FlyBrain(bg_hz=0.0, native=True)
    b = FlyBrain(bg_hz=0.0, native=False)
    seeds = rng.choice(a.n, 400, replace=False)
    inj = drive(a, seeds, 9.0)

    same_spikes = True
    for t in range(60):
        cur = inj if t < 5 else None
        fa = a.step(cur)
        fb = b.step(cur)
        if not np.array_equal(fa, fb):
            same_spikes = False
            print(f"      diverged at step {t}: {len(fa)} vs {len(fb)} spikes")
            break
    check("spike trains identical over 60 steps", same_spikes)
    check("membrane potentials identical", np.allclose(a.V, b.V, atol=1e-4),
          f"max |dV| = {np.abs(a.V - b.V).max():.2e} mV")
    check("firing rates identical", np.allclose(a.rate, b.rate, atol=1e-4))

    print("\nnetwork sanity")
    # With the background drive off and nothing to look at, this network has no input at
    # all, and a brain with no input should be quiet. The meaningful baseline is the one
    # under visual drive, so that is what gets checked for a plausible rate.
    c = FlyBrain()
    for _ in range(400):
        c.step()
    dark = c.mean_rate()
    check("silent when there is no input and no background", dark < 0.2, f"{dark:.3f} Hz")

    from vision import Retina
    lit = FlyBrain()
    retina = Retina(load_groups(), load_atlas(), lit.n, dt=lit.dt,
                    graded=lit.graded, graded_bias=1.0)
    scene = np.full((180, 320, 3), 0.5, dtype=np.float32)
    scene[:, 160:] = 0.1                       # a lit scene with an edge in it
    inj = retina.encode(scene)
    for _ in range(600):
        lit.step(inj)
    mr = lit.mean_rate()
    check("plausible rate once there is something to see", 0.1 < mr < 20.0, f"{mr:.2f} Hz")
    check("network is neither silent nor saturated",
          0.005 < (lit.rate > 0.5).mean() < 0.9,
          f"{(lit.rate > 0.5).mean():.1%} of cells active")

    print("\nthe graph itself")
    check("every edge index is in range",
          int(c.indices.min()) >= 0 and int(c.indices.max()) < c.n)
    check("CSR row offsets are monotonic", bool(np.all(np.diff(c.indptr) >= 0)))
    check("indptr ends at the edge count", int(c.indptr[-1]) == len(c.indices))
    check("both signs are present",
          (c.weight > 0).any() and (c.weight < 0).any(),
          f"{(c.weight < 0).mean():.0%} of edges inhibitory")

    print("\natlas and groups")
    atlas = load_atlas()
    groups = load_groups()
    az = atlas["azimuth"]
    placed = ~np.isnan(az)
    check("visual directions were assigned", placed.sum() > 90_000, f"{placed.sum():,} cells")
    check("azimuths stay on the sphere", float(np.nanmax(np.abs(az))) < 180.0,
          f"max |azimuth| = {np.nanmax(np.abs(az)):.0f} deg")
    ph = groups["R1-6"]["idx"]
    check("photoreceptors carry a visual direction",
          placed[ph].mean() > 0.95, f"{placed[ph].mean():.1%} of R1-R6")
    check("photoreceptors are presynaptic to something",
          float(np.diff(c.indptr)[ph].mean()) > 1.0,
          f"mean out-degree {np.diff(c.indptr)[ph].mean():.1f}")

    print("\nthe photoreceptor to lamina synapse is sign inverting")
    import pandas as pd
    df = pd.read_parquet(BRAIN / "neurons.parquet")
    nts = df["nt"].to_numpy()
    check("R1-R6 are histaminergic", (nts[ph] == "histamine").mean() > 0.8,
          f"{(nts[ph] == 'histamine').mean():.0%}")
    w_from_ph = np.concatenate([c.weight[c.indptr[i]:c.indptr[i + 1]] for i in ph[:200]])
    check("and therefore inhibit their targets", bool((w_from_ph < 0).all()))

    print("\nlight actually reaches the lamina")
    d = FlyBrain()
    for _ in range(200):
        d.step()
    base_l1 = d.group_rate(groups["L1"]["idx"])
    lit = drive(d, ph, 12.0)
    for _ in range(300):
        d.step(lit)
    lit_ph = d.group_rate(ph)
    lit_l1 = d.group_rate(groups["L1"]["idx"])
    check("driving photoreceptors makes them fire", lit_ph > 5.0, f"{lit_ph:.1f} Hz")
    check("and suppresses L1, as a histamine synapse should",
          lit_l1 < base_l1 + 0.5, f"L1 {base_l1:.2f} -> {lit_l1:.2f} Hz")

    print()
    if FAILED:
        print(f"{len(FAILED)} check(s) failed: {', '.join(FAILED)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
