# CROSS_VERSION_STATUS

**Updated 2026-09-05, second pass.** The first version of this document said zero behaviour varied
by build. That is no longer true, and the numbers below are re-measured rather than re-argued.

**Where it stands: the backend now serves Chapters 1-4 differently, on confirmed evidence, for the
things the evidence covers. It is not "done", and the remaining gap is evidence, not effort.**

---

## Measured, by driving the real handlers with real User-Agents

| build | chapter/season | seasonNumber | lobby stage | chunk keys |
|---|---|---|---|---|
| 7.40 | Ch1 S7 | 7 | `lobbyseason7` | 2 |
| 8.30 | Ch1 S8 | 8 | `lobbyseason8` | 4 |
| 11.31 | Ch2 S1 | 11 | `lobbyseason11` | 14 |
| 19.01 | Ch3 S1 | 19 | `lobbyseason19` | 5 |
| 23.10 | Ch4 S1 | 23 | `lobbyseason23` | 0 — not in the archive, so nothing rather than someone else's |

Three endpoints vary by build; the three sampled that do not (`versioncheck`, `enabled_features`,
`lightswitch`) are **correct** not to, and a test asserts they stay identical. A model that changes
what does not need changing is a liability.

### What changed to get here

| | |
|---|---|
| **Per-build cosmetic keys** | `version/keychain.ts`, generated from the AES archive — 75 builds, 634 keys, CONFIRMED, Chapters 1-3. The keychain served 7.40's two keys to everyone; it now serves the requesting build's own, exact-match only |
| **Lobby background** | was reading `Config.SEASON_NUMBER`, so every build got `lobbyseason7`. **Found by the measurement, not by the tests** — the endpoint reported as version-varying because other fields varied while this one silently did not |
| **Timeline** | already season-driven, and now correct across chapters via the `seasonNumber = major` finding |

Pinned by a five-case matrix test across four chapters, including that Chapter 1's era-specific event
flags do not leak into a Chapter 2 build.

---

## What is still NOT finished

**1. Coverage is only as wide as the evidence.** The AES archive stops at 19.01, so Chapter 4 builds
get an empty keychain — correct, and not the same as supported. Beyond the season number, the lobby
stage and the keys, a Chapter 2 client is still served Chapter 1's answers for everything else:
playlists, storefront, MCP profile contents, quests.

**2. Most of the compatibility table is still `UNKNOWN` outside Chapter 1.** The corpus grades its own
Chapter 2-4 material as inference with no authoritative citations. Filling it in would be fabrication
with a schema around it.

**3. The native components are still locked to 7.40, and this is the binding constraint.** Cobalt and
Reboot resolve their targets by byte-signature scan. No amount of backend work lets anyone actually
*play* another build: the client would never be redirected, and nothing could host. **The backend is
now ahead of what the rest of the stack can use.**

**4. No second build has ever been run.** Every claim still rests on one client binary. The table
above proves the backend *responds* per build; it does not prove any of those responses are what
that build wants, because none has ever connected.

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
- It makes the gap **countable**. The table at the top of this document is a measurement anyone can
  re-run; "we have a version architecture" is a feeling. The first pass of this document reported
  "0 features vary by build", which was true when written and is the reason the second pass exists.
- It makes step 3 above cheap. When a second binary arrives the work is adding table rows, not
  designing a system while also learning a new build.

**What it does not do is make the project cross-version compatible.** It makes the backend serve
per-build content where evidence exists, and leaves the rest honest about the distance — including
the part no backend change can close, which is that the two native DLLs only work on 7.40.

See [CROSS_VERSION_ARCHITECTURE.md](CROSS_VERSION_ARCHITECTURE.md) for the design and
[VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) for the 7.40 evidence base.
