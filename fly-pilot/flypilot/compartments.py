"""Split whole-map neurons into per-column compartments.

A point-neuron model assumes every cell is isopotential. For most of the
connectome that is a harmless simplification. For a handful of optic-lobe cells
it is badly wrong: CT1 is a single neuron with 201,248 synapses whose arbor
covers all 892 columns of the eye, and Am1 is nearly as large. Cable theory
says an arbor that size cannot be at one potential, and for CT1 in particular
the per-column processes are known to act as independent local units.

Left uncorrected this is not a subtle error. As one node, CT1 fires at ~190 Hz
and delivers -0.26 mV/ms to every T4 cell in both eyes at once, which is on its
own enough to hold the entire motion-detection system below threshold. The
motion pathway simply does not work until this is fixed.

Which cells to split is deliberately a short, named list rather than a
threshold. Span alone is the wrong test: LC, LPi, LT and Li cells also reach
across the whole field, but they are genuine wide-field integrators -- the LC
loom detectors that drive the giant fiber pool the visual field on purpose, and
splitting them would destroy real function. The two cells treated here are the
ones where a single electrical compartment is not tenable: CT1, whose per-column
processes are known to act independently, and Am1, an amacrine cell, a class
that by definition does its processing locally. Both are also enormous: 201k and
103k synapses against a typical few thousand.

Each compartment keeps exactly the synapses belonging to its column and is
electrically separate from the others. No synapse is created, destroyed, or
reweighted -- they are only regrouped onto the compartment they physically
belong to.

New compartments are appended after the existing neurons so that every index
already in use stays valid.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
BRAIN = ROOT / "brain"


def log(m):
    print(f"[compart] {m}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", default="CT1,Am1",
                    help="comma-separated cell types to compartmentalise")
    ap.add_argument("--min-span", type=int, default=600,
                    help="a listed cell is only split if it spans this many columns")
    ap.add_argument("--min-synapses", type=int, default=50_000,
                    help="and carries at least this many synapses")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    df = pd.read_parquet(BRAIN / "neurons.parquet")
    indptr = np.load(BRAIN / "csr_indptr.npy")
    indices = np.load(BRAIN / "csr_indices.npy")
    w_raw = np.load(BRAIN / "csr_weight_raw.npy")
    atlas = np.load(BRAIN / "atlas.npz")
    h1, h2, side = atlas["hex1"], atlas["hex2"], atlas["side"]
    n = len(indptr) - 1
    assert len(df) == n

    pre = np.repeat(np.arange(n, dtype=np.int32), np.diff(indptr))
    post = indices

    # column id per neuron, or -1 where unknown
    col = np.full(n, -1, dtype=np.int32)
    ok = ~np.isnan(h1)
    c1 = np.round(np.where(ok, h1, 0)).astype(np.int32)
    c2 = np.round(np.where(ok, h2, 0)).astype(np.int32)
    col[ok] = (np.maximum(side[ok], 0).astype(np.int32) * 4096
               + c1[ok] * 64 + c2[ok])

    # how many distinct columns does each cell touch?
    log("measuring arbor span")
    span = np.zeros(n, dtype=np.int32)
    order = np.lexsort((col[post], pre))
    p_s, c_s = pre[order], col[post][order]
    keep = c_s >= 0
    p_s, c_s = p_s[keep], c_s[keep]
    newpair = np.empty(len(p_s), dtype=bool)
    newpair[0] = True
    newpair[1:] = (p_s[1:] != p_s[:-1]) | (c_s[1:] != c_s[:-1])
    np.add.at(span, p_s[newpair], 1)

    order = np.lexsort((col[pre], post))
    q_s, d_s = post[order], col[pre][order]
    keep = d_s >= 0
    q_s, d_s = q_s[keep], d_s[keep]
    newpair = np.empty(len(q_s), dtype=bool)
    newpair[0] = True
    newpair[1:] = (q_s[1:] != q_s[:-1]) | (d_s[1:] != d_s[:-1])
    np.add.at(span, q_s[newpair], 1)

    types = df["type"].fillna("?").to_numpy()
    wanted = {s.strip() for s in a.types.split(",") if s.strip()}
    syn_total = (np.bincount(pre, weights=w_raw, minlength=n)
                 + np.bincount(post, weights=w_raw, minlength=n))
    named = np.isin(types, list(wanted))
    targets = np.flatnonzero(named & (span >= a.min_span) & (syn_total >= a.min_synapses))

    log(f"candidates named: {int(named.sum())};  passing span >= {a.min_span} "
        f"and synapses >= {a.min_synapses:,}: {len(targets)}")
    for t in np.flatnonzero(named):
        mark = "SPLIT" if t in set(targets.tolist()) else "keep "
        log(f"   [{mark}] {types[t]:8s} idx {t:6d}  span {span[t]:4d} columns  "
            f"{syn_total[t]:8.0f} synapses")
    if a.dry_run or len(targets) == 0:
        return

    # ---- assign every edge touching a target to a compartment -------------
    is_target = np.zeros(n, dtype=bool)
    is_target[targets] = True

    # compartment key: (cell, column of the partner). Partners with no column
    # fall into one shared "rest of cell" compartment so no synapse is lost.
    def comp_key(cell, partner_col):
        return cell.astype(np.int64) * 100_000 + (partner_col.astype(np.int64) + 1)

    touch_out = is_target[pre]
    touch_in = is_target[post]
    keys = np.concatenate([comp_key(pre[touch_out], col[post][touch_out]),
                           comp_key(post[touch_in], col[pre][touch_in])])
    uniq, inv = np.unique(keys, return_inverse=True)
    n_new = len(uniq)
    log(f"creating {n_new:,} compartments from {len(targets)} cells")

    new_id = n + np.arange(n_new, dtype=np.int32)
    k_out = inv[:touch_out.sum()]
    k_in = inv[touch_out.sum():]

    new_pre = pre.copy()
    new_post = post.copy()
    new_pre[touch_out] = new_id[k_out]
    new_post[touch_in] = new_id[k_in]

    # ---- rebuild the graph ------------------------------------------------
    total = n + n_new
    log(f"rebuilding CSR for {total:,} nodes")
    order = np.lexsort((new_post, new_pre))
    new_pre, new_post, w_sorted = new_pre[order], new_post[order], w_raw[order]
    new_indptr = np.zeros(total + 1, dtype=np.int64)
    np.cumsum(np.bincount(new_pre, minlength=total), out=new_indptr[1:])

    # ---- extend the metadata ---------------------------------------------
    parent = (uniq // 100_000).astype(np.int64)
    pcol = (uniq % 100_000).astype(np.int64) - 1
    rows = df.iloc[parent].copy().reset_index(drop=True)
    rows["bodyId"] = df["bodyId"].to_numpy()[parent]
    rows["instance"] = [f"{types[p]}_col{c}" for p, c in zip(parent, pcol)]
    has_col = pcol >= 0
    rows["assignedOlHex1"] = np.where(has_col, (pcol % 4096) // 64, np.nan)
    rows["assignedOlHex2"] = np.where(has_col, pcol % 64, np.nan)
    rows["somaSide"] = np.where(has_col, np.where(pcol // 4096 == 0, "L", "R"),
                                df["somaSide"].to_numpy()[parent])
    rows["compartment_of"] = df["bodyId"].to_numpy()[parent]
    df["compartment_of"] = -1
    out_df = pd.concat([df, rows], ignore_index=True)

    sign = out_df["sign"].to_numpy(dtype=np.float32)
    pre_of_edge = np.repeat(np.arange(total, dtype=np.int32), np.diff(new_indptr))
    w_signed = (w_sorted * sign[pre_of_edge]).astype(np.float32)

    orphaned = int((np.diff(new_indptr)[targets] == 0).sum())
    log(f"original cell bodies left with no edges: {orphaned}/{len(targets)} (expected)")

    np.save(BRAIN / "csr_indptr.npy", new_indptr)
    np.save(BRAIN / "csr_indices.npy", new_post.astype(np.int32))
    np.save(BRAIN / "csr_weight_raw.npy", w_sorted.astype(np.float32))
    np.save(BRAIN / "csr_weight.npy", w_signed)
    out_df.to_parquet(BRAIN / "neurons.parquet", index=False)

    meta = json.loads((BRAIN / "meta.json").read_text())
    meta.update({
        "neurons": int(total),
        "edges": int(len(new_post)),
        "compartmentalised_cells": [str(types[t]) for t in targets],
        "compartments_added": int(n_new),
        "min_span": a.min_span,
    })
    (BRAIN / "meta.json").write_text(json.dumps(meta, indent=2))
    log(f"done: {total:,} nodes, {len(new_post):,} edges, "
        f"{float(w_sorted.sum()):,.0f} synapses (unchanged)")
    log("now re-run atlas.py so the new compartments get retinotopy and groups")


if __name__ == "__main__":
    main()
