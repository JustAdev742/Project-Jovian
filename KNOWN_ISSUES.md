# KNOWN_ISSUES

Living register. Grades are evidence grades, not confidence-in-severity.
Sources: `AUDIT_REPORT.md` (2026-08-15, adversarially verified) and the 2026-08-31 pass.

**How to read this:** an entry marked CONFIRMED has a positive signal behind it, taken with a control
in the same run. An entry marked PLAUSIBLE was reported by a reviewer but never independently
reproduced — 5 of 8 claimed P1s in the 2026-08-15 audit did **not** survive scrutiny, so treat
anything unverified as a lead.

---

## Open — P1

### `gameserver-register-unauthenticated` · CONFIRMED · accepted open
`matchmaking.routes.ts:953,1001` gate registration on
`if (Config.REGISTER_SECRET && b.secret !== Config.REGISTER_SECRET)`, and `config.ts:110` defaults
the secret to `''` — **an empty secret skips the gate entirely.** Confirmed absent from the live
coordinator's `.env` and `/proc/<pid>/environ`. `/nova/api/gameserver/register` sets the address every
player is routed to.

**Why it is still open:** no available fix fails safe. Making the gate fail closed breaks hosting on
every launcher in the field until each one is updated to send the secret. That is a deployment
decision, not a code decision.

**The clean fix, when a release is being cut anyway:** have the coordinator serve
`NOVA_REGISTER_SECRET` to authenticated launchers the same way it already mints Tailscale keys
(`/nova/api/tailnet-authkey`), *then* flip the gate.

---

## Open — P2

| id | grade | location | issue |
|---|---|---|---|
| `selfcheck-wrong-gamelog-path` | CONFIRMED | `diagnostics.rs:317-327` | Looks for `FortniteGame.log` in the build folder; it lives in `%LOCALAPPDATA%`. NOVA-301/303/305 have never had data. |
| `backend-eaddrinuse-zombie` | CONFIRMED | `index.ts` | A backend that loses the port race logs it and **keeps running** with no HTTP surface. |
| `port-checks-have-no-identity-probe` | CONFIRMED | `diagnostics.rs:94-102` | NOVA-201/202 pass on a bare TCP connect, so a stale backend reads as healthy. |
| `minhook-null-aliases-all-hooks` | CONFIRMED | `dllmain.cpp:304-312` | `MH_EnableHook((PVOID)0)` **is** `MH_ALL_HOOKS`; a failed signature scan silently enables everything. |
| `cobalt-reports-success-unverified` | CONFIRMED | `Cobalt/dllmain.cpp:468-483` | Prints "initialised successfully" without checking the hook installed. |
| `cobalt-logs-bearer-tokens` | CONFIRMED | `curlhook.h:80`, `log.cpp:73-88` | `eg1~` JWTs written to `cobalt.log` and POSTed to the backend. **Backend half fixed 2026-08-31; the Cobalt half is still open** — see NOVA-AUDIT-001. |
| `trap8-systemic-unguarded-offsets` | CONFIRMED | `structs.cpp:414-422` | Offset-0-means-failure unchecked at most assignment sites (257 of 299 with no in-file zero-check). |
| `mcp-rvn-from-client` | CONFIRMED | `mcp.routes.ts:20-31` | Revisions computed from the client's `rvn` query param rather than stored state. Latent on 7.40 — see [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §3. |
| `common-core-stateless-rvn` | CONFIRMED | `common_core.ts:80,122` | `rvn`/`commandRevision` hard-coded to 1, never persisted. |
| `ws-root-path-fabricates-matchmaking` | CONFIRMED | `xmpp.server.ts:186-217` | Any WS upgrade to `/` without the `xmpp` subprotocol registers a matchmaking waiter. |
| `no-capability-floor` | CONFIRMED | `matchmaking.routes.ts:418-423` | No floor below which a machine is never elected host. |
| `unauth-route-families` | PLAUSIBLE | `eos.routes.ts` (88 routes, 0 `requireAuth`), `social.routes.ts` (49 routes, 0) | Same shape as the fixed MCP finding, reaching `addFriend`/`removeFriend`/`writeFileSync`. **Never probed.** `eos.routes.ts` is not on 7.40's path; `social.routes.ts` is. |

## Open — P3

| id | grade | location | issue |
|---|---|---|---|
| `harvesting-wrong-property-name` | CONFIRMED | `harvesting.cpp:109-114` | Four offset lookups ask for `"InstigatedBy"` where the variable names say `DamageCauser`/`Damage`. Cars likely yield no materials (PLAUSIBLE, not observed). |
| `clientquestlogin-grants-nothing` | CONFIRMED | `mcp.routes.ts:57-64` | Aliased to QueryProfile, so quest state is never created. 57 calls per session. |
| `stale-dist-preferred` | CONFIRMED | `main.rs:156-168` | `start_backend` prefers `dist/` over sources. |
| `launcher-evidence-is-self-erasing` | CONFIRMED | `main.rs:174-188` | `nova-agent.log` truncated on every start; proxy has no log at all. |
| `firewall-result-discarded` | CONFIRMED | `tailscale.rs:269-289` | Firewall-rule result discarded at both call sites; error read from the wrong stream. |
| `nova-307-dead-check` | CONFIRMED | `diagnostics.rs:384-414` | Greps `cobalt.log` for a string only ever written to `nova-agent.log`. |
| `cobalt-stamp-frozen` | CONFIRMED | `log.cpp:326` | Banner stamp is `log.cpp`'s compile time, so two different binaries self-identify identically. |
| `config-comment-stale` | CONFIRMED | `config.ts:96-105` | Asserts `WarmupWaitSeconds = 90s`; `definitions.h:73` is now `45.f`, making the documented "~30s of headroom" negative. **Comment only — do not "fix" the value**, see below. |
| `join-window-anchor` | CONFIRMED | `matchmaking.routes.ts` | The join window is stamped when a ticket first finds a registered gameserver, not when the server reports warmup start. Pre-existing; the wrong anchor is the real defect. |
| `bundled-hotfix-wrong-xmpp-port` | CONFIRMED, latent | `resources/…/cloudstorage/DefaultEngine.ini:3-4` | Bundled hotfix hard-codes `ws://127.0.0.1:3596`. Not live in P2P mode (cloudstorage always comes from the coordinator); would bite in standalone/LAN. |
| `dependency-hygiene` | CONFIRMED | `Launcher/src-tauri/Cargo.toml`, `Launcher/package.json` | `mongodb = "2.8"` has **zero** usages in `src-tauri/src/`; `electron` has zero imports in `Launcher/src`; `warp` is used only for one `impl Reject`. Build weight only, no runtime effect. Not removed — verify against a full build first. |

---

## Do not "fix" these

Recorded because each has already been proposed and rejected on evidence.

- **The 45 s warmup vs 60 s join window.** Shrinking `JOIN_WINDOW_MS` looks obviously right and is
  wrong. `hasLiveGameServer()` feeds both the MMS release and `decideHost`; a shorter window means
  the next player to press Play is **elected host and spins up a second server** instead of joining
  the live one. On a two-person server that converts "B is a bit late" into "A and B never play
  together". It cannot fail safe. Fix the stale comment, not the value.
- **Returning 404 from the not-found handler.** The `200 {}` / `204` shapes are load-bearing. The
  cure for the invisibility is the diagnostics store, not an error.
- **Gating `dedicated_server` behind `REGISTER_SECRET`.** It defaults to `''` and the established
  idiom `if (Config.REGISTER_SECRET && …)` **fails open**, so this closes the finding while leaving
  the route open.

---

## Closed

### `mesh-wrong-tailnet` · CONFIRMED · FIXED 2026-08-15
The launcher decided "connected to the mesh" by testing whether its IP starts with `100.`
(`tailscale.rs:162`). `100.64.0.0/10` is shared CGNAT space, so a machine on *someone else's* tailnet
passed, announced itself, won election, and registered an address nobody could route to. Proven with
a control: `tailscale ping` to the working PC returned a pong in 1 ms; to the laptop, "no matching
peer". Fixed coordinator-side by checking announced addresses against the authoritative Tailscale
device list, **failing open** if the API key is absent or the API is unreachable, and logging once
when verification is off.

### `mcp-unauth-mutation` · CONFIRMED · FIXED 2026-08-15
The `dedicated_server` and `public` MCP route families dispatched the full mutating operation switch
with no auth. Reproduced against a scratch database: an unauthenticated POST rewrote another
account's locker and persisted it; another moved its currency; a third created a profile on disk for
an account that had never registered. Fixed with a `readOnly` mode returning a well-formed empty
envelope. Deployed to the live coordinator and confirmed by positive signal with a control.

### NOVA-AUDIT-001 — `logs-serve-live-bearer-tokens` · CONFIRMED · FIXED 2026-08-31
See [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md).

### NOVA-AUDIT-002 — `diagnostics-evicted-before-readable` · CONFIRMED · FIXED 2026-08-31
### NOVA-AUDIT-003 — `reading-the-log-pollutes-the-log` · CONFIRMED · FIXED 2026-08-31
### NOVA-AUDIT-004 — `deliberate-errors-never-classified` · CONFIRMED · FIXED 2026-08-31

---

## Cannot be answered from current evidence

1. **Anything about the laptop.** No laptop artifact has ever been examined. Every cross-machine
   claim is a mechanism read out of PC-side code.
2. **Whether a two-machine session has ever worked.** The only end-to-end success on record is the PC
   connecting to *itself* over its own tailnet address.
3. **Whether `social.routes.ts` / `eos.routes.ts` are exploitable in practice.** Not probed.
4. **Whether the coordinator and a host agent can open the same `DB_PATH` concurrently.**
   `database.ts` (999 lines) has never been audited.
5. **Whether 7.40 sends the `xmpp` WebSocket subprotocol.** The header was never observed, which
   leaves `ws-root-path-fabricates-matchmaking` unresolved.
6. **Endpoint coverage for flows the six retained sessions never exercised.** Now self-answering —
   `GET /nova/api/diagnostics?category=MISSING`.
