# CROSS_VERSION_STATUS

**Short answer: no, cross-version compatibility is not finished. The foundation is; the
compatibility is not.**

Written 2026-09-05 because "we built a version architecture" and "the backend supports Chapter 2"
are very different claims, and only the first one is true.

---

## The number that settles it

```
features that resolve DIFFERENTLY at major 11 (Ch2 S1) than at major 7 (Ch2 S1's Chapter-1 twin): 0
```

Every feature in the compatibility table returns the identical state for a Chapter 2 client and a
7.40 client. **A Chapter 2 client connecting today would be served exactly what 7.40 is served.**
That is not cross-version compatibility; it is one version with a version-shaped frame around it.

Supporting counts, from `supportReport()`:

| | |
|---|---|
| features in the table | 20 |
| `SUPPORTED` | 7 — **all seven are Chapter 1 facts** |
| `IMPLEMENTED` (code exists, criteria missing) | 10 |
| `KNOWN` (understood, unimplemented) | 2 |
| `UNKNOWN` | 1 |
| rows whose evidence is a Chapter-1 observation | 19 of 20 |
| rows carrying evidence about any later chapter | **1** |

---

## What IS finished

These are real, tested, and were not there this morning.

| | |
|---|---|
| **Build registry** | 42 majors → chapter/season, Chapters 1–7, derived mechanically from the corpus. Zero gaps, zero conflicts. `tools/build-registry.mjs --check` re-verifies it |
| **Version identification** | multi-signal, carries an explicit confidence, refuses to invent a chapter for an unknown major |
| **Compatibility table** | ADDED/REMOVED/RENAMED/REPLACED/MODIFIED/VERSION_SPECIFIC/UNKNOWN with per-entry evidence, and `supportLevel()` computing SUPPORTED vs IMPLEMENTED rather than letting it be asserted |
| **7.40 baseline protection** | golden tests driving the real handlers with the real User-Agent; verified to fail when the timeline is regressed |
| **One real cross-version bug, fixed** | the timeline's `seasonNumber` is the continuous major, not the season-within-chapter — a chapter-relative value would have told a Chapter 4 client it was in Chapter 1 |

The last row is the honest measure of what the foundation is worth so far: it caught a defect that
would have broken Chapter 2 silently and could not have been found from 7.40, because in Chapter 1
the two numbers coincide.

---

## What is NOT finished, and why

### 1. There is nothing evidenced to vary *to*

The supplied corpus grades its own Chapter 2–4 material as inference with "no authoritative
citations", and states that the live-event activation mechanism "is not public". Populating a
compatibility matrix from that means inventing endpoint introduction and removal versions — the thing
[AUDIT_PROMPT.md](AUDIT_PROMPT.md) Rule 5 forbids and this brief restates as "never silently upgrade
an INFERRED behavior into CONFIRMED".

So the table is mostly `UNKNOWN` outside Chapter 1 **by choice**. Filling it in would not be progress;
it would be fabrication with a schema around it.

### 2. The native components are locked to 7.40, and no backend work changes that

`Cobalt.dll` finds `curl_easy_setopt` by **byte-signature scan**. `Project Reboot.dll` resolves engine
offsets the same way. A different build compiles differently, the scan point moves, and neither DLL
functions.

**This is the binding constraint, not the backend.** Even a perfect Chapter 2 backend would not let
anyone play Chapter 2: the client would never be redirected to it, and nothing could host. Any plan
that starts with backend work has the order wrong.

### 3. No second build has ever been run

Every claim in this project rests on one client binary and six captured sessions, all 7.40. There is
no second data point to be compatible *with*.

---

## What would actually finish it

In order. Each step is a **measurement**, not a writing task, and the method is proven — `binscan.js`
settled five 7.40 questions this way.

1. **Obtain one client binary from another era.** The `Fortnitebuilds` / `all-fortnite-builds` links
   in `Links.txt` are the lead. This is the gate; nothing downstream is possible without it.
2. **Run the same scans against it.** Playlists, field presence, endpoint fragments, party V1 vs V2.
   About twenty minutes of work per question, and it converts `UNKNOWN` rows into evidenced ones.
3. **Add rows with honest confidence. Do not implement yet.**
4. **Add a golden test for that era**, asserting what it must receive — the 7.40 test is the template.
5. **Then** branch behaviour, reading the table rather than writing `if (major >= n)` at a call site.
6. **Port the native components**, which is the large, separate, unavoidable piece.
7. Re-run the 7.40 baseline. If it moved, the change is wrong.

---

## Why the foundation was still worth building first

Three reasons, none of them "so we could say it was done":

- It **found and fixed a real defect** (`seasonNumber`) that was latent and undiscoverable from the
  only build we have.
- It makes the gap **countable**. "0 features vary by build" is a fact anyone can re-derive; "we have
  a version architecture" is a feeling.
- It makes step 3 above cheap. When a second binary arrives the work is adding table rows, not
  designing a system while also learning a new build.

**What it does not do is make the project cross-version compatible.** It makes it ready to become so,
and honest about the distance.

See [CROSS_VERSION_ARCHITECTURE.md](CROSS_VERSION_ARCHITECTURE.md) for the design and
[VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) for the 7.40 evidence base.
