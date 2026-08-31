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
`NOVA_DB_PATH` — which is how every experiment in this audit avoided touching real player data.
Profiles and cloudstorage are files under `Main backend/data/`.

**UNKNOWN, and worth resolving:** whether the coordinator and a host agent can ever open the same
`DB_PATH` concurrently. `database.ts` was not audited. Flagged in the 2026-08-15 report and still
open.

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
- **Version adapters do not exist.** Adequate for a single-target deployment; a prerequisite for a
  second one.
