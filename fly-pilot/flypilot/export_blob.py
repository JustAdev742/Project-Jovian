"""Pack the built brain into one file the game server can load.

The Python side is the workshop: it downloads the connectome, filters it,
compartmentalises the whole-map cells, works out retinotopy and writes the
group tables. None of that should happen inside a game server. So it all gets
flattened here into a single little-endian blob that flypilot.cpp reads with
one pass of fread and no parsing.

Layout, little endian throughout:

    char   magic[8]      "FLYBRN01"
    u32    n_neurons
    u32    n_groups
    u64    n_edges
    i64    indptr[n + 1]
    i32    indices[n_edges]
    f32    weight[n_edges]      already signed by transmitter
    f32    tau_ms[n]
    f32    graded_mv[n]
    f32    delay_ms[n]
    f32    azimuth_deg[n]       NaN where the cell has no visual direction
    f32    elevation_deg[n]
    i8     side[n]              0 left, 1 right, -1 unknown
    then n_groups times:
        u16  name_len
        char name[name_len]
        u32  count
        i32  idx[count]
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BRAIN = ROOT / "brain"

MAGIC = b"FLYBRN01"

# Only the groups the server actually reads. Shipping all 80 would bloat the
# file with index lists nothing consumes.
KEEP = [
    "R1-6", "R7", "R8", "L1", "L2", "L3", "L5",
    "T4a", "T4b", "T4c", "T4d", "T5a", "T5b", "T5c", "T5d",
    "Mi1", "Tm9",
    "DNp01", "MDN", "DNp09", "DNa02_L", "DNa02_R", "DN_all",
    "leg_L", "leg_R", "leg_all", "neck_L", "neck_R",
    "wing_power", "wing_steer", "proboscis",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist" / "flybrain.bin"))
    ap.add_argument("--install", default="",
                    help="also copy the blob into this Fortnite build, where the DLL looks")
    a = ap.parse_args()

    indptr = np.load(BRAIN / "csr_indptr.npy").astype("<i8")
    indices = np.load(BRAIN / "csr_indices.npy").astype("<i4")
    weight = np.load(BRAIN / "csr_weight.npy").astype("<f4")
    n = len(indptr) - 1
    e = len(indices)

    def load(name, dtype, default):
        p = BRAIN / name
        if p.exists():
            return np.load(p).astype(dtype)
        return np.full(n, default, dtype=dtype)

    tau = load("tau_ms.npy", "<f4", 20.0)
    graded = load("graded.npy", "<f4", 0.0)
    delay = load("delay_ms.npy", "<f4", 2.0)
    atlas = np.load(BRAIN / "atlas.npz")
    az = atlas["azimuth"].astype("<f4")
    el = atlas["elevation"].astype("<f4")
    side = atlas["side"].astype("<i1")

    groups = json.loads((BRAIN / "groups.json").read_text())
    picked = [(k, np.asarray(groups[k]["idx"], dtype="<i4"))
              for k in KEEP if k in groups and groups[k]["idx"]]

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<IIQ", n, len(picked), e))
        for arr in (indptr, indices, weight, tau, graded, delay, az, el, side):
            f.write(arr.tobytes())
        for name, idx in picked:
            nb = name.encode()
            f.write(struct.pack("<H", len(nb)))
            f.write(nb)
            f.write(struct.pack("<I", len(idx)))
            f.write(idx.tobytes())

    mb = out.stat().st_size / 1024 / 1024
    print(f"wrote {out}")
    print(f"  {n:,} neurons, {e:,} edges, {len(picked)} groups, {mb:.1f} MB")
    print(f"  groups: {', '.join(k for k, _ in picked)}")

    if a.install:
        import shutil
        dest = (Path(a.install) / "FortniteGame" / "Binaries" / "Win64"
                / "Reboot Resources" / "flybrain.bin")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(out, dest)
        print(f"  installed to {dest}")

    # a sidecar the launcher and the docs can read without parsing the blob
    meta = json.loads((BRAIN / "meta.json").read_text())
    meta["blob_bytes"] = out.stat().st_size
    meta["groups"] = {k: len(v) for k, v in picked}
    (out.with_suffix(".json")).write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
