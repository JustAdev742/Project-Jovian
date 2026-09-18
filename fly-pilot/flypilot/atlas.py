"""Build the sensory and motor interface to the male-CNS connectome.

Two problems are solved here.

1. Retinotopy. Only 23,720 optic-lobe cells carry an `assignedOlHex` column
   coordinate; the photoreceptors and the T4/T5 motion detectors do not. We
   propagate the hex labels through the connectome itself: an unlabelled
   optic-lobe cell inherits the synapse-weighted mean column of its labelled
   partners on the same side. A few rounds cover the optic lobes.

2. Effectors. Motor neurons are grouped by the nerve they leave through and the
   neuromere they sit in, which is what determines the muscle they drive. That
   is anatomy rather than inference, so the mapping from neuron group to game
   control rests on the annotation, not on a contested behavioural claim.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
BRAIN = ROOT / "brain"

INTEROMMATIDIAL_DEG = 5.1   # mean sampling angle of the Drosophila eye
EYE_CENTRE_AZIMUTH = 55.0   # each eye's optical axis, degrees from straight ahead
OL_SUPERCLASSES = ("ol_intrinsic", "ol_sensory", "visual_projection", "visual_centrifugal")


def log(m):
    print(f"[atlas] {m}", flush=True)


# --------------------------------------------------------------------------
# graph helpers
# --------------------------------------------------------------------------
def load_graph():
    indptr = np.load(BRAIN / "csr_indptr.npy")
    indices = np.load(BRAIN / "csr_indices.npy")
    w = np.load(BRAIN / "csr_weight_raw.npy")
    n = len(indptr) - 1
    pre = np.repeat(np.arange(n, dtype=np.int32), np.diff(indptr))
    return n, pre, indices, w


# --------------------------------------------------------------------------
# 1. retinotopy
# --------------------------------------------------------------------------

def resolve_side(df):
    """Left/right for every cell.

    Photoreceptor somata sit in the retina, which was not imaged, so R1-R6 and
    R7/R8 have no somaSide at all. They do carry rootSide and an instance name
    ending in _L or _R, which is where their axons terminate -- exactly the
    side we need.
    """
    n = len(df)
    side = np.full(n, -1, dtype=np.int8)
    for col in ("rootSide", "somaSide"):
        v = df[col].fillna("").to_numpy()
        side[(side < 0) & (v == "L")] = 0
        side[(side < 0) & (v == "R")] = 1
    inst = df["instance"].fillna("").to_numpy()
    side[(side < 0) & np.char.endswith(inst.astype(str), "_L")] = 0
    side[(side < 0) & np.char.endswith(inst.astype(str), "_R")] = 1
    return side


def propagate_hex(df, pre, post, w, rounds=6):
    n = len(df)
    h1 = df["assignedOlHex1"].to_numpy(dtype=np.float64).copy()
    h2 = df["assignedOlHex2"].to_numpy(dtype=np.float64).copy()
    known = ~np.isnan(h1)
    log(f"seed columns: {known.sum():,} cells carry an assigned hex")

    side = resolve_side(df)

    is_ol = df["superclass"].isin(OL_SUPERCLASSES).to_numpy()
    target = is_ol & ~known & (side >= 0)
    log(f"unlabelled optic-lobe cells to fill: {target.sum():,}")

    # undirected partner list: a column label flows along synapses either way
    src = np.concatenate([pre, post])
    dst = np.concatenate([post, pre])
    ww = np.concatenate([w, w]).astype(np.float64)
    same_side = (side[src] == side[dst]) & (side[src] >= 0)
    src, dst, ww = src[same_side], dst[same_side], ww[same_side]
    log(f"{len(src):,} same-side directed partner links available for propagation")

    for r in range(rounds):
        lab = ~np.isnan(h1)
        m = lab[src] & target[dst] & ~lab[dst]
        if not m.any():
            log(f"round {r + 1}: converged")
            break
        s, d, v = src[m], dst[m], ww[m]
        acc1 = np.bincount(d, weights=v * h1[s], minlength=n)
        acc2 = np.bincount(d, weights=v * h2[s], minlength=n)
        tot = np.bincount(d, weights=v, minlength=n)
        got = tot > 0
        h1[got] = acc1[got] / tot[got]
        h2[got] = acc2[got] / tot[got]
        log(f"round {r + 1}: +{int(got.sum()):,} cells "
            f"({int((~np.isnan(h1) & is_ol).sum()):,} of {int(is_ol.sum()):,} OL cells placed)")

    return h1, h2, side


def eye_geometry(df, h1, h2, side):
    """Place every hex column on the sphere of visual directions.

    The lattice is regular, so only its orientation is unknown. We recover that
    by regressing the lattice against medulla soma positions, which are
    retinotopically ordered: soma_y runs dorsoventrally and soma_x runs
    medio-laterally, mirrored between the two optic lobes.
    """
    u = h1 - 0.5 * h2
    v = (np.sqrt(3.0) / 2.0) * h2

    az = np.full(len(df), np.nan)
    el = np.full(len(df), np.nan)
    fits = {}

    log("lattice footprint: "
        f"{np.nanmax(u) - np.nanmin(u):.0f} x {np.nanmax(v) - np.nanmin(v):.0f} columns")
    mi1 = (df["type"] == "Mi1").to_numpy() & df["soma_x"].notna().to_numpy() & ~np.isnan(h1)
    for s, name in ((0, "L"), (1, "R")):
        sel = mi1 & (side == s)
        if sel.sum() < 50:
            raise SystemExit(f"not enough Mi1 somata on side {name}")
        U = np.c_[u[sel], v[sel]]
        centre = U.mean(0)
        U = U - centre
        elev_proxy = -df["soma_y"].to_numpy()[sel]                             # dorsal is up
        azim_proxy = df["soma_x"].to_numpy()[sel] * (1.0 if s == 0 else -1.0)  # lateral is outward
        Y = np.c_[azim_proxy, elev_proxy]
        Y = (Y - Y.mean(0)) / Y.std(0)
        A, *_ = np.linalg.lstsq(U, Y, rcond=None)      # lattice axes -> visual axes
        Uu, _, Vt = np.linalg.svd(A)                   # keep rotation only, lattice stays regular
        R = Uu @ Vt
        fits[name] = R.tolist()

        m = (side == s) & ~np.isnan(h1)
        P = (np.c_[u[m], v[m]] - centre) @ R
        az[m] = P[:, 0] * INTEROMMATIDIAL_DEG + (-EYE_CENTRE_AZIMUTH if s == 0 else EYE_CENTRE_AZIMUTH)
        el[m] = P[:, 1] * INTEROMMATIDIAL_DEG
        log(f"eye {name}: azimuth {np.nanmin(az[m]):+.0f}..{np.nanmax(az[m]):+.0f} deg, "
            f"elevation {np.nanmin(el[m]):+.0f}..{np.nanmax(el[m]):+.0f} deg")
    return az, el, fits


# --------------------------------------------------------------------------
# 1b. membrane time constants
# --------------------------------------------------------------------------
# The elementary motion detectors work by comparing a fast input against a
# delayed one. In the fly that delay is not a wire, it is a slow cell type:
# Mi9 and Mi4 feed T4, Tm9 feeds T5, and they low-pass far more than the fast
# arms (Mi1, Tm3, Tm1, Tm2) they are compared against. Giving those types a
# longer membrane constant is what lets direction selectivity fall out of the
# connectome instead of having to be imposed on it.
TAU_FAST = {"R1-R6": 10.0, "L1": 12.0, "L2": 12.0, "L5": 15.0,
            "Mi1": 15.0, "Tm3": 15.0, "Tm1": 15.0, "Tm2": 15.0, "Tm4": 18.0}
TAU_SLOW = {"Mi9": 70.0, "Mi4": 60.0, "Tm9": 70.0, "L3": 45.0,
            "C2": 40.0, "C3": 45.0, "Tm20": 40.0, "CT1": 80.0}
TAU_DEFAULT = 20.0


def membrane_tau(df):
    t = df["type"].fillna("").to_numpy()
    tau = np.full(len(df), TAU_DEFAULT, dtype=np.float32)
    for table in (TAU_FAST, TAU_SLOW):
        for name, val in table.items():
            tau[t == name] = val
    for pre in ("R7", "R8"):
        tau[np.char.startswith(t.astype(str), pre)] = 10.0
    log(f"membrane tau: {int((tau < TAU_DEFAULT).sum()):,} fast, "
        f"{int((tau > TAU_DEFAULT).sum()):,} slow, rest at {TAU_DEFAULT:.0f} ms")
    return tau


# --------------------------------------------------------------------------
# 1c. graded cells need a working point
# --------------------------------------------------------------------------
# The first stages of the fly visual system do not spike. Photoreceptors and
# the lamina and medulla columnar cells are graded: they sit depolarised and
# signal by modulating transmitter release up and down around that resting
# level. That matters here because the ON pathway is a double inhibition --
# R1-R6 inhibits L1, L1 inhibits Mi1 (142k synapses of it), Mi1 excites T4. A
# spiking model whose cells rest at zero Hz cannot represent disinhibition at
# all: there is nothing to remove. Giving these types a tonic drive restores
# the resting release level that the real cells have, and is the one place
# where the model adds something the connectome does not contain.
# Values are millivolts of tonic drive per step. The lamina and medulla
# columnar cells get enough to idle around 10-15 Hz, standing in for the
# resting transmitter release of a graded neuron. T4 and T5 get only a small
# amount, enough to sit just below threshold so that their visual input decides
# whether they fire. That bias is identical for all four direction subtypes and
# every column, so it cannot by itself produce direction selectivity: any
# tuning that appears still has to come out of the wiring.
# A cell's steady membrane offset above rest is (drive per step) x (tau / dt), so a
# tonic drive expressed in raw millivolts means wildly different things to a fast cell
# and a slow one. The first version of this used flat values, which put Tm9 at 280 mV
# above a 7 mV threshold: at that point a cell's rate is set by its own bias and its
# presynaptic partners contribute a rounding error. Measured modulation at Mi1 was
# 0.013 mV under that scheme against 0.628 mV under this one -- the connectome was
# barely participating in its own simulation.
#
# So the drive is expressed as a fraction of the cell's own threshold. 1.0 leaves it
# sitting exactly at the point where synaptic input decides whether it fires, which is
# the whole purpose of a resting release level. It is uniform across types, so it can
# let signals through but cannot invent selectivity.
GRADED_TYPES = (
    "L1", "L2", "L3", "L5", "T1", "C2", "C3",
    "Mi1", "Mi4", "Mi9", "Tm1", "Tm2", "Tm3", "Tm4", "Tm9", "Tm20",
) + tuple(f"T4{d}" for d in "abcd") + tuple(f"T5{d}" for d in "abcd")

V_TO_THRESHOLD = 7.0    # mV from rest (-52) to threshold (-45)
DT_MS = 1.0


def graded_cells(df, tau):
    """Tonic drive per step that leaves each graded cell at its own threshold."""
    t = df["type"].fillna("").to_numpy()
    g = np.zeros(len(df), dtype=np.float32)
    mask = np.isin(t, GRADED_TYPES)
    g[mask] = (V_TO_THRESHOLD / (tau[mask] / DT_MS)).astype(np.float32)
    log(f"graded cells given a working point at threshold: {int(mask.sum()):,} "
        f"({g[mask].min():.3f} to {g[mask].max():.3f} mV per step)")
    return g


# --------------------------------------------------------------------------
# 2. effectors
# --------------------------------------------------------------------------
@dataclass
class Group:
    name: str
    note: str
    idx: list


def build_groups(df):
    t = df["type"].fillna("")
    sc = df["superclass"].fillna("")
    sub = df["subclass"].fillna("")
    sideL = (df["somaSide"] == "L").to_numpy()
    sideR = (df["somaSide"] == "R").to_numpy()
    g = {}

    def add(name, mask, note):
        idx = np.flatnonzero(np.asarray(mask))
        g[name] = Group(name, note, idx.astype(np.int32).tolist())

    # ---- sensory ----
    add("R1-6", (t == "R1-R6").to_numpy(), "outer photoreceptors, broadband, motion pathway")
    add("R7", t.str.match(r"^R7").to_numpy(), "inner photoreceptor, UV and short wavelength")
    add("R8", t.str.match(r"^R8").to_numpy(), "inner photoreceptor, long wavelength")
    for lam in ("L1", "L2", "L3", "L5"):
        add(lam, (t == lam).to_numpy(), f"lamina monopolar cell {lam}, direct photoreceptor target")

    # ---- medulla and lamina columnar cells, the stages in between ----
    for ct in ("Mi1", "Mi4", "Mi9", "Tm1", "Tm2", "Tm3", "Tm4", "Tm9", "Tm20",
               "C2", "C3", "T1", "CT1", "TmY5a", "Dm8", "Dm9"):
        add(ct, (t == ct).to_numpy(), f"optic lobe cell type {ct}")

    # ---- motion detectors, by preferred direction ----
    for d, meaning in (("a", "front-to-back"), ("b", "back-to-front"),
                       ("c", "upward"), ("d", "downward")):
        add(f"T4{d}", (t == f"T4{d}").to_numpy(), f"ON motion detector, prefers {meaning}")
        add(f"T5{d}", (t == f"T5{d}").to_numpy(), f"OFF motion detector, prefers {meaning}")

    # ---- descending commands ----
    named_dns = {
        "DNp01": "giant fiber, drives escape takeoff",
        "MDN": "moonwalker DN, drives backward walking",
        "DNp09": "drives freezing and walking arrest",
        "DNa02": "steering DN, ipsilateral turning",
        "DNa01": "steering DN, turning",
    }
    for nm, note in named_dns.items():
        add(nm, (t == nm).to_numpy(), note)
        add(nm + "_L", (t == nm).to_numpy() & sideL, note + " (left)")
        add(nm + "_R", (t == nm).to_numpy() & sideR, note + " (right)")
    add("DN_all", (sc == "descending_neuron").to_numpy(),
        "every descending neuron, the brain's entire output channel to the nerve cord")

    # ---- motor pools, grouped by nerve and neuromere, i.e. by muscle ----
    is_mn = sc.isin(["vnc_motor", "cb_motor"]).to_numpy()
    legs = {"fl": "front leg", "ml": "middle leg", "hl": "hind leg"}
    for key, label in legs.items():
        base = is_mn & (sub == key).to_numpy()
        add(f"leg_{key}_L", base & sideL, f"{label} motor neurons, left")
        add(f"leg_{key}_R", base & sideR, f"{label} motor neurons, right")
    legmask = is_mn & sub.isin(["fl", "ml", "hl"]).to_numpy()
    add("leg_L", legmask & sideL, "all left leg motor neurons")
    add("leg_R", legmask & sideR, "all right leg motor neurons")
    add("leg_all", legmask, "all six legs")

    add("neck_L", is_mn & (sub == "nm").to_numpy() & sideL, "left neck motor neurons, head yaw")
    add("neck_R", is_mn & (sub == "nm").to_numpy() & sideR, "right neck motor neurons, head yaw")

    power = t.str.contains("DLMn|DVMn", regex=True, na=False).to_numpy()
    add("wing_power", is_mn & power, "dorsal longitudinal and dorsoventral power muscles")
    add("wing_steer", is_mn & (sub == "wm").to_numpy() & ~power,
        "wing steering muscle motor neurons")

    prob = (sc == "cb_motor").to_numpy() & t.str.match(r"^MN").to_numpy()
    add("proboscis", prob, "proboscis motor neurons, feeding and biting")

    add("haltere", is_mn & (sub == "hm").to_numpy(), "haltere motor neurons")
    add("abdomen", is_mn & (sub == "ad").to_numpy(), "abdominal motor neurons")

    return g


def main():
    df = pd.read_parquet(BRAIN / "neurons.parquet")
    n, pre, post, w = load_graph()
    assert n == len(df)

    h1, h2, side = propagate_hex(df, pre, post, w)
    az, el, fits = eye_geometry(df, h1, h2, side)

    groups = build_groups(df)
    log("effector and sensor groups:")
    for k, v in groups.items():
        if len(v.idx):
            log(f"   {k:14s} n={len(v.idx):5d}  {v.note}")

    placed = ~np.isnan(az)
    log("retinotopic coverage:")
    for key in ("R1-6", "R7", "R8", "L1", "L2", "T4a", "T5a"):
        idx = np.array(groups[key].idx, dtype=int)
        if len(idx):
            log(f"   {key:6s} {int(placed[idx].sum()):5d}/{len(idx):5d} placed")

    tau = membrane_tau(df)
    np.save(BRAIN / "tau_ms.npy", tau)
    np.save(BRAIN / "graded.npy", graded_cells(df, tau))
    np.save(BRAIN / "delay_ms.npy", synaptic_delay(df))
    np.savez_compressed(
        BRAIN / "atlas.npz",
        hex1=h1.astype(np.float32), hex2=h2.astype(np.float32),
        azimuth=az.astype(np.float32), elevation=el.astype(np.float32),
        side=side,
    )
    (BRAIN / "groups.json").write_text(json.dumps(
        {k: asdict(v) for k, v in groups.items()}, indent=1))
    (BRAIN / "eye_fit.json").write_text(json.dumps(
        {"rotation": fits, "interommatidial_deg": INTEROMMATIDIAL_DEG,
         "eye_centre_azimuth": EYE_CENTRE_AZIMUTH}, indent=2))
    log(f"placed {int(placed.sum()):,} cells in visual space; wrote brain/atlas.npz")


if __name__ == "__main__":
    main()
