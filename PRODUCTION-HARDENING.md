# Project Nova — Production Hardening & Multiplayer Architecture

_Deliverable write-up for the production-quality pass (2026-07-19)._

This pass ran a **verified 41-finding audit** of the launcher + backend (parallel finders, each finding
adversarially re-checked against the code — 7 false positives were rejected and several severities
downgraded), then fixed the confirmed issues in compile-verified batches. Backend fixes are **deployed
and health-checked live** on the coordinator; launcher fixes land the next time you rebuild the launcher.

**Update (2026-07-20) — everything deferred above is now built.** The Tailscale auto-mesh is
implemented end-to-end (coordinator + launcher + Play flow), the two deferred launcher bugs are
fixed, and the **anti-cheat / anti-injection detection** you asked for after the P2P work is built,
tested and deployed. See §4, §6 and §7. The one thing still on you is placing the Tailscale auth key
(§4.1) — I never handle that token.

---

## 1. What changed and why

### Launcher — Rust (`Launcher/src-tauri/src/main.rs`, `carter.rs`)
| Change | Why it was necessary |
|---|---|
| Removed the duplicate `launch_real_launcher` call in `firstlaunch` | Every Play spawned `FortniteLauncher.exe` **twice** and doubled the kill/suspend sequence (`launch_fn` already runs it). |
| `generate_ranges` / download worker count guarded (`.max(1)`, `file_size==0`) | Divide-by-zero **panic** on 1-core machines or 0-byte responses. |
| Download worker error + join error handled (no `.unwrap()`) | A single failed download worker **panicked the whole app**. |
| Download stream error is now an error, not silent EOF | Mid-stream network drops produced **truncated/corrupt** files reported as success. |
| `dll_replace` retry loop bounded (50×100 ms, then error) | A locked `GFSDK_Aftermath` DLL (game still open) could **hang the launcher forever**. |
| `kill()` no longer `return`s on the first failed taskkill | One failure left the remaining game/anti-cheat processes alive. |
| `window_minimize` / `window_close` no longer `.unwrap()` | Panicked the command thread. |
| Backend path resolved via `NOVA_BACKEND_DIR` → walk-up-from-exe → fallback | Hardcoded `C:\Users\Admin\...` **broke on every other machine**. |
| Removed dead post-exit `solo::run()` | Unreachable/incorrect code after the blocking Tauri run. |

### Launcher — React (`onboard.tsx`, `StatusBar.tsx`, `LogViewer.tsx`, `login.tsx`, `settings.tsx`)
| Change | Why |
|---|---|
| `login.tsx`: stop persisting the **plaintext password** to localStorage; persist only the token | Security — the real access token is used everywhere; the password was an unnecessary secret at rest. Removed the dead always-true `remember` flag too. |
| `onboard.tsx` logout: `removeItem("user")` instead of `localStorage.clear()` + clears the host heartbeat | Logout was **wiping your whole build library + settings**, and leaking the registration heartbeat. |
| `onboard.tsx` launch poll: only clear `isLaunching` after the client was seen running (or a 60 s grace) | The poll cleared it on the first tick before the game process appeared, **re-enabling PLAY early → double-launch**. |
| `StatusBar.tsx`: the "start backend" interval is tracked in a ref + cleared on unmount | Leaked a timer and called `setState` on an unmounted component. |
| `LogViewer.tsx`: removed the dead, self-referential `online` state. |
| `settings.tsx`: removed the 13 stacked `<br/>` + the dead no-op "Settings" nav item. |

### Backend (`database.ts`, `index.ts`, `xmpp.server.ts`, `matchmaking.routes.ts`, `cloudstorage.routes.ts`, `stats.routes.ts`, `config.ts`)
| Change | Why |
|---|---|
| **DB persistence rewritten** (`database.ts`): debounced + atomic temp-file→rename + errors logged + flush-on-exit | Was a **full-image synchronous write on every mutation** (event-loop stall), non-atomic (crash mid-write = corrupt `nova.db`), and swallowed all errors. |
| Telemetry table bounded to 5000 rows; `statsv2/query` owner list capped at 100 | In-memory DB grew **without limit → OOM**; a request could trigger unbounded DB writes. |
| XMPP chat bodies **XML-escaped** before sending (`escapeXml`) | A crafted chat body could **inject arbitrary XMPP stanzas** to other clients. |
| **MMS timeout now closes the socket** (`xmpp.server.ts`) | The single worst bug: on a host-election timeout the client was **stuck on the matchmaking screen forever** — now it leaves with an error. |
| XMPP duplicate-account connections **drop the stale socket and admit the new one** (`dropExistingClient`) | A reconnect after a network blip was **refused** until the stale socket was reaped. |
| Empty MUC rooms deleted on last leave | Slow memory leak (one map entry per unique party room). |
| Cloudstorage file endpoint: reject path traversal, `statSync().isFile()`, async read, no 500 leak | Client-supplied filename → **directory traversal** + a directory name threw an unhandled 500. |
| Global error handler respects `statusCode`, hides internals on 5xx | Masked every error as 500 and echoed internal text. |
| Opt-in `NOVA_REGISTER_SECRET` gate on register/unregister | The public coordinator's registration endpoints were unauthenticated (routing-table poisoning). Off by default so nothing breaks; set the env + have the launcher send `secret` to enforce. |

**Compile status:** launcher `cargo check` = 0, launcher `tsc` = 0, backend `tsc` = 0.

---

## 2. Deployment status
- **Backend:** all of the above **plus the mesh and anti-cheat services are deployed to the
  coordinator** (`~/nova-backend`) and verified live — restarted cleanly on a single supervisor,
  listening on 3551, with `info` / `gameservers` / `should-i-host` / `register` /
  `mesh/announce` / `mesh/candidates` / `tailnet-authkey` / all four `anticheat/*` routes responding
  correctly and no startup errors.
- **Launcher:** Rust + React changes are in the source tree and **compile clean**
  (`cargo check` = 0, `tsc` = 0, `vite build` = 0). Rebuilt with `npx tauri build`.
- **Backups:** `Project Nova/_backup-prod-20260719-210404` plus earlier `_backup-*` folders.

### Files changed in this second pass
| File | Change |
|---|---|
| `Main backend/src/config.ts` | `TS_AUTHKEY`, `MESH_CANDIDATE_TTL_MS`, `MESH_ELECTION_GRACE_MS`, `AC_AUTOBAN_AT`, `AC_ADMIN_SECRET` |
| `Main backend/src/services/matchmaking/matchmaking.routes.ts` | Mesh candidate registry, `scoreCandidate`, `liveCandidates`, `meshIpFor`, capability-aware `decideHost`, 3 mesh endpoints, `tsIp` on `should-i-host` |
| `Main backend/src/database.ts` | `anticheat_flags` table + flag/risk/ban helpers, `getMatchMeta` |
| `Main backend/src/index.ts` | Registers `anticheatRoutes` |
| `Main backend/src/services/anticheat/anticheat.service.ts` | **New** — detection engine |
| `Main backend/src/services/anticheat/anticheat.routes.ts` | **New** — attest/report/risk/flags/ban |
| `Launcher/src-tauri/src/tailscale.rs` | **New** — install/join/IP/firewall/specs/announce/bring-up |
| `Launcher/src-tauri/src/anticheat.rs` | **New** — module enumeration + attestation |
| `Launcher/src-tauri/src/host.rs` | `HostDecision` gains `tsIp`/`betterHost`/`retryMs`/`score` (they were being silently dropped before reaching the UI) |
| `Launcher/src-tauri/src/main.rs` | Registers the 12 new commands |
| `Launcher/src-tauri/Cargo.toml` | winapi `handleapi` feature |
| `Launcher/src/onboard.tsx` | Mesh bring-up on login, auto-host flow, re-poll on `better-host-available`, attestation timer, `showError`, timer cleanup, render-function refactor, host panel simplified |

---

## 3. The multiplayer architecture

### Today (working)
```
Launcher ──HTTP──> coordinator (https://clientfinder.tail0a8fd0.ts.net:8443, Tailscale Funnel)
Game ──Cobalt──> local proxy 127.0.0.1:3551 ──HTTPS/WS──> coordinator      (login / MCP / matchmaking)
Host: Reboot server on UDP 7777 ── playit tunnel ──> public IP (resolved to numeric IP by the coordinator)
Joiner: coordinator hands out the host's IP → connects
```
This is verified end-to-end: a host injects the (compiled, cheat-free) Reboot DLL, the coordinator
elects the host and routes joiners, and the "host-also-plays" 2nd-instance client joins the match.

### Now built: **Tailscale auto-mesh** (fully automatic)
The one piece that must live on players' machines is the NAT-traversal transport. Tailscale replaces
playit entirely and implements the "silent background service" model you described:

```
Login  ──> launcher silently joins the tailnet (mesh_bring_up) and announces CPU/RAM/latency
Play   ──> coordinator scores every announced machine and picks the best host
Host   ──> auto-injects Reboot at the menu, registers its 100.x address, heartbeats
Joiner ──> gets the host's 100.x from the coordinator; Tailscale traverses the NAT
```

- **Auto-hosting.** On login the launcher brings up a Tailscale node (silent, joined with a
  pre-authorized auth key it fetches from the coordinator) and adds a firewall rule for UDP 7777.
  When you press Play and are elected host, the launcher waits for the game to reach the menu, then
  **injects Reboot itself** (3 attempts, 15 s apart) and registers its **`100.x`** address. Because
  `100.x` is a numeric IP, the "can't parse ip address" class of bug is gone permanently.
- **Host selection by capability.** Every launcher announces `cpuCores / ramGB / netScore` every 30 s.
  `scoreCandidate()` weights them **45 % CPU / 35 % RAM / 20 % network**; `decideHost()` defers to a
  materially better machine (>15 % higher score) for `MESH_ELECTION_GRACE_MS` (20 s), then elects the
  asker anyway — **a match can never stall waiting for someone better**. Verified live: a 2-core/8 GB
  machine (score 22.4) correctly deferred to a 16-core/32 GB one (score 99), which was elected.
- **Automatic joining.** The joiner's launcher re-polls while the coordinator says
  `better-host-available` instead of giving up — that gap is what previously left a joiner stuck on
  the matchmaking screen.
- **Graceful degradation.** If the coordinator has no auth key configured, `mesh_bring_up` fails
  quietly and the existing flow still works. Nothing breaks; you just don't get the mesh.

**New files:** `Launcher/src-tauri/src/tailscale.rs`, and in `matchmaking.routes.ts`:
`POST /nova/api/mesh/announce`, `GET /nova/api/mesh/candidates`,
`GET /nova/api/tailnet-authkey` (auth-required).

---

## 4. The one step left for you: the auth key
I never handle this token, so it's the single manual step.

1. Tailscale admin console → **Settings → Keys → Generate auth key**: tick **Reusable**,
   **Ephemeral**, **Pre-approved**.
2. Add it to the coordinator's `~/nova-backend/.env`:
   ```
   NOVA_TS_AUTHKEY=tskey-…
   ```
3. Restart the backend: `pkill -f "nova-backend/run-nova.sh"; pkill -f "src/index.ts"; ~/nova-backend/start-nova.sh`

Until then `GET /nova/api/tailnet-authkey` returns 503 and the launcher stays on the existing flow.
(Verified now: it returns **401** unauthenticated and **503** authenticated-but-unconfigured — both
correct.)

⚠️ **Restarting the backend:** `run-nova.sh` is the supervisor loop and ignores arguments — running
`run-nova.sh restart` runs a *second* supervisor in your foreground. Always kill both, then run
`start-nova.sh` (it is duplicate-guarded).

---

## 5. Limitations & assumptions
- The **game host must be a real Fortnite process** with Reboot injected — this can't be reimplemented
  in the backend. Auto-hosting automates *launching + injecting* it, not replacing it.
- **Auto-inject timing is a fixed 45 s wait** after the process appears, then up to 3 retries.
  Injecting before the main menu crashes the game and there is no reliable "at menu" signal from
  outside the process. On a slow disk the first attempt may fail and retry — that's expected. The
  manual control is still there under *Manual controls* if all three fail.
- The coordinator is **IPv6-only** on a home line, so it can't relay public game UDP — hence the
  transport lives on players' machines.
- Tailscale needs a **one-time client install (one admin prompt)** per player, and everyone shares
  your tailnet — lock it down with an ACL limiting them to UDP 7777.
- `NOVA_REGISTER_SECRET` is **off by default**; the register endpoints are open until you set it.
- **Live host migration mid-match** is still out of scope (v1 picks the best host at match start;
  migrating mid-match means every player reconnects).

---

## 6. Deferred items — now fixed
- **`onboard.tsx` sub-components defined inside the component** ✅ Fixed. `NavItem` moved to module
  scope; `LeftNav`/`TopBar`/`HeroBanner`/`LibraryPanel`/`NewsPanel`/`SettingsPanel` became **render
  functions** (`renderLeftNav()` etc.) instead of components. Their JSX is now spliced into the
  parent's tree, so there is no per-render component identity to churn — no remount, no lost input
  focus — without threading ~20 props through a large refactor.
- **Untracked error-toast `setTimeout`** ✅ Fixed. A single `showError()` helper owns a tracked timer
  (a new error clears the previous timer), plus one unmount effect that clears every timer the
  component owns (error, mesh announce, host heartbeat).
- **Address consistency / per-player `buildUniqueId`**: resolved in practice by the mesh redesign.
- **Distribution** (still open): copy `Project Reboot.dll` next to the launcher and bundle
  `nova-proxy` (or port it to Rust) so players don't need Node installed.

---

## 7. Anti-cheat / anti-injection detection

**New:** `Main backend/src/services/anticheat/{anticheat.service.ts,anticheat.routes.ts}`,
`Launcher/src-tauri/src/anticheat.rs`, table `anticheat_flags`.

### What it honestly can and cannot do
It **can** detect: results the game physically cannot produce, players reporting results for matches
they weren't in, hosts reporting on sessions they didn't host, duplicate/replayed reports, request
flooding, and injected modules a careless cheater didn't rename.

It **cannot** detect a competent client-side cheat. Aimbot and ESP read game memory and never talk to
the server, so there is no signal unless they change results enough to trip a plausibility rule.
Module attestation is reported *by* the launcher, so a patched launcher can lie. **This raises the
cost of cheating; it is not protection.** I'd rather say that plainly than let you believe the server
is guarded.

A Nova-specific wrinkle: the game only works *because* we inject DLLs (Cobalt, Reboot). "Any
injection is a cheat" would flag every legitimate player, so the rule is "anything outside the
known-good set is worth a look" — and the known-good set explicitly includes Cobalt and Reboot.

### The rules
| Rule | Severity | Fires when |
|---|---|---|
| `attestation.suspicious_module` | 7 | A loaded module's name matches a cheat/loader pattern (`aimbot`, `xenos`, `injector`, …) |
| `attestation.unknown_modules` | 1 | Modules outside the known-good set — aggregated, deliberately low (antivirus/capture/RGB software is normal) |
| `match.kills_exceed_players` | 9 | More kills than there were players |
| `match.negative_values` | 8 | Negative kills/damage or placement < 1 |
| `match.impossible_duration` | 7 | Won a >20-player match in under 2 minutes |
| `match.kill_rate` | 6 | >4 kills/min sustained over a 3+ minute match |
| `match.placement_exceeds_players` | 6 | Placement higher than the player count |
| `match.damage_per_kill` | 4 | >1000 damage per kill (max HP+shield is 200) |
| `report.not_the_host` | 8 | Reporter isn't the account that hosted that match |
| `report.subject_not_in_match` | 8 | Results submitted for someone who didn't play |
| `report.duplicate` | 4 | Results for that match already recorded |
| `rate.flood` | 3 | >120 requests / 10 s from one account |
| `economy.excessive_grant` | 7 | Client asks for more than the server's maximum |

Flags are appended to `anticheat_flags` as an **audit trail** (never a single opaque score), so any
decision can be explained afterwards. Enforcement acts on the **24-hour severity total**, so one odd
match doesn't ban anyone but a pattern does.

Blame is assigned deliberately: an **authority** violation flags the *reporter*, an **implausible
stat line** flags the *subject*. Getting that backwards would turn the anti-cheat into a griefing
tool — anyone could get someone else banned by submitting fake results for them.

### Enforcement
Auto-ban is **OFF by default** (`NOVA_AC_AUTOBAN_AT=0`). On a server this size, wrongly locking out a
friend is worse than reviewing a real cheater a day late. Set it to a severity total (e.g. `25`) when
you're ready.

### Endpoints
| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /nova/api/anticheat/attest` | player token | Launcher reports loaded modules (auto, every 2 min) |
| `POST /nova/api/anticheat/report` | player token | Host submits match results — validated before anything is written |
| `GET /nova/api/anticheat/risk` | player token | A player's own 24 h risk total |
| `GET /nova/api/anticheat/flags` | admin secret | Audit trail |
| `POST /nova/api/anticheat/ban` | admin secret | Manual ban/unban |

Admin routes use `NOVA_AC_ADMIN_SECRET` (falling back to `NOVA_REGISTER_SECRET`). **If neither is set
the admin endpoints refuse everyone** rather than defaulting open.

### Test results
- **21/21 rule unit tests pass**, including the false-positive cases: an average match, a 12-kill
  win, an early death and a short duo match all produce **zero** flags.
- **Live on the coordinator:** a clean module list *including Cobalt + Reboot + a Discord hook* →
  risk **0**. A list containing `SuperAimbot.dll` + `xenos_injector.dll` → risk **15**. A report for a
  non-existent match → rejected, nothing written.
