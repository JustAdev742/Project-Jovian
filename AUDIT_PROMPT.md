# Project Nova — Engineering Audit

Paste everything below the line as your task prompt.

---

# MISSION

Audit **Project Nova**, a private-server stack for **Fortnite 7.40**. Understand it, find real bugs,
fix root causes, and make it behave the same on machines other than the one it was built on.

Two things make this project unusual and should shape how you work:

**It has a long history of confident wrong answers.** Multiple releases shipped fixes that were
well-argued, well-evidenced, and wrong — three of them made things worse and had to be reverted. The
expensive failure mode here is not missing a bug. It is *asserting* something you have not verified.
An honest "unverified — here is the one experiment that would settle it" is worth more than a
plausible conclusion.

**One machine works and another does not.** That asymmetry is the point. Any explanation that would
break both machines equally, or work on both equally, is not an explanation of the actual problem.

---

# 1. THE CORRECTION THAT DECIDES THE WHOLE RUN

> **Fortnite 7.40 does not use the Epic Online Services (EOS) SDK.**
>
> This build is **Unreal Engine 4.22, January 2019** (CL-5046157, Chapter 1 Season 7). It predates
> the EOS SDK. There is no `EOS_Initialize`, no `EOS_Platform_Tick`, no `ProductUserId`, no
> `EOS_Auth_Login`. Grepping for them returns nothing, and that absence means the subsystem is
> elsewhere — not that the integration is missing.

The client uses **OnlineSubsystemMcp** ("MCP"), Epic's older backend. Its own log names the classes
on every line:

```
LogOnline:         MCP: ...
LogOnlineIdentity: OSS: FOnlineIdentityMcp::...
LogOnlineParty:    OSS: FOnlinePartySystemMcp::...
LogOnlineUser:     MCP: QueryUserInfo ...
```

In practice that means three surfaces:

| Surface | What it is |
|---|---|
| **REST over HTTPS** | `*.ol.epicgames.com` — `account-public-service-prod` (OAuth, `eg1~<JWT>` bearer tokens), `fortnite-public-service-prod11` (profiles, cloudstorage, matchmaking, storefront), `lightswitch-public-service-prod`, `friends-public-service-prod`, `fortnitecontent-website-prod07`, `datarouter`. |
| **XMPP over WebSocket** | Presence, party, friends. This is what the client means by "the servers" — losing it produces *"You have been unexpectedly disconnected from the servers for Epic Games"*. Its address comes from `[OnlineSubsystemMcp.Xmpp] ServerAddr`, set by a **cloudstorage hotfix**, not local config. |
| **MCP profiles** | `/fortnite/api/game/v2/profile/<id>/client/QueryProfile` with `profileId` (`athena`, `common_core`, …) and revision (`rvn`) semantics. Profile-revision mismatches are a real class of bug here. |

**Trap:** the backend has a directory called `services/eos/`. It is a REST shim for a few
Epic-branded endpoints, **not** an SDK integration. The real online subsystem is `services/mcp/`,
`services/social/`, `services/xmpp/` and `services/cloudstorage/`.

**Authoritative sources, in order.** Do not cite modern EOS documentation for this build.
1. The client's own `FortniteGame.log` — it names the exact OSS class and method that failed
2. `LawinServerV3-main backend code reference/` — a working reference backend for this era
3. UE 4.22 `OnlineSubsystemMcp` semantics
4. Community OGFN sources — lowest confidence, always corroborate with (1)

---

# 2. THE MAP

Paths are relative to `C:\Users\Admin\Documents\Project Nova` unless absolute.

### Ships to players

| Path | What it is |
|---|---|
| `Launcher/` | Tauri v1 desktop app — React/TS in `src/`, Rust in `src-tauri/src/`. What a player runs. |
| `Launcher/src-tauri/src/carter.rs` | Game launch: DLL install, process spawn order, command-line args. |
| `Launcher/src-tauri/src/host.rs` | Proxy control, Reboot injection, gameserver lifecycle, coordinator URL. |
| `Launcher/src-tauri/src/tailscale.rs` | Mesh join, auth-key fetch, connection self-repair. |
| `Launcher/src-tauri/src/net.rs` | DNS-resilient HTTP (DoH fallback) for coordinator calls. |
| `Launcher/src-tauri/src/diagnostics.rs` | Self-check emitting `NOVA-xxx` codes. |
| `Launcher/src/screens/SelfCheck.tsx` | Its UI, on the Logs screen. |
| `Launcher/cobalt/Cobalt/` | **Cobalt** (C++). Injected into the game; hooks `curl_easy_setopt` and rewrites every Epic host to `127.0.0.1:3551`. Builds to `Launcher/cobalt/x64/Release/Cobalt.dll`. |
| `Project-Reboot-DLL/Project Reboot/` | **Reboot** (C++). Injected into a *second* Fortnite instance to turn it into a listening gameserver on `:7777`. Builds to `Project-Reboot-DLL/x64/Release/`. |
| `Main backend/` | Fastify + TypeScript. The emulated Epic API. Two modes — see §3. |
| `nova-proxy/` | Node reverse proxy on `127.0.0.1:3551`. Forwards HTTP **and WebSocket** to the coordinator. |

### Reference and history

| Path | What it is |
|---|---|
| `LawinServerV3-main backend code reference/` | Reference backend for this era. **Read-only.** Best source for expected MCP response shapes. |
| `C:\Users\Admin\Documents\backends\_extracted\` | Other OGFN projects (Erbium, Reload-Backend, Fortify-Alpha, Phoenix). Useful for comparing launch sequences. |
| `_backup-*/` (9 dirs) | Snapshots from 2026-07-19 → 07-25. **The first git commit is 2026-07-26**, so these are the only record of that state. Read freely; **never delete**. |
| `coordinator/`, `src/`, `Research-Help/` | Small tracked helpers and notes. |

### Where the evidence actually lives

Most failures here are invisible from the outside — the game logs its own death and exits cleanly, so
the launcher looks healthy. Go to these first, not to the source.

| Path | What it holds |
|---|---|
| `%LOCALAPPDATA%\ProjectNova\Logs\cobalt.log` | The launcher tees the injected DLLs' stdout here. **Survives the game dying.** Usually the single most valuable artifact. |
| `<build>\FortniteGame\Saved\Logs\FortniteGame.log` | The client's own log. Names the exact OSS class that failed. |
| `%LOCALAPPDATA%\FortniteGame\Saved\Crashes\UE4CC-*\CrashContext.runtime-xml` | UE4's crash reporter — the **full** frame list. Our own stack walker loses the chain after the first frame. |
| `<build>\FortniteGame\Binaries\Win64\crash.log` / `.dmp` | Written by Reboot's vectored handler. Relative path, so it lands in the game's cwd. |
| `%LOCALAPPDATA%\Project Launcher\launcher-startup.log` | Launcher startup trace. |
| Coordinator `~/nova-backend/nova.log` | Server side. |

### The two test machines

```
PC      12 cores / 15.9GB   Windows 11   C:\Users\Admin\Downloads\v7.40\7.40\
laptop   8 cores /  7.6GB   Windows 10   C:\Users\Scott Mahony\Downloads\7.40\7.40\   ← note the SPACE
```

---

# 3. ARCHITECTURE

```
              ┌── Fortnite client (Cobalt.dll injected) ──┐
 player ─Play►│  every Epic URL rewritten to              │
              │  http://127.0.0.1:3551                    │
              └───────────────┬───────────────────────────┘
                              ▼
                   nova-proxy  127.0.0.1:3551
                              │  HTTP + WebSocket, TLS outbound
                              ▼
              coordinator  https://clientfinder.tail0a8fd0.ts.net:8443
              (Linux box running Main backend, NOVA_HOST_ELECTION=1)
                              ▲
              host agent      │  "should I serve?" every 3s
              (Main backend, 127.0.0.1:3552, NOVA_COORDINATOR set)
                              │
                              ▼  when elected
        second Fortnite instance + Reboot DLL ──► listens on :7777
```

**One backend, two modes**, decided by `NOVA_COORDINATOR` (`Main backend/src/config.ts`):
- **empty** → standalone/coordinator: serves the game, decides hosting from its own demand
- **set** → host agent: stops deciding, asks the coordinator, runs a gameserver when elected

The coordinator binds `127.0.0.1:3551` and is published on `:8443` by Tailscale — reachable **both**
over the tailnet and publicly via Funnel. Game traffic and host-control traffic take different paths,
so a fault can hit one and not the other. Check which one you are actually testing.

---

# 4. TRAPS — read before forming any theory

Every item is a mistake actually made here, with the cost already paid.

1. **A missing log line proves nothing — but the two DLLs differ, so know which you are reading.**
   - **Reboot** calls `std::ios::sync_with_stdio(false)` (`dllmain.cpp:227`) and most of its lines end
     `'\n'`, not `std::endl`. Buffered output is genuinely lost on abnormal exit, so its absent lines
     are weak evidence. Lines that *do* use `std::endl` are flushed and their absence does mean
     something — check which before arguing from either.
   - **Cobalt** does not buffer that way. `Log::Init()` swaps `std::cout`'s stream buffer for one
     that forwards each completed line to the backend *and* to `cobalt.log`. Its output is
     comparatively trustworthy — though the queue is bounded and drops oldest-first under load, which
     it counts.
   - **The trap that bites regardless of buffering:** a whole block can sit behind an early `return`
     that never executes, so the *failure* message you grep for never appears either. Absence then
     reads exactly like success. This has happened here — `InitializeExitHook`'s anti-tamper hooks sat
     behind such a return for the project's entire life, and the missing "failed to find" line was
     read as the scan having succeeded.

   **Require a positive signal.** Never infer success from a missing failure message.

2. **The coordinator answers unknown paths `200 {}`.** A 200 does not mean an endpoint exists.
   Always probe a deliberately bogus path as a control, in the same run.

3. **Audit the binary that RUNS, not the one you built.** `host.rs` resolves
   `beside_exe("Project Reboot.dll")` *before* any hardcoded dev path, so an installed launcher uses
   `Launcher/src-tauri/resources/`. After any DLL change: rebuild → copy into `resources/` → extract
   it back out of the finished installer → compare md5.

4. **Deployed code drifts.** `Launcher/src-tauri/resources/Backend-Coordinator/dist/` is stale and
   nothing rebuilds it automatically. The coordinator's deployed source can also lag the repo. Never
   assume the code you are reading is the code that ran.

5. **`nslookup` and the Windows resolver disagree.** `nslookup` queries a DNS server directly; the
   launcher and game use the OS resolver. With Tailscale's NRPT rule active, `nslookup` succeeds
   while everything real fails. Test through the OS resolver.

6. **Exit code 3 is not a clean shutdown.** It is UE4's `GIsCriticalError` → `RequestExit`. A raw
   access violation is `3221225477`; once Reboot's vectored handler logs it you see `3`.

7. **A stack address is a RETURN address** — it maps to the line *after* the call.

8. **`GetOffset()` returns 0 for a missing property, and offset 0 is the object's vtable pointer.**
   Reading a field at a zero offset yields a plausible non-null pointer. This has caused three
   separate crashes. Check the **offset**, never the resulting pointer.

9. **Requests intermittently escape Cobalt's redirect to Epic's real servers.** Fingerprint: a
   `CorrId=FN-…` in the client log (Nova never emits one), or Epic-specific wording such as
   `"Wrong token entity type. Required [s], found [eg1]"`. UE4's hotfix batch is **all-or-nothing** —
   one escaped file discards every file in it.

---

# 5. KNOWN STATE — do not re-derive

### Open

- **NOVA-303 — request-escape window.** Cobalt hooks `curl_easy_setopt` via a Memcury VEH guard-page
  hook. The guard clears process-wide when it fires and re-arms only on a later
  `STATUS_SINGLE_STEP`, so a call on another thread runs unhooked. Confirmed with `CorrId` evidence
  on both machines. Closing it needs an inline hook (no unprotect window) — see the dead end below.
- **NOVA-301 — anti-tamper kick.** `AppES` (Fortnite's verdict dispatcher) closed the client ~44s
  after `LogUAC: UACClient initialized`, message `UnsafeEnvironment_BodyMissingLauncher`. On the most
  recent run it did **not** fire. Confirm current status before treating it as open.

### Dead ends — do not repeat

| Attempt | Outcome |
|---|---|
| `-nouac` launch arg | **Breaks login.** `UFortOnlineAccount::UAC_ClientLogin` exists — sign-in *waits* on UAC. Client hangs on "Patching". Permanently ruled out. |
| Immediate VEH re-arm | Broke hosting. A detour that calls through to its own hooked function faults again instantly and recurses until the stack dies. The deferred single-step is load-bearing. |
| Enabling Cobalt's `DetoursEasy` anti-tamper hooks | Crashed **both** machines on load. Those signatures were written for other seasons and have never executed on 7.40. |
| MinHook inline curl hook | Hard-killed the game loading Frontend — no exception, no crash report. **Still unexplained.** The "mid-prologue address" theory was disproved by a byte dump showing 14 bytes of int3 padding before the scan point. |

### Verified working — do not "fix"

Back-bling `FName` guard · local-player-controller wait before travel · host-failure strikes and
spec-based election (coordinator-side) · 45s warmup · DNS self-repair.

---

# 6. HOW TO WORK

## Order

Do not start patching. Build the model first.

```
1  RECON        map what exists; confirm entry points and how each piece starts
2  TRACE        follow one full path end to end: launch → auth → XMPP → matchmaking → in-match
3  INVESTIGATE  the workstreams below, in parallel
4  REPRODUCE    turn each suspicion into a reproduction, or grade it down
5  FIX          root causes, one change at a time
6  SWEEP        find the same pattern everywhere else
7  REVIEW       adversarial pass over your own findings
8  REPORT       including what you could not verify
```

## Workstreams — 4 to 6, no more

More agents means more findings to reconcile and more chances for a confident wrong answer to
survive. Merge or drop these as evidence dictates; do not add one to look thorough.

1. **Online subsystem (MCP/OSS)** — every emulated endpoint against what UE 4.22 expects: token
   shape and `eg1~` semantics, MCP profile revisions, XMPP/WebSocket presence and party, cloudstorage
   hotfix delivery, lightswitch, friends. Compare response shapes against the reference backend.
2. **Injected native code** — Cobalt and Reboot: hooking, offsets, object lifetimes, crash paths.
3. **Launcher and process orchestration** — launch order, DLL install, injection timing, proxy and
   agent lifecycle, self-repair, update flow.
4. **Cross-machine reliability** — why one PC works and another does not. Paths with spaces,
   non-admin, DNS state, Tailscale state, timing on slower hardware.
5. **Adversarial review** — start only once others have findings. Its job is to kill weak ones.

## Evidence standard — the part that matters most

Every finding carries a grade, and the grade is load-bearing:

| Grade | Means |
|---|---|
| `CONFIRMED` | Reproduced, or proven from an artifact you quote. |
| `PLAUSIBLE` | Consistent with the evidence; a competing explanation is not excluded. |
| `UNVERIFIED` | You believe it but could not check. **Absence of evidence lives here, never in CONFIRMED.** |

Finding format:

```
ID / severity (P0–P4)
Subsystem + file:line
What is wrong          — one sentence
Evidence               — quoted log line or code, and how you obtained it
Grade                  — CONFIRMED / PLAUSIBLE / UNVERIFIED
Failure scenario       — concrete inputs/state → wrong outcome
Root cause             — not the symptom
Proposed fix           — and what happens if it does not apply
Asymmetry              — does this explain one machine failing and not the other?
```

State plainly when a check could not be run. **"The gate passed" and "the gate did not run" are
different sentences** and must never be collapsed.

## Fix discipline

- **Root cause only.** A `try`/`catch`, a retry, a `sleep`, or a widened timeout that hides a race is
  not a fix. Neither is a machine-specific workaround.
- **One change at a time**, on top of a known-good build. Three of this project's worst regressions
  shipped as bundles where the culprit could never be identified afterwards.
- **Fail safe.** If a change cannot take effect, the result must be today's behaviour, not worse.
  Say explicitly what happens when it does not apply.
- **Sweep.** After each fix, search for the same pattern elsewhere. The zero-offset bug appeared
  three times in different files.
- **Verify what shipped**, not what compiled — see trap 3.

## Severity

`P0` data loss, auth compromise, total failure · `P1` major feature broken, crash, cannot connect ·
`P2` degraded or unreliable · `P3` minor, diagnostics, maintainability · `P4` informational.
Do not inflate.

---

# 7. SCOPE AND SAFETY

This is engineering on a local project. It is **not** a security engagement.

**Do:** read and understand all of this project's code, config, logs and dependencies; test against
its own services; inject faults locally (timeouts, packet loss, killing the backend, malformed local
fixtures, invalid config).

**Do not:** attack, probe, scan or interfere with Epic's infrastructure or any unrelated host; use a
credential you find; bypass authentication; perform penetration testing.

**On a security-sensitive finding:** identify the code, explain what it does, record it as a finding,
recommend a safe fix, and **continue the audit.** Do not exercise it to prove exploitability.

**Never print secrets.** The Tailscale API token in particular must stay on the coordinator — read
it into an environment variable there if needed, never into output.

> **Critical:** finding something security-shaped is not a reason to stop. If one specific
> investigation cannot be done safely, stop *only that one*, record exactly what could not be
> verified, and carry on with everything else.

---

# 8. DONE

Not done because it builds, or because one machine works, or because the original error disappeared.

Done when:

- The architecture and every major execution path are mapped, and the online subsystem is understood
  **as MCP/OSS**, call by call.
- Every finding carries a grade, and `UNVERIFIED` ones say what would settle them.
- P0 and P1 are fixed at root cause, or explicitly accepted with a reason.
- Each fix has been swept for elsewhere in the codebase.
- Cross-machine differences are explained, not worked around.
- The report includes an explicit **"could not verify"** section.

## Deliverable

One `AUDIT_REPORT.md`: architecture map, findings by severity with grades, root causes, fixes
applied, and could-not-verify. Add `BUG_REGISTER.md` only if the finding count justifies a second
file. Keep documentation proportionate to what you actually found — a long report about a short
investigation is worse than a short one.

**Close with the honest position**, including anything that could not be validated. This codebase has
spent most of its life "working" on one machine and completely broken on another. A report that reads
as complete when the investigation was not is the most expensive thing you can produce here.
