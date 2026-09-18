"""Turn the Janelia male-CNS v1.0 flat connectome into a simulation-ready graph.

Reads three feather files (annotations, neurotransmitters, segment-to-segment
weights) and writes a CSR adjacency indexed by presynaptic neuron, with each
edge weight already signed by the presynaptic cell's transmitter.

The weights file is 152M rows / 1.05 GB on disk, so it is streamed in Arrow
record batches instead of being materialised as int64 columns.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.ipc as ipc

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "brain"

ANNOT = RAW / "body-annotations-male-cns-v1.0-minconf-0.5.feather"
NT = RAW / "body-neurotransmitters-male-cns-v1.0.feather"
WEIGHTS = RAW / "connectome-weights-male-cns-v1.0-minconf-0.5.feather"

# Fast transmitters. Glutamate is inhibitory in the fly (GluCl-alpha) and
# histamine is the photoreceptor transmitter, also inhibitory. Monoamines are
# slow modulators; we fold them in as weak excitation rather than drop them.
NT_SIGN = {
    "acetylcholine": 1.0,
    "gaba": -1.0,
    "glutamate": -1.0,
    "histamine": -1.0,
    "dopamine": 0.3,
    "octopamine": 0.3,
    "serotonin": 0.3,
    "unknown": 1.0,
}
DEFAULT_SIGN = 1.0  # unannotated cells default to excitatory, as in FlyWire LIF models

META_COLS = [
    "bodyId", "type", "instance", "class", "subclass", "superclass",
    "somaSide", "rootSide", "somaNeuromere", "entryNerve", "exitNerve",
    "assignedOlHex1", "assignedOlHex2", "status", "receptorType",
]


def log(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def load_neurons() -> "tuple[np.ndarray, dict]":
    import pandas as pd

    log("reading annotations")
    df = feather.read_table(ANNOT).to_pandas()
    df = df[df["status"] == "Traced"].copy()

    log("reading neurotransmitter predictions")
    nt = feather.read_table(
        NT, columns=["body", "consensus_nt", "celltype_predicted_nt"]
    ).to_pandas()
    nt = nt.drop_duplicates(subset="body").set_index("body")
    df["nt"] = df["bodyId"].map(nt["consensus_nt"])
    fallback = df["bodyId"].map(nt["celltype_predicted_nt"])
    df["nt"] = df["nt"].fillna(fallback).fillna("unknown")
    df["sign"] = df["nt"].map(NT_SIGN).fillna(DEFAULT_SIGN).astype(np.float32)

    # soma position, when present, is a 3-element list column
    soma = df["somaLocation"]
    pos = np.full((len(df), 3), np.nan, dtype=np.float32)
    for i, v in enumerate(soma.to_numpy()):
        if v is not None and not np.isscalar(v) and len(v) == 3:
            pos[i] = v
    df = df[[c for c in META_COLS + ["nt", "sign"] if c in df.columns]].copy()
    df["soma_x"], df["soma_y"], df["soma_z"] = pos[:, 0], pos[:, 1], pos[:, 2]
    df = df.sort_values("bodyId").reset_index(drop=True)
    log(f"{len(df):,} traced neurons; "
        f"{int((df['somaSide'] == 'L').sum()):,} L / {int((df['somaSide'] == 'R').sum()):,} R")
    counts = df["nt"].value_counts().to_dict()
    log("transmitters: " + ", ".join(f"{k}={v:,}" for k, v in list(counts.items())[:8]))
    return df, counts


def stream_edges(body_ids: np.ndarray, min_weight: int):
    """Filter the 152M-row weight table down to traced<->traced edges."""
    reader = ipc.open_file(pa.memory_map(str(WEIGHTS), "rb"))
    n_batches = reader.num_record_batches
    log(f"streaming {n_batches} record batches from the weight table")

    pre_chunks, post_chunks, w_chunks = [], [], []
    seen = kept = 0
    t0 = time.time()
    for b in range(n_batches):
        batch = reader.get_batch(b)
        pre = batch.column("body_pre").to_numpy(zero_copy_only=False)
        post = batch.column("body_post").to_numpy(zero_copy_only=False)
        w = batch.column("weight").to_numpy(zero_copy_only=False)
        seen += len(w)

        keep = w >= min_weight
        if not keep.any():
            # rows are weight-sorted descending overall, but batches may still
            # carry stragglers, so keep scanning rather than breaking out.
            continue
        pre, post, w = pre[keep], post[keep], w[keep]

        ip = np.searchsorted(body_ids, pre)
        np.clip(ip, 0, len(body_ids) - 1, out=ip)
        ok = body_ids[ip] == pre
        if not ok.any():
            continue
        pre_i, post, w = ip[ok], post[ok], w[ok]

        jp = np.searchsorted(body_ids, post)
        np.clip(jp, 0, len(body_ids) - 1, out=jp)
        ok2 = body_ids[jp] == post
        if not ok2.any():
            continue
        pre_i, post_i, w = pre_i[ok2], jp[ok2], w[ok2]

        pre_chunks.append(pre_i.astype(np.int32))
        post_chunks.append(post_i.astype(np.int32))
        w_chunks.append(w.astype(np.float32))
        kept += len(w)

        if b % 20 == 0 or b == n_batches - 1:
            log(f"  batch {b + 1}/{n_batches}  scanned {seen:,}  kept {kept:,}  "
                f"({time.time() - t0:.0f}s)")

    if not pre_chunks:
        raise SystemExit("no edges survived filtering")
    pre = np.concatenate(pre_chunks)
    post = np.concatenate(post_chunks)
    w = np.concatenate(w_chunks)
    log(f"kept {len(w):,} of {seen:,} rows ({100 * len(w) / seen:.1f}%)")
    return pre, post, w


def build_csr(pre, post, w, n):
    log("sorting edges by presynaptic neuron")
    order = np.argsort(pre, kind="stable")
    pre, post, w = pre[order], post[order], w[order]
    indptr = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(np.bincount(pre, minlength=n), out=indptr[1:])
    return indptr, post, w


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-weight", type=int, default=2,
                    help="drop connections with fewer than this many synapses")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    df, nt_counts = load_neurons()
    body_ids = df["bodyId"].to_numpy(dtype=np.int64)
    n = len(body_ids)

    pre, post, w_raw = stream_edges(body_ids, args.min_weight)
    indptr, indices, w_raw = build_csr(pre, post, w_raw, n)

    sign = df["sign"].to_numpy(dtype=np.float32)
    # each edge takes the sign of its presynaptic cell
    pre_of_edge = np.repeat(np.arange(n, dtype=np.int32), np.diff(indptr))
    w_signed = (w_raw * sign[pre_of_edge]).astype(np.float32)

    log("writing brain/")
    np.save(OUT / "csr_indptr.npy", indptr)
    np.save(OUT / "csr_indices.npy", indices.astype(np.int32))
    np.save(OUT / "csr_weight.npy", w_signed)
    np.save(OUT / "csr_weight_raw.npy", w_raw.astype(np.float32))
    np.save(OUT / "body_ids.npy", body_ids)
    df.to_parquet(OUT / "neurons.parquet", index=False)

    in_deg = np.bincount(indices, minlength=n)
    out_deg = np.diff(indptr)
    in_syn = np.bincount(indices, weights=w_raw, minlength=n).astype(np.float32)
    np.save(OUT / "in_synapses.npy", in_syn)

    meta = {
        "source": "Janelia FlyEM male CNS v1.0 (CC-BY), minconf 0.5",
        "neurons": int(n),
        "edges": int(len(indices)),
        "synapses": float(w_raw.sum()),
        "min_weight": args.min_weight,
        "mean_out_degree": float(out_deg.mean()),
        "max_out_degree": int(out_deg.max()),
        "isolated": int(((in_deg == 0) & (out_deg == 0)).sum()),
        "nt_counts": {k: int(v) for k, v in nt_counts.items()},
        "inhibitory_edges": int((w_signed < 0).sum()),
        "excitatory_edges": int((w_signed > 0).sum()),
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
    log(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
