# CROSS_VERSION_ARCHITECTURE

How this project reasons about build versions, and — more importantly — what it refuses to claim
about them.

Established 2026-09-05. Evidence grades per [AUDIT_PROMPT.md](AUDIT_PROMPT.md) Rule 4.

---

## 1. The shape

```
HISTORICAL EVIDENCE          corpus, client binaries, session logs
        ↓
BUILD REGISTRY               src/version/builds.ts     major → (chapter, season)   CONFIRMED
        ↓
VERSION IDENTIFICATION       src/version/identify.ts   request → GameVersion + confidence
        ↓
COMPATIBILITY TABLE          src/version/features.ts   feature × version → state + evidence
        ↓
SHARED SERVICES              the existing route modules, unchanged in shape
        ↓
CLIENT
```

Version-specific behaviour lives in **one table**, not in conditionals spread across forty files. A
table can be printed, diffed, tested as a set, and — the part that matters — checked for whether its
evidence justifies the behaviour it drives. A hundred `if (major >= 11)` cannot.

---

## 2. The build registry — CONFIRMED

`src/version/builds.ts`. Derived mechanically from the `fortnite-archives` corpus, which stores
per-build map data under `chapter_<c>/season_<s>/<major>_<minor>/`.

**42 majors, chapters 1–7. Zero gaps in the major sequence. Zero conflicts.** A single
miscategorised directory would have produced a conflict; none did, and
`tools/build-registry.mjs --check` re-verifies it against the corpus on demand.

| chapter | majors | seasons |
|---|---|---|
| 1 | 1–10 | 1–10 |
| 2 | 11–18 | 1–8 |
| 3 | 19–22 | 1–4 |
| 4 | 23–27 | 1–5 |
| 5 | 28–32 | 1–5 |
| 6 | 33–38 | 1–5 |
| 7 | 39–42 | 1–4 |

**The bug this replaced.** `version-router.ts` set `season = major`, commented "In Ch1, major version
= season number". Correct, and correct *only* in Chapter 1. Every consumer of `gameVersion.season`
was therefore wrong by construction the moment a non-Chapter-1 client connected.

**Do not compute season from major.** Chapter 6 Season 4 spans majors **36 and 37**. The table is the
authority; arithmetic is not. A test pins this.

---

## 3. Version identification

`src/version/identify.ts`. The User-Agent stays the primary signal — it is the only one 7.40
reliably provides — but the result now carries **how sure it is**:

| confidence | meaning |
|---|---|
| `CONFIRMED` | parsed from the client's own User-Agent AND the major is in the registry |
| `STRONGLY_SUPPORTED` | parsed, but the major is beyond the registry — real numbers, unknown era |
| `UNKNOWN` | nothing usable in the request; this is the configured default |

The old model could not distinguish a measurement from a default, so neither could any diagnostic
built on it. A build beyond the registry gets `chapter: null` and `season: null` rather than an
invented era.

**Anchored on `Release-`.** `Windows/10.0.17763` in the same header also matches a bare `\d+\.\d+`,
and on some agents matches first. A test asserts 7.40 is not read as version 10.

---

## 4. The correction that would have broken Chapter 2 — CONFIRMED

Making `season` *correct* is not automatically safe for the code that reads it, and one consumer
would have broken silently.

**Epic's timeline uses the continuous major, not the season-within-chapter.** `Calendar.md` shows
`"seasonNumber": 24` and `"seasonTemplateId": "AthenaSeason:athenaseason24"` for a document dated
2023-05-18 whose season runs 2023-03-09 → 2023-06-18. The build registry, derived from a completely
independent source, places major 24 at **Chapter 4 Season 2**. Two sources, same conclusion.

So a chapter-relative value would have told a Chapter 4 Season 2 client it was in
`athenaseason2` — Chapter 1 Season 2. In Chapter 1 the two numbers coincide, which is exactly why
this could never have been caught from 7.40 and would have surfaced as "Chapter 2 support is
mysteriously broken".

Consequence, now encoded:

- **wire formats read `major`** — the timeline, and the cloudstorage settings key
- **`chapter` / `season` are for human-facing and per-chapter reasoning**

`cloudstorage.routes.ts` keys `ClientSettings-<n>.Sav` on `major` for the same reason: on `season`,
Chapter 1 Season 7 and Chapter 2 Season 7 would collide on one file. Because the old code set
`season = major`, switching to `major` is a **no-op on disk** — no existing save is orphaned.

---

## 5. The compatibility table

`src/version/features.ts`. One row per feature, with an ordered timeline:

```ts
{ atMajor, change, confidence, evidence, replacedBy?, detail? }
```

`change` is the brief's vocabulary exactly: `ADDED` · `REMOVED` · `RENAMED` · `REPLACED` ·
`MODIFIED` · `VERSION_SPECIFIC` · `UNKNOWN`.

### Supported ≠ implemented, computed rather than asserted

`supportLevel(feature)` returns one of:

| level | meaning |
|---|---|
| `SUPPORTED` | behaviour understood, versions known, implemented, failure defined, tested, evidenced |
| `IMPLEMENTED` | code exists; at least one other criterion is missing — and it says which |
| `KNOWN` | understood and evidenced, but nothing implements it |
| `UNKNOWN` | we do not know what the correct behaviour is |

**A row whose own confidence is `UNKNOWN` can never reach `SUPPORTED`**, however much code points at
it. A test enforces that, with a positive control so the strictness cannot pass vacuously.

`party.v2.rest` is the worked example: Nova routes the family, 7.40 never calls it, no source dates
its introduction. It reports `IMPLEMENTED`, missing "expected behaviour not established". That is the
distinction this whole module exists to make.

---

## 6. What is deliberately empty, and why

Most entries outside Chapter 1 are `UNKNOWN`. **That is the work, not a gap in it.**

The supplied corpus grades its own Chapter 2–4 material as inference with "no authoritative
citations", and its live-events section says the activation mechanism "is not public". Populating a
compatibility matrix from that would mean inventing endpoint introduction and removal versions —
precisely what Rule 5 forbids, and what this brief restates as "never silently upgrade an INFERRED
behavior into CONFIRMED".

An `UNKNOWN` row still earns its place: it names the question, records what evidence would answer it,
and stops the backend from quietly serving a guess.

### What would actually move these rows

| gap | what would settle it |
|---|---|
| Party V1 → V2 transition major | a client binary from the transition era; the same 20-minute scan that settled it for 7.40 |
| `mutualPrivacy` introduction | any post-Chapter-1 client binary |
| Event activation mechanism | a captured timeline document from a live event window, or an event-era client |
| MCP response envelope semantics | nothing in 753 corpus files documents it; needs a captured response |
| Per-chapter endpoint add/remove | per-build client binaries — the `Fortnitebuilds` / `all-fortnite-builds` links in `Links.txt` |

Every one is a **measurement task**, not a writing task. The method already exists and is proven:
`tools/binscan.js` settled five 7.40 questions this way.

### What IS already available for other builds

Not everything beyond Chapter 1 is dark. The corpus contains real per-build data that nothing
consumes yet:

- **AES keys** for every build 7.10 → 19.01, primary and per-chunk (`Fortnite-Aes-Keys-Archive`)
- **POI/location lists** for 192 builds across Chapters 1–7 (`fortnite-archives`)
- **playlists, cosmetics, shop history** (`Fortnite-Datamining`)

These are recorded as `VERSION_SPECIFIC` / `CONFIRMED` rows with no implementation. They are the
cheapest first extensions the moment a second build becomes a real target.

---

## 7. The 7.40 baseline is protected

7.40 is the only experimentally validated target. `src/version/version.test.ts` drives the real route
handlers with the real 7.40 User-Agent and asserts:

- the timeline advertises `seasonNumber: 7`, `athenaseason7`, the S7 and LobbySeason7 flags and a
  S7-specific LTM flag — and that **no S8 flag leaks in**
- the lobby background is `lobbyseason7`
- **every playlist offered exists in the 7.40 client binary** — offering a name the build lacks is
  how a matchmaking option silently disappears
- `versioncheck` is `{"type":"NO_UPDATE"}`, `enabled_features` is `[]`
- both keychain GUIDs are unchanged
- a request with no User-Agent still gets a usable season rather than 0 or null

**Verified to have teeth by mutation:** forcing the timeline back to a hardcoded season 8 fails the
suite. A test that has never been run against the broken code is a hypothesis, not a test.

---

## 8. Adding a second target build

The order that keeps the baseline safe:

1. Get the client binary. Run `tools/binscan.js` for the questions the table marks `UNKNOWN` for that
   era — playlists, field presence, endpoint fragments.
2. Add rows to `features.ts` with the evidence and an honest confidence. Do not add an implementation
   yet.
3. Add the era to a golden test like the 7.40 one, asserting what that build must receive.
4. Only then branch behaviour — reading the table, never `if (major >= n)` at the call site.
5. Re-run the 7.40 baseline. If it moved, the change is wrong.

**The hard limit, stated plainly.** `Cobalt.dll` and `Project Reboot.dll` resolve engine offsets by
signature scan against 7.40 specifically. A second build needs its own offsets. That coupling is
**not** expressible as a backend version adapter, and no amount of work in `src/version/` addresses
it. The backend can be made version-aware; the native components have to be ported.
