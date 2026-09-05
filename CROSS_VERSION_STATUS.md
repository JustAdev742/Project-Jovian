# CROSS_VERSION_STATUS

**Updated 2026-09-06, third pass.** The first version of this document said zero behaviour varied
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

And, added in the third pass, the locker itself:

| build | chapter/season | cosmetics served | difference |
|---|---|---|---|
| 7.40 | Ch1 S7 | 334 | `EID_Conga` withheld — a Season 8 emote |
| 8.30 | Ch1 S8 | 335 | complete |
| 11.31 | Ch2 S1 | 335 | complete |
| 19.01 | Ch3 S1 | 335 | complete |

Exactly one item differs between 7.40 and 8.30, and a test asserts that it is exactly one — an
inverted comparison would empty the locker instead, and every "is X absent" assertion would still
have passed.

Four endpoints vary by build; the two sampled that do not (`versioncheck`, `lightswitch`) are
**correct** not to, and a test asserts they stay identical. A model that changes what does not need
changing is a liability.

> **Correction, third pass.** The second pass listed `enabled_features` among the endpoints that were
> right to be identical everywhere. That was wrong, and wrong in the direction this project is most
> wary of — it was an absence argument from a sample that happened to contain no 2017 build. The
> corpus documents that endpoint with **both** an old and a current response
> (`FN-Service/Game/EnabledFeatures.md`: `[]`, and `["store"]` labelled `(2017)`), which makes it one
> of the few genuine old/new pairs in the whole corpus. It now varies. See the caveat on the
> boundary below.

### Two different numbers, and they measure different things

Worth stating plainly, because the first pass of this document led with one of them:

| metric | value | what it means |
|---|---|---|
| endpoints whose **response** differs by build | **3 of 6 sampled** | the backend genuinely serves Chapters 1-4 differently |
| features whose **table entry** differs at major 11 vs 7 | **still 0** | no row yet says "this works differently after build 11" |
| features whose table entry differs at **any** boundary we hold | **2 of 26** | `game.enabledFeatures` (2017 vs later) and `cosmetics.locker.eraFilter` (per item) |

Both are true. The behaviour varies because the *data* varies (season number, chunk keys) while the
*rules* do not: nothing in the compatibility table yet says "this works differently after build N",
because no evidence in the corpus establishes such a boundary. That second number is the one that
only a second client binary can move, and it is the honest measure of how far this is from finished.

### What changed to get here

| | |
|---|---|
| **Per-build cosmetic keys** | `version/keychain.ts`, generated from the AES archive — 75 builds, 634 keys, CONFIRMED, Chapters 1-3. The keychain served 7.40's two keys to everyone; it now serves the requesting build's own, exact-match only |
| **Lobby background** | was reading `Config.SEASON_NUMBER`, so every build got `lobbyseason7`. **Found by the measurement, not by the tests** — the endpoint reported as version-varying because other fields varied while this one silently did not |
| **Timeline** | already season-driven, and now correct across chapters via the `seasonNumber = major` finding |
| **Per-era locker** *(third pass)* | `version/cosmetics.ts`, generated from the datamining corpus's `introduction:{chapter,season}` — CONFIRMED, present on 15,025 of 23,532 records. Nova granted the same 335 cosmetics to every build; `EID_Conga` is a **Chapter 1 Season 8** emote and was going to 7.40, a Season 7 build, where it has no assets and draws as a blank tile |
| **`enabled_features`** *(third pass)* | now returns `["store"]` to the 2017 majors and `[]` to everything later. The one endpoint the corpus documents with an explicit old/new response pair |

Pinned by a five-case matrix test across four chapters, including that Chapter 1's era-specific event
flags do not leak into a Chapter 2 build.

---

## What is still NOT finished

**0. A hard ceiling that no amount of backend work lifts: EOS-era clients cannot be pointed at Nova
at all.** CONFIRMED, and it belongs at the top because it bounds what the phrase "support every
version" can honestly mean.

7.40 uses **OnlineSubsystemMcp**, which resolves Epic services **by URL**. That is the entire reason
a host redirect works: rewrite the hostname and the client asks Nova instead. Later builds use the
**EOS SDK**, which resolves by **ProductId / SandboxId / DeploymentId** issued by Epic — identifiers,
not addresses. There is no URL for a redirect to rewrite.

So the two halves of "support" come apart, and it is worth being blunt about which half this work
delivers:

| | Chapter 1 (pre-EOS) | EOS era |
|---|---|---|
| Can Nova *serve* era-correct responses? | yes | yes — the code is version-parameterised |
| Can the client be made to *ask* Nova? | yes, by host redirect | **no**, not by this mechanism |

Everything below this line is about the first row. The second row is not a gap in the work; it is a
property of how those clients address services, and nothing in the backend can change it.

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

**4. No second build has ever been RUN, and that is still the binding gap.** ~~Every claim still
rests on one client binary.~~ **Amended 2026-09-06 — that half is no longer true.**

A second binary was found on this machine and scanned: `++Fortnite+Release-Live-CL-3240987`,
UE 4.14.0, December 2016, at `Documents/OT 6.5/OT6.5-Live-CL-2870186/…/FortniteClient-Win64-Shipping.exe`.
It is **pre-Battle-Royale** — `Athena` and `BattleRoyale` are both absent — so it is outside the
Chapter 1–4 range and cannot validate any Chapter 2–4 response. It is still worth what it cost,
because it turned three claims that rested on one binary into claims that rest on two:

| probe | Release-Live (Dec 2016) | 7.40 (2019) | what it settles |
|---|---|---|---|
| `profile0` | PRESENT ×2 | ABSENT | the old combined profile is real, and gone by 7.40 |
| `common_core` · `campaign` · `athena` | ALL ABSENT | ×9 · ×14 · ×33 | the split into three profiles happened between them |
| `acceptInvites` | ABSENT | PRESENT | the friend-settings field has a lower bound now |
| `mutualPrivacy` | ABSENT | ABSENT | still later than both; unchanged |
| `OnlineSubsystemMcp` | ×898 | present | both are MCP-era, neither is EOS |

**And it found a defect in this session's own work.** `identifyVersion` fills in chapter and season
from the configured fallback even when it parses nothing, so the cosmetics era filter — added hours
earlier, with a comment promising it would not act on a guess — was serving a Chapter 1 Season 7
locker to any build it could not identify. A `Release-Live` request and a bare `curl` were
indistinguishable at that point. Both are fixed: the filter now keys off `confidence`, and
Release-Live is recognised as its own id with its changelist kept. Three regression tests pin it.

That is the argument for step 1 below in miniature. One binary from outside the target range,
scanned for twenty minutes, corrected a bug that a hundred more tests against 7.40 could not have
found — because 7.40 is exactly the build the wrong answer was accidentally right for.

The original point stands otherwise: the table above proves the backend *responds* per build; it
does not prove any of those responses are what that build wants, because no other build has ever
connected.

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
