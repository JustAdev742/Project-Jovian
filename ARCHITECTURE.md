# ARCHITECTURE

Verified 2026-08-15 (audit) and re-verified 2026-08-31. Everything below was read out of source or
observed at runtime; inferences are labelled.

---

## 1. The two deployment modes

The same `Main backend` binary runs in both. `NOVA_COORDINATOR` is what decides which.

### Standalone / LAN — `NOVA_COORDINATOR` unset

```
Fortnite client  ──(curl hook)──►  Main backend :3551  ──►  local gameserver :7777
   + Cobalt.dll                     (serves everything itself)
```

### Global P2P — `NOVA_COORDINATOR` set (the live configuration)

```
   Fortnite client                                  Fortnite gameserver (2nd instance)
   + Cobalt (as GFSDK_Aftermath_Lib.x64.dll)        + Project Reboot.dll
        │  curl_easy_setopt hooked; every                 │  GameNetDriver  :7777
        │  *.ol.epicgames.com → 127.0.0.1:3551            │  IpNetDriver    :7776
        ▼                                                 ▲
   nova-proxy  127.0.0.1:3551 ─── HTTP + WS upgrade ──────┤
        │
        ├─ /nova/api/host/*, /nova/api/logs, /nova/api/components  ─►  host agent 127.0.0.1:3552
        │     (kept LOCAL — proxy.js:37 LOCAL_PREFIXES)                (Main backend, NOVA_COORDINATOR set)
        ▼
   coordinator  https://clientfinder.tail0a8fd0.ts.net:8443
   (Linux; Main backend via `tsx src/index.ts`; NOVA_HOST_ELECTION=1)
```

**The split is the thing to understand.** Host-control traffic and game traffic take *different
paths*: the coordinator is reachable over the public internet through Tailscale Funnel, but the game
socket needs actual tailnet membership. A machine can therefore announce itself as a host, be
elected, and register an address no player can route to. That was the confirmed cross-machine
failure of 2026-08-15 (see [KNOWN_ISSUES.md](KNOWN_ISSUES.md) §Closed).

### Corrections to older diagrams — all verified

1. **Cobalt is not injected.** It is installed by *file replacement*: `carter.rs:604-680` copies
   `Cobalt.dll` over `Engine/Binaries/ThirdParty/NVIDIA/NVaftermath/Win64/GFSDK_Aftermath_Lib.x64.dll`.
   Only Reboot is injected (`host.rs:239`, via `injrs`).
2. **`FortniteGame.log` is not in the build folder.** It is in
   `%LOCALAPPDATA%\FortniteGame\Saved\Logs\`. Three launcher self-check codes look in the wrong place
   and have therefore never had data.
3. **The coordinator runs source, not `dist/`.** `node_modules/.bin/tsx src/index.ts`; there is no
   `dist/` on the box.

---

## 2. Backend service map

`Main backend/src` — 9,963 lines of TypeScript, Fastify 4, better-sqlite3.

| module | lines | role | reached by 7.40? |
|---|---:|---|---|
| `services/matchmaking/matchmaking.routes.ts` | 1,473 | tickets, host election, gameserver registry, mesh announce | **yes** |
| `services/eos/eos.routes.ts` | 1,352 | EOS translation layer | **no** — 7.40 is an MCP build |
| `database.ts` | 999 | SQLite access | yes (indirectly) |
| `services/xmpp/xmpp.server.ts` | 747 | XMPP over WebSocket; parties, presence, MMS | yes |
| `services/social/social.routes.ts` | 616 | friends, blocklist, timeline, versioncheck, enabled_features | **yes** |
| `services/mcp/profiles/athena.ts` | 600 | Athena profile construction | **yes** |
| `services/matchmaking/hostRunner.ts` | 420 | spawns/watches the local gameserver | yes (host only) |
| `services/auth/auth.routes.ts` | 337 | OAuth token, verify, sessions/kill, account lookup | **yes** |
| `services/mcp/mcp.routes.ts` | 304 | MCP operation switch (`client` / `dedicated_server` / `public`) | **yes** |
| `services/cloudstorage/cloudstorage.routes.ts` | 243 | system + user config files, hotfixes | **yes** |
| `services/nova/*` | ~400 | launcher-facing: logs, components, news, **diagnostics** | launcher only |
| others | — | anticheat, stats, storefront, entitlement, compat, lightswitch, validation | mixed |

**Route registration order matters** (`index.ts`): auth → launcher → mcp → lightswitch → storefront →
cloudstorage → matchmaking → social → entitlement → stats → eos → nova → anticheat → compat. Fastify
rejects duplicate paths, so this order is a de facto conflict record.

---

## 3. Request lifecycle

```
onRequest: versionRouter        parses Release-x.y / CL-n from User-Agent → request.gameVersion
onRequest: request logger       [HTTP] <method> <redacted url>   (skips /nova/api/logs|components|diagnostics)
           route handler        or …
setNotFoundHandler              GET → 200 {} · other → 204   AND records a MISSING diagnostic
setErrorHandler                 thrown errors → Epic error envelope AND a classified diagnostic
utils/error-handler.ts          deliberate errors (401/404/…) → Epic envelope AND a classified diagnostic
```

**`sendEpicError` bypasses `setErrorHandler`** — it calls `reply.send()` directly rather than
throwing. That is why the diagnostics hook lives in *both* places; instrumenting only the Fastify
error handler would have missed every 401 and 404 the backend deliberately returns.

### The catch-all, and why it stays

An unrouted `GET` returns `200 {}` and an unrouted `POST` returns `204`. This is indistinguishable
from a real empty response, and it has cost this project a great deal of debugging time. **It is
still correct behaviour** — the client treats a 404 on several of these paths as fatal.

The fix was not to start erroring but to make the silence countable: see §5.

---

## 4. Persistence

SQLite via `better-sqlite3` at `Config.DB_PATH` (`Main backend/data/nova.db`), overridable with
`NOVA_DB_PATH`. Profiles and cloudstorage are files under `Main backend/data/`.

A shim reproduces sql.js's `run`/`exec` signatures and its `[{columns, values}]` result shape, so the
~78 call sites and 17 importing files did not have to change when the engine was swapped. WAL,
`synchronous = NORMAL`, `foreign_keys = ON`, statements cached by SQL text.

**Concurrent access — answered 2026-08-31, measured rather than reasoned about.** Two processes on
one database file, 400 write cycles each:

| | result |
|---|---|
| corruption | **none** — `integrity_check: ok`, all 800 rows present |
| `SQLITE_BUSY` | **zero** — better-sqlite3 defaults to a 5,000 ms busy timeout, and WAL lets readers run during a write |
| lost updates | **393 of 800** — read-modify-write, now fixed; re-measured at 800/800 |

So the storage layer is safe to share; the application logic on top of it was not. Details in
[REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) NOVA-AUDIT-009. The realistic way two processes end up
sharing the file is not the coordinator at all — it is `backend-eaddrinuse-zombie`, a second backend
that loses the port race and keeps running with the database open.

**Timestamp formats are mixed, and this is a trap.** Columns written from JavaScript hold ISO-8601
(`2026-05-02T12:43:34.000Z`); columns using the `datetime('now')` default hold SQLite's format
(`2026-05-02 08:43:34`). They differ at character 10 — `T` versus a space — and `T` sorts *above* a
space, so comparing the two in SQL silently misorders any pair falling on the same date. **Compare
ISO columns against a JS ISO string, never against `datetime('now')`.**

**Indexing is adequate and was checked, not assumed.** Every hot lookup is covered: the tables keyed
`(account_id, …)` get an implicit index whose leading column is `account_id`, so `WHERE account_id = ?`
uses it. Three explicit indexes exist on `launcher_accounts`. The only unindexed scans are
`accounts.display_name`, `match_history.session_id`, `anticheat_flags.account_id` and
`player_stats.stat_name` (the leaderboard) — all trivial at present scale, and the leaderboard is the
one that grows with players × stats.

**Growth is bounded** for `telemetry` (pruned to the newest 5,000) and now for `tokens` (expired rows
purged on each new token — 201 rows, 100% expired, oldest four months old, before that was added).
`anticheat_flags` is append-only and unbounded in principle, though it only grows on detections.

---

## 5. Diagnostics (added 2026-08-31)

Two surfaces, deliberately different in kind:

| | `GET /nova/api/logs` | `GET /nova/api/diagnostics` |
|---|---|---|
| shape | append-only ring buffer, 800 entries | aggregated map, 400 distinct problems |
| retention | **under 3 minutes** at the measured peak (289 req/min) | until evicted by 400 *distinct kinds* of problem |
| repeats | each occurrence evicts something older | increment a counter |
| categories | none — free text | `MISSING`, `FAILED`, `AUTH_FAILURE`, `INTERNAL_ERROR`, `TIMEOUT`, `VERSION_MISMATCH`, `INVALID_RESPONSE`, `UNEXPECTED_STATE`, `NETWORK_FAILURE`, `UNKNOWN` |
| per-version | no | yes — `gameVersion` is part of the key |
| secrets | **redacted at source** since 2026-08-31 | never stored |
| affected by being read | **was** — now excluded from logging | no |

`services/nova/diagnostics.ts` owns the store, the redaction, the route normalisation and the
severity model. The severity formula is documented and calibrated in that file; it is deliberately
**not** a raw occurrence count, so 1,000 telemetry misses cannot outrank a matchmaking outage
affecting three players.

Reading it changes nothing and costs nothing: `recordDiagnostic` is wrapped in `try/catch` and can
never fail a request.

---

## 6. Native components

| component | what it is | how it is installed | notes |
|---|---|---|---|
| `Cobalt.dll` | curl redirect shim (MinHook + Memcury) | **file replacement** over `GFSDK_Aftermath_Lib.x64.dll` | hooks `curl_easy_setopt`; rewrites `*.ol.epicgames.com` → `127.0.0.1:3551` |
| `Project Reboot.dll` | game-server enabler for 7.40 | **injected** (`host.rs:239`, `injrs`) | listens `:7777` (GameNetDriver) and `:7776` (IpNetDriver) |
| `nova-proxy` | Node HTTP/WS splitter | run by the launcher | `LOCAL_PREFIXES` keeps `/nova/api/host/*`, `/nova/api/logs`, `/nova/api/components` on the local agent |

Both DLLs are 7.40-specific: they resolve engine offsets by signature scan, so a different build
would need different offsets. This is the project's hardest version coupling and it is **not**
expressible as a backend version adapter.

---

## 6a. Where the backend code actually runs — three copies, and they are not the same

Added 2026-09-05, after finding that a fix could be true in all the places anyone looks and still not
be true on a player's machine.

| copy | what runs | how it updates | current? |
|---|---|---|---|
| coordinator (`~/nova-backend`) | `tsx src/index.ts` — **sources** | `git pull` on the box | always |
| dev tree (`Main backend/`) | `tsx src/index.ts` via `npm run dev` | you are editing it | always |
| **installer payload** (`Launcher/src-tauri/resources/Backend-Coordinator/dist`) | **compiled JS** | staged into the installer at build time | **only if staged** |

`start_backend` (`main.rs:156-168`) prefers `dist/` over sources, so on an installed launcher the
third copy is what runs as the local host agent. It went 35 days stale and shipped through nine
releases missing three P1 fixes — see [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) NOVA-AUDIT-013.

```bash
node tools/stage-backend.mjs           # compile + stage
node tools/stage-backend.mjs --check   # exit 1 if the payload is behind the source
```

**The rule this establishes:** "fixed in source" and "fixed for players" are different claims in this
project, and [KNOWN_ISSUES.md](KNOWN_ISSUES.md) now separates them.

**Reachability, which bounds how much any of this matters.** `Config.HOST` is hard-coded to
`127.0.0.1` (`config.ts:33`). Neither the host agent nor a standalone backend is reachable off the
machine, so a defect that lives only in the payload needs code already running on that PC.

**The coordinator is the exception, and running sources did NOT mean it was current.** Corrected
2026-09-05 after checking the box rather than reasoning about it: `~/nova-backend` is not a git
checkout — it was populated by file copy — so "runs `tsx src/`" only means it runs whatever sources
were last copied there. It had the 2026-08-15 work and **none** of the 2026-08-31 work: no
`diagnostics.ts`, no `latent.routes.ts`, no URL redaction, and no friends ownership guard. Since
Tailscale Funnel publishes `:8443 → 127.0.0.1:3551` to the open internet, that last one was a live
remotely-reachable P1, not a bounded local one.

Deployed and verified 2026-09-05; see [coordinator/README.md](coordinator/README.md) for the
procedure and the probes that check it landed.

---

## 7. Known structural weaknesses

Carried forward with their grades; none changed in this session.

- **No capability floor in host election** (`matchmaking.routes.ts:418-423`) — a very weak machine
  can be elected. CONFIRMED.
- **`MH_EnableHook((PVOID)0)` is `MH_ALL_HOOKS`** (`dllmain.cpp:304-312`) — a failed signature scan
  silently enables every hook instead of failing. CONFIRMED, and a genuinely dangerous idiom.
- **Reboot's `crash.log` records survived first-chance exceptions** — a VEH cannot know whether a
  fault was fatal, so crash triage from that file cannot distinguish a crash from a handled
  exception. CONFIRMED.
- **`backend-eaddrinuse-zombie`** (`index.ts`) — a backend that loses the port race logs the error
  and keeps running with no HTTP surface. CONFIRMED.
- ~~**Version adapters do not exist.**~~ **Addressed 2026-09-05.** `src/version/` now holds a
  corpus-derived build registry, confidence-carrying version identification, and a compatibility
  table that computes SUPPORTED vs IMPLEMENTED rather than asserting it. See
  [CROSS_VERSION_ARCHITECTURE.md](CROSS_VERSION_ARCHITECTURE.md). What remains is not
  architecture but **evidence**: most non-Chapter-1 rows are UNKNOWN because the corpus grades
  its own Chapter 2-4 material as inference. And the native components stay 7.40-only — Cobalt
  and Reboot resolve offsets by signature scan, which no backend adapter can address.
