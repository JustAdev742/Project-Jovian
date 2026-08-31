# VERSION_COMPATIBILITY

**Target build: Fortnite 7.40 (Chapter 1 Season 7, CL-5046157).**
Last measured: 2026-08-31. Evidence grades are per [AUDIT_PROMPT.md](AUDIT_PROMPT.md) Rule 4:
CONFIRMED · STRONGLY SUPPORTED · INFERRED · SPECULATIVE · UNKNOWN.

---

## 1. What the client actually is — CONFIRMED

7.40 is an **MCP / OSS build, not EOS**. This is decided by the client's own log, not by inference:

| symbol in `FortniteGame.log` | count |
|---|---|
| `FOnlinePartySystemMcp` | 54 |
| `FOnlineIdentityMcp` | 6 |
| `OnlineSubsystemMcp` | 1 |
| `EOS_Initialize` / `EOS_Platform` / `ProductUserId` | **0** |

**Consequence for this project:** the 1,352-line `eos.routes.ts` is **not on 7.40's path**. It is
dead weight for the target build and live only for whatever else might call it. Do not "fix 7.40" by
changing EOS routes — nothing in 7.40 reaches them.

> The backend banner still prints *"Full EOS Translation Layer"* (`index.ts`). For the target build
> that is misleading. Cosmetic; recorded rather than changed.

---

## 2. The complete 7.40 HTTP surface, as observed — CONFIRMED

Method: every `URL:` line from `cobalt.log` (3,533 lines, 6 launches, 2026-07-25 → 2026-08-15),
account ids and session tokens normalised, then matched against every route the backend registers
(213 route definitions extracted from `Main backend/src`).

**Result: 34 distinct endpoint families. Every one of them is routed. Zero unrouted.**

This is the single most useful negative result available right now, and it redirects effort:

> **7.40 does not fail because an endpoint is missing.** Any remaining 7.40 problem is a *response
> correctness*, *state*, or *transport* problem — not a coverage problem.

| # | endpoint (normalised) | calls | backend route | subsystem |
|---|---|---:|---|---|
| 1 | `POST /datarouter/api/v1/public/data` | 706 | `/datarouter/api/v1/public/data` | telemetry |
| 2 | `GET /account/api/oauth/verify` | 482 | exact | auth |
| 3 | `POST /fortnite/api/game/v2/profile/{acct}/client/QueryProfile` | 229 | `…/client/:operation` | mcp |
| 4 | `GET /lightswitch/api/service/bulk/status` | 138 | exact | lightswitch |
| 5 | `POST /account/api/oauth/token` | 128 | exact | auth |
| 6 | `GET /fortnite/api/v2/versioncheck/Windows` | 107 | `…/versioncheck/:platform` | other |
| 7 | `GET /fortnite/api/cloudstorage/system` | 107 | exact | cloudstorage |
| 8 | `GET /content/api/pages/fortnite-game` | 85 | exact | other |
| 9 | `GET /fortnite/api/game/v2/chat/{acct}/reserveGeneralChatRooms/Athena/pc` | 81 | parameterised | social |
| 10 | `DELETE /account/api/oauth/sessions/kill/{token}` | 76 | `…/kill/:token` | auth |
| 11 | `GET /fortnite/api/game/v2/enabled_features` | 69 | exact | other |
| 12 | `GET /account/api/public/account` | 65 | exact | auth |
| 13 | `GET /friends/api/public/friends/{acct}` | 64 | parameterised | social |
| 14 | `GET /fortnite/api/storefront/v2/keychain` | 64 | exact | storefront |
| 15 | `GET /fortnite/api/receipts/v1/account/{acct}/receipts` | 64 | parameterised | storefront |
| 16 | `GET /fortnite/api/cloudstorage/user/{acct}` | 64 | parameterised | cloudstorage |
| 17 | `GET /fortnite/api/cloudstorage/system/DefaultGame.ini` | 64 | `…/system/:filename` | cloudstorage |
| 18 | `GET /fortnite/api/cloudstorage/system/DefaultEngine.ini` | 64 | `…/system/:filename` | cloudstorage |
| 19 | `GET /fortnite/api/calendar/v1/timeline` | 64 | exact | calendar |
| 20 | `GET /account/api/public/account/{acct}/externalAuths` | 64 | parameterised | auth |
| 21 | `GET /account/api/public/account/{acct}` | 64 | parameterised | auth |
| 22 | `DELETE /account/api/oauth/sessions/kill` | 64 | exact | auth |
| 23 | `GET /friends/api/public/blocklist/{acct}` | 62 | parameterised | social |
| 24 | `GET /fortnite/api/storefront/v2/catalog` | 62 | exact | storefront |
| 25 | `GET /friends/api/public/list/fortnite/{acct}/recentPlayers` | 60 | parameterised | social |
| 26 | `GET /friends/api/v1/{acct}/settings` | 59 | parameterised | social |
| 27 | `POST /fortnite/api/game/v2/profile/{acct}/client/ClientQuestLogin` | 57 | `…/client/:operation` | mcp |
| 28 | `GET /fortnite/api/cloudstorage/system/DefaultRuntimeOptions.ini` | 48 | `…/system/:filename` | cloudstorage |
| 29 | `GET /fortnite/api/cloudstorage/system/DefaultInput.ini` | 48 | `…/system/:filename` | cloudstorage |
| 30 | `GET /api/v1/events/Fortnite/download/{acct}` | 37 | parameterised | other |
| 31 | `POST /fortnite/api/game/v2/matchmakingservice/ticket/player/{acct}` | 35 | parameterised | matchmaking |
| 32 | `GET /fortnite/api/cloudstorage/user/{acct}/ClientSettings.Sav` | 35 | `…/user/:acct/:filename` | cloudstorage |
| 33 | `POST /fortnite/api/game/v2/profile/{acct}/client/EquipBattleRoyaleCustomization` | 33 | `…/client/:operation` | mcp |
| 34 | `GET/POST /fortnite/api/matchmaking/session/{uuid}[/join]`, `…/game/v2/matchmaking/account/{acct}/session/{uuid}`, `statsv2/*` | 1 each | parameterised | matchmaking / stats |

### Limits of this result — read before relying on it

- It covers **only flows these six sessions exercised.** A code path never taken (a purchase, a
  friend request accepted, Save-the-World) would not appear. It is a floor on coverage, not a proof
  of completeness.
- It is the **HTTP surface only.** XMPP/WebSocket traffic is not in `cobalt.log`.
- Cobalt logs the URL it *redirects*. A request that escaped the hook (see NOVA-303 in
  [KNOWN_ISSUES.md](KNOWN_ISSUES.md)) would be absent from both the log and the backend.

**From 2026-08-31 this no longer has to be reconstructed by hand.** Any unrouted call is now recorded
as a `MISSING` diagnostic and readable at `GET /nova/api/diagnostics`. See
[ARCHITECTURE.md](ARCHITECTURE.md) §5.

---

## 3. Response shapes checked against authoritative documentation

Source: `FortniteEndpointsDocumentation` (LeleDerGrasshalmi) and the decompiled Retrofit service
interfaces in the supplied corpus (`FortnitePublicService.java` etc., Oct 2019). Cross-checked
against the implementation.

| endpoint | documented | Nova returns | verdict |
|---|---|---|---|
| `/fortnite/api/v2/versioncheck/:platform` | `{"type":"NO_UPDATE"}` (one of `NO_UPDATE`, `NOT_ENABLED`, `SOFT_UPDATE`, `HARD_UPDATE`, `APP_REDIRECT`) | `{"type":"NO_UPDATE"}` | **CONFIRMED correct** |
| `/fortnite/api/game/v2/enabled_features` | `[]` (2017 builds: `["store"]`) | `[]` | **CONFIRMED correct** |
| `/fortnite/api/receipts/v1/account/:id/receipts` | array | `[]` | **CONFIRMED correct** |
| `/fortnite/api/game/v2/profile/:id/client/:op` | MCP envelope | envelope with `profileRevision`, `profileChangesBaseRevision`, `profileCommandRevision`, `serverTime`, `responseVersion` | shape **CONFIRMED**; revision *semantics* are wrong, see below |

### Profile revisions — the one substantiated correctness defect

`mcp.routes.ts` derives the response revision from the **client's own `?rvn=` query parameter**
rather than from stored state, and `common_core.ts` hard-codes `rvn`/`commandRevision` to `1` and
never persists them. Epic's model is server-authoritative: the server owns the revision and the
client's value is an *if-none-match* hint.

- **Grade: CONFIRMED** (read directly in both files; carried from the 2026-08-15 audit as
  `mcp-rvn-from-client` and `common-core-stateless-rvn`).
- **Observed impact on 7.40: none.** 229 `QueryProfile` calls and 33 `EquipBattleRoyaleCustomization`
  calls completed and the locker persisted.
- **Why it still matters:** it is latent. Any operation that returns real `profileChanges` and
  expects the client to apply them incrementally depends on the revision being monotonic and
  server-owned. Today the profile is re-sent whole, which masks it.
- **Not fixed here.** It is a stateful change to the one subsystem 7.40 exercises most heavily, and
  it has no observed symptom to verify a fix against. Wrong place for an unforced change.

### Profile `version` string — INFERRED, harmless

`athena.ts` sets `version: 'nova_lawin_ch1s7'`; `common_core.ts` sets `'nova_backend'`. Real Epic
values are migration names (`fortnitemares_part4_fixup_oct_18` would be the era-correct one for a
Feb 2019 build — `ProfileVersions.md` in the corpus lists the full sequence). Nothing in the observed
sessions reacts to it. **Leave it**; a made-up value that no client validates is safer than a real
one implying migrations this backend does not perform.

---

## 4. Version handling in the code

`middleware/version-router.ts` parses `Release-(\d+)\.(\d+)` and `CL-(\d+)` from the User-Agent onto
`request.gameVersion`, falling back to `Config.SEASON_NUMBER` (7) when unparseable.

**This is the whole of the version model.** There are no version adapters, and `season` is set to
`major`, which is only true in Chapter 1. Beyond Chapter 1 that field is wrong by construction.

- For a 7.40-only deployment: **adequate**, and the fallback is correct.
- Before any second target build is added: `gameVersion` is the right hook, but the compatibility
  layers the brief asks for (`shared core + version adapters`) **do not exist yet**. Building them
  speculatively for builds nobody runs would be the "giant pile of conditional hacks" the brief warns
  against. The concrete prerequisite is a second build actually in use.

`gameVersion` is now also attached to every diagnostic event, so "which version" is answerable per
failure without adding a single conditional.

---

## 5. Chapters 1–4 — deliberately NOT modelled

The supplied `Research.txt` covers Chapters 1–4 and the live-event system. Its own Chapter 2–4
sections are explicitly self-graded as *inferred* with "no authoritative citations", and its live
events section says the activation mechanism "is not public".

Building a compatibility matrix for Chapters 2–4 from that would mean inventing endpoint
introduction/removal versions — exactly what Rule 5 forbids. **Status: UNKNOWN, deliberately.**

**What would change it:** per-build client binaries or logs (the `Fortnitebuilds` /
`all-fortnite-builds` links in `Links.txt`), from which the observed-surface method in §2 could be
re-run per build. That is a measurement task, not a writing task.

### Live events — UNKNOWN

Nothing in this backend implements event activation, and nothing in the corpus establishes the real
mechanism. `Research.txt` describes a plausible lifecycle (timeline flag → locked playlist → weapons
disabled → scripted sequence → world-state transition) but grades it as inference from player
observation. The `/fortnite/api/calendar/v1/timeline` endpoint 7.40 polls 64 times per session is the
real hook, and it is implemented and served.

**Recorded as UNKNOWN.** Reconstructing an event system from a description graded "speculative" would
produce confident wrong answers — the failure mode this project has paid for repeatedly.
