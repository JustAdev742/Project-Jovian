# 00 — Codebase audit (Phase 0, 2026-11-08)

What exists today, how healthy each part is, and the structural limits the ecosystem phase has to
work within. Grades follow the repo convention: **verified** = seen working in a played session or
an end-to-end test with real processes; **tested** = automated tests only; **claimed** = code exists,
nobody has watched it work. The five research reports (01–05) go deeper on their areas; this file is
the map.

Sources: the evidence-graded docs at the repo root (ARCHITECTURE, KNOWN_ISSUES, CROSS_VERSION_STATUS,
AUDIT_REPORT), `node doctor/nova-doctor.mjs` (scan + verify, 2026-11-08), the first played session on
1.9.4 (2026-11-08), and a structural inventory of the source.

## The shape of the system

```
player PC                                                       coordinator (Linux, home box)
┌──────────────────────────────────────────────┐               ┌─────────────────────────────┐
│ Nova launcher (Tauri 1.5, React)             │  HTTPS/WSS    │ Main backend (tsx src/)     │
│  ├─ host agent  = Main backend, compiled ────┼──── Funnel ──▶│  accounts, MCP, XMPP,       │
│  ├─ nova-proxy  (game → coordinator)         │   :8443 TCP   │  matchmaking + election,    │
│  ├─ nova-doctor live                         │               │  admin + fleet dashboards   │
│  └─ Fortnite 7.40 client + Cobalt.dll        │               └─────────────────────────────┘
│      headless 7.40 server + Project Reboot   │◀── Tailscale (UDP 7777) ── other players' clients
└──────────────────────────────────────────────┘
```

The real game client draws the lobby, locker, shop, battle pass, friends and parties itself. Nova's
job is to answer the services those screens call, and to run matches (Reboot). That is why most of
the ecosystem phase is backend and game-server work, not launcher UI.

## Inventory and health

| Component | Size | Works (verified) | Partial / claimed | Broken / missing |
|---|---|---|---|---|
| **Launcher** (Tauri 1.5 + React; screens Home, Library, Account, Logs, SelfCheck, Settings, SignIn; Rust: carter, host, tailscale, anticheat, bumper, discord, diagnostics, diagreport, doctor, ue4log, net) | ~1,260 lines of screens, `useLauncher.ts` ~1,000 | sign-in, launch, on-demand hosting, signed auto-update, diagnostics forwarding, fleet doctor (1.9.4) | build library holds ONE build | no social panel, party UI, events, votes, news, progression, voice, season picker |
| **Backend / coordinator** (Fastify + better-sqlite3) | auth 17 routes, social 54, compat 59, eos 88, matchmaking 21, nova 23, doctor 9, stats 7, entitlement 5, cloudstorage 5, anticheat 5, storefront 2, lightswitch 2, mcp 3 (an operation dispatcher), achievements 0 | login, lightswitch, cloudstorage hotfix, MCP QueryProfile/ClientQuestLogin, equipped cosmetics applied in a match, matchmaking + P2P host election, XMPP presence, admin + fleet dashboards | locker content is a **hand-curated list of ~335 cosmetic IDs** (`services/mcp/profiles/athena.ts`), not what the build contains; quests/battle pass, friends, party, shop: depth unmeasured → report 01 | achievements has no routes; stats minimal |
| **Cross-version layer** (`src/version/`: builds, identify, features, cosmetics) | tested | 4 endpoints vary correctly by build (timeline stage, chunk keys, enabled_features, locker era) | most Chapter 2–4 rows UNKNOWN: "the gap is evidence, not effort" (CROSS_VERSION_STATUS) | native components are 7.40-only (below) → report 02 |
| **Project Reboot** (game server DLL, C++ ~13.5k lines) | processevent 2.7k, helper 1.9k, server 1.3k, inventory 1.2k, loot 1.1k, events 730 | 7.40 hosting, loot, building/editing, storm, bus, match-end auto-restart (played 2026-09-19 / 11-08) | phantom-host fix, 60 Hz, 2s travel (1.9.5, unplayed); teams/modes depth → report 03; events.cpp → report 05 | signature-scanned for 7.40 only; 284 `GetOffset` sites read the vtable on a 0 offset (P2); `MH_EnableHook(0)` = all hooks on a failed scan |
| **Cobalt** (client DLL: redirect, SSL, bumper) | — | redirect, bumper (1.8.3+) | — | 7.40 signatures only; import table capped at 9 DLLs |
| **nova-proxy** | 1 file | game → coordinator in global P2P | — | — |
| **nova-doctor** | — | scan/verify/repair, live mode, fleet dashboard (1.9.4) | — | — |

## Test assets

backend 300 tests (`npm test`), doctor 58, launcher ue4log 26, the Cobalt emitter test, a 22-request
7.40 session replay (e2e probe), and `tools/fleet-e2e.mjs` (coordinator + agent + live doctor with
real processes). No CI; `node doctor/nova-doctor.mjs verify` runs all of it locally.

## Structural limits the ecosystem phase must respect

1. **Native code is per-build.** Reboot and Cobalt find game functions by signature scan of the
   7.40 binary. Every new season is game-server and redirect work, not just backend responses, and
   needs that build on disk to test.
2. **One coordinator on home hardware, published through Tailscale Funnel (TCP only).** No inbound
   UDP from the internet: voice relays (TURN) and anything real-time must work over TCP/TLS or over
   the tailnet. The box has a flapping Ethernet link (ARCHITECTURE §1, memory).
3. **Accounts are cheap.** One account per person is not enforced, so community votes need a weight
   or eligibility rule (e.g. accounts that have played) to mean anything.
4. **The game draws its own UI.** In-game features are delivered by answering the game's services
   correctly; launcher features are Nova's own design and must not copy Epic's art or branding.
5. **Data:** player profiles and locker state live in SQLite (`data/nova.db`) on each backend; the
   coordinator's copy is the one other players see.
6. **Host election has no capability floor** (ARCHITECTURE §7): a weak machine can be elected, which
   matters more once pre-warm (1.9.5) starts servers before anyone queues.

## Known open problems carried in (KNOWN_ISSUES)

- `gameserver-register-unauthenticated` (accepted open, step one live)
- `nova-303-request-escape` (a request escaping Cobalt to Epic's live servers; seen again 2026-11-08)
- `coordinator-local-control-routes-public` (8 routes without auth on the coordinator)
- `worldinventory-race-at-spawn` (self-heals; 56 warnings per spawn)
- unplayed: `phantom-host-player`, `cold-start-join-wait`, `server-net-30hz` (1.9.5)
