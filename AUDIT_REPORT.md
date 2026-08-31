# Project Nova — Engineering Audit

Audit date: **2026-08-15**. Branch `feat/service-health-banner` @ `f86922a`.
Method: lead recon and trace, four parallel investigation workstreams, an adversarial verification
pass over the highest-severity findings, and a completeness critic. 13 agents, ~1.7M tokens.

---

> **UPDATE 2026-08-15, later the same day — §0 is superseded. The cross-machine failure is now
> EXPLAINED, not merely enumerated. See §0a. The MCP fix has also been deployed to the live
> coordinator. Everything below §0a is the audit as originally written; §0's "enumerated, not
> explained" verdict was correct when written and is now closed out by §0a.**

---

## 0a. The cross-machine failure — CONFIRMED root cause

> **The laptop is signed in to a *different tailnet*. The launcher can't tell, because it decides
> "connected to the mesh" by looking at the *shape* of its IP address rather than which mesh it is
> on. So the laptop advertises itself as a reachable host, gets elected, registers a gameserver
> address nobody can route to, and every player sent there fails to connect.**

### The evidence chain, each step with a positive signal

**1. The launcher tests address shape, not mesh identity.** `tailscale.rs:159-166`:

```rust
match ts_run_timeout(&["ip", "-4"], 6) {
    Ok(ip) => {
        let ip = ip.lines().next().unwrap_or("").trim().to_string();
        if ip.starts_with("100.") {
            MeshStatus { installed: true, connected: true, ip: Some(ip), detail: "connected".into(), … }
```

`100.64.0.0/10` is shared CGNAT space. *Any* tailnet hands out addresses in it, so this test passes
for a machine on someone else's mesh. `mesh_announce` (`:341`) then advertises that same address via
`ts_ip()`, and its own comment states the invariant it fails to enforce:

> `:342` — *"A machine with no mesh address cannot be reached by other players, so it must not
> present itself as a host candidate."*

The invariant needed is **"is on our mesh"**; the code checks **"has an address"**.

**2. The laptop really is announcing, from a real Tailscale address.** The live coordinator's
`nova.log` — 4,588 lines mentioning it:

```
[Mesh] Candidate online: 7f0de3ca6f9667144be7376cab035e89 @ 100.88.226.108 (8c/7.6GB, Oceania (Sydney), hw score 42.61)
GET /nova/api/host/should-i-serve?accountId=7f0de3ca…&playlist=playlist_defaultsolo&region=OCE&address=100.88.226.108&port=7777
```

`8c/7.6GB` matches the laptop exactly (the PC announces `12c/15.9GB` from `100.99.211.58`). The
address comes from `ts_ip()` → `tailscale ip -4`, which only ever returns a Tailscale address — so
Tailscale *is* running there.

**3. It reaches the coordinator anyway, because that path is public.** `tailscale funnel status` on
the box:

```
# Funnel on:
https://clientfinder.tail0a8fd0.ts.net:8443 (Funnel on)
|-- / proxy http://127.0.0.1:3551
```

Funnel serves the whole internet, so announcing and polling work from *any* network. Only the
*game socket* needs mesh membership. **This is why the two paths disagree** — exactly the split the
brief warned about ("game traffic and host-control traffic take different paths").

**4. It gets elected, and registers an address nobody can reach.**

```
[Serve] 7f0de3ca -> SERVE (elected) | waiting=1 hasServer=false | reservation=7f0de3ca idle 0s | servers=none
[Matchmaking] Gameserver registered: 100.88.226.108:7777 playlist=playlist_defaultsolo region=OCE status=starting
```

Elected 4 times; registered at that address 11 times (vs 57 at the PC's address).

**5. That address is not in this tailnet — proven with a control in the same run.** From the
coordinator:

```
CONTROL: tailscale ping 100.99.211.58  → pong from desktop-qn7gb72 (100.99.211.58) via 192.168.0.124:41641 in 1ms
TEST:    tailscale ping 100.88.226.108 → no matching peer
```

Its full netmap for `tail0a8fd0.ts.net` contains exactly **one** real device peer,
`DESKTOP-QN7GB72`, plus Tailscale's own `funnel-ingress-node` entries. The netmap is demonstrably
fresh — it pings the PC in 1 ms — so this is not staleness. The laptop is **not a member of this
tailnet.**

### Why this is the asymmetry, and not a both-machines bug

| Pairing | Outcome |
|---|---|
| PC hosts, PC joins (same machine) | **Works** — the only success in the evidence base, and it never crosses the mesh |
| Laptop hosts, PC joins | PC dials `100.88.226.108` → no peer → no connection |
| PC hosts, laptop joins | Laptop dials `100.99.211.58` → not in *its* tailnet → no connection |

It breaks **every** cross-machine pairing while leaving same-machine untouched. That is precisely
the observed evidence pattern, and it is why §0's loopback observation and this finding are the same
story told from two ends.

**Grade: CONFIRMED.** Every step has a positive signal, and the decisive step has a control.
**Severity: P1** — hosting between two machines cannot work; it is not data loss or auth compromise.

### Root cause

`tailscale.rs:162` tests an address *prefix* where the requirement is tailnet *identity*, and the
coordinator then trusts the self-reported `tsIp` in the announce body with no identity or
reachability check. Two places assume "has a 100.x address" ⇒ "other players can reach it".

### Fix — APPLIED and deployed to the live coordinator

Chosen after checking with the maintainer, because it carries a fail-open/fail-closed trade-off.

**Coordinator-side verification** (`matchmaking.routes.ts`): `/nova/api/mesh/announce` now checks the
announced `tsIp` against the authoritative Tailscale device list for this tailnet, fetched with the
`NOVA_TS_API_KEY` the coordinator already holds for minting join keys, cached 60 s. A candidate whose
address is not a device in this tailnet is rejected with `409 not-in-tailnet` and removed from the
registry, so it can never be elected.

This was chosen over a launcher-side tailnet-identity handshake because **it works with every
launcher already in the field** — no rebuild, no release, effective immediately.

**It fails open, deliberately.** If `NOVA_TS_API_KEY` is unset, or the API is unreachable, or it
returns an empty device list (which means a scope/tailnet-name problem, not an empty tailnet — this
very process is a device in it), the announce is accepted exactly as before and the reason is logged.
Rejecting every candidate because an external API had a bad minute would take hosting down for
everyone, which is strictly worse than the bug. And because a silent gate is indistinguishable from a
passing one, it logs **once** when verification is switched off:

```
[Mesh] tailnet membership is NOT being verified (NOVA_TS_API_KEY unset) — candidates are accepted on their self-reported address
```

**Verified before deploying:** the Tailscale device API returns 2 devices — `clientfinder`
(`100.96.188.28`) and `DESKTOP-QN7GB72` (`100.99.211.58`); PC present `true`, laptop address present
`false`. So the check cannot wrongly exclude the working machine. Fail-open path tested locally with
no key: foreign IP still accepted, one-shot warning emitted.

**Verified after deploying, on the live coordinator:**

| probe | result |
|---|---|
| foreign address `100.88.226.108` | `409 {"success":false,"reason":"not-in-tailnet",…}` |
| real tailnet address `100.99.211.58` (control) | `200 {"success":true,"score":61.14}` — hosting not broken |
| candidate registry afterwards | clean; the rejected entry never appears |
| "verification is off" warning | 0 occurrences — the gate **ran** |

And on genuine traffic, not a test injection — the real laptop, rejected by the live fix:

```
[Mesh] REJECTED 7f0de3ca6f9667144be7376cab035e89 @ 100.88.226.108 — not a device in tailnet "-".
It is signed in to a DIFFERENT tailnet, so no other player could connect to it.
```

**What this fix does and does not achieve.** It stops an unreachable machine being elected, so a
match is no longer handed to a host nobody can join — the PC will now reliably win election. It does
**not** make the laptop able to play; that needs the laptop signed into `tail0a8fd0.ts.net`
(`tailscale logout && tailscale up`, or letting the launcher fetch a key). Both were agreed.

**Minor follow-up:** the log renders the tailnet as `"-"` because `Config.TS_TAILNET` defaults to the
Tailscale convention meaning "the tailnet owning this token". Cosmetic only; not worth a redeploy on
a live server, but worth fixing next time the file is touched.

**Rollback:** `cp ~/nova-backend/matchmaking.routes.ts.bak-20260815-211410
~/nova-backend/src/services/matchmaking/matchmaking.routes.ts && kill $(pgrep -f 'tsx src/index.ts')`

### What this does **not** explain

Nothing here bears on NOVA-303, the party startup race, or the crash signatures. It explains
*connection between two machines*, which is the symptom the project has been chasing.

---

## 0. Original framing — superseded by §0a, retained for the record

> **The one successful end-to-end session on record is the PC connecting to itself.**

The audit brief is built on an asymmetry: "One machine works and another does not." That premise is
**not supported by any retained artifact**. In the only session in the evidence base that reached
gameplay (2026-08-15, 17:52–18:11), the client and the gameserver were the same physical machine:

```
FortniteGame_2.log:2284  LogNet: NotifyAcceptingConnection accepted from: 100.99.211.58:60334
FortniteGame.log:2304    LogNet: Browse: 100.99.211.58//Game/Maps/Frontend
```

`tailscale status` reports `100.99.211.58  desktop-qn7gb72` — this PC. The client dialled its own
tailnet address. No WireGuard peer, no DERP relay, no NAT traversal, and **no remote Windows
Firewall** was ever in the path.

What is actually established is narrower and should be stated that way:

| Claim | Status |
|---|---|
| The PC works end to end **against itself** | CONFIRMED |
| A two-machine session has ever worked | **No evidence either way** |
| The laptop fails for reason X | **UNVERIFIED for every candidate X** |

No laptop artifact was examined by anyone in this audit — no `cobalt.log`, no `FortniteGame.log`, no
`tailscale status`, no file hashes. Every laptop-side claim in this report is a mechanism derived
from reading PC-side code. **The cross-machine difference is enumerated, not explained.** §6 gives
the single experiment that would change that.

This matters more than any individual bug below, because it means the project's central diagnostic
question has never actually been instrumented.

---

## 1. Architecture, as verified

```
   Fortnite client                                  Fortnite gameserver (2nd instance)
   + Cobalt (as GFSDK_Aftermath_Lib.x64.dll)        + Project Reboot.dll
        │  curl_easy_setopt hooked; every                 │  GameNetDriver  :7777
        │  *.ol.epicgames.com → 127.0.0.1:3551            │  IpNetDriver    :7776  ← not firewalled
        ▼                                                 ▲
   nova-proxy  127.0.0.1:3551 ─── HTTP + WS upgrade ──────┤
        │                                                 │
        ├─ /nova/api/host/*, /nova/api/logs, /components ─▶ host agent 127.0.0.1:3552
        │                                                   (Main backend, NOVA_COORDINATOR set)
        ▼
   coordinator  https://clientfinder.tail0a8fd0.ts.net:8443
   (Linux, Main backend via `tsx src/index.ts`, NOVA_HOST_ELECTION=1)
```

**Corrections to the brief's own map, all verified this session:**

1. **Cobalt is not injected.** It is installed by *file replacement*: `carter.rs:604-680` copies
   `Cobalt.dll` over `Engine/Binaries/ThirdParty/NVIDIA/NVaftermath/Win64/GFSDK_Aftermath_Lib.x64.dll`.
   Only Reboot is injected (`host.rs:239`, `injrs`).
2. **`FortniteGame.log` is not in the build folder.** It is at
   `%LOCALAPPDATA%\FortniteGame\Saved\Logs\` (580,904 bytes; `FortniteGame_2.log` 1,190,697 bytes for
   the gameserver). The brief's map, and `diagnostics.rs:317-327`, both look in the build folder —
   which is why three self-check codes have never had data (finding L-1).
3. **The coordinator is not running stale source.** It runs `node_modules/.bin/tsx src/index.ts`
   directly; there is no `dist/` on the box. PID 356356 started `Sun Aug 2 03:03:09 2026`, and the
   newest source file (`matchmaking.routes.ts`) has mtime `2026-08-02 03:02`. Nothing is newer than
   the process. This contradicts a prior project note claiming drift.
4. **The build is MCP/OSS, definitively.** The client's own log:
   `FOnlinePartySystemMcp` ×54, `FOnlineIdentityMcp` ×6, `OnlineSubsystemMcp` ×1,
   and `EOS_Initialize` / `EOS_Platform` / `ProductUserId` **×0**.

**Trap 2 verified live on both surfaces.** A deliberately bogus path returns `200 {}` from the host
agent (`:3552`) *and* through the proxy from the coordinator (`:3551`); unmatched POSTs return `204`.
Source: `index.ts:127-131`. Every positive result in this report was taken against a control probe in
the same run.

---

## 2. What the adversarial pass did to the findings

This is the most useful number in the report:

| | count |
|---|---|
| Findings produced by four workstreams | 30 |
| Claimed **P1** | 8 |
| Put through adversarial verification | 8 |
| **Survived at P1** | **1** |
| Refuted outright | 3 |
| Downgraded to P2/P3 | 4 |

Five of eight claimed P1s did not survive contact with a skeptic who went and read the cited lines.
That ratio is the point: this project's expensive failure mode is confident wrong answers, and the
gate caught them before anything shipped.

**Including one of mine.** My own strongest independent finding — that the 60 s join window now
exceeds the 45 s warmup hold — was refuted as stated, and **I did not ship the fix I had drafted**.
See §4.

The remaining 22 findings were **not** independently verified. They carry their workstream's
self-assigned grade and should be read as unaudited leads, not as conclusions.

---

## 3. Findings

### P1 — `mcp-unauth-mutation` · CONFIRMED · **FIXED**

`Main backend/src/services/mcp/mcp.routes.ts` — the `dedicated_server` and `public` MCP route
families had no auth preHandler yet dispatched the full mutating operation switch. The `client`
route at `:251-259` carries `requireAuth` **and** a token-vs-path ownership check; the other two
carried neither.

Reproduced by the verifier against a scratch database, with a `204` control in the same run:

- unauth `POST .../dedicated_server/EquipBattleRoyaleCustomization?profileId=athena&rvn=1`
  → `200`, `changeType: statModified`, and the locker change **persisted** to disk
- unauth `POST .../public/PurchaseCatalogEntry?profileId=common_core&rvn=1` → currency moved
- unauth `POST` against an accountId that had never registered → `200`, **profile created on disk**
- targeting is trivial: `compat.routes.ts:33` maps displayName → accountId unauthenticated, and
  `auth.routes.ts:131` derives accountId as `md5(login)`

`public` did not constrain the damage — `mcp.routes.ts:43` only picks a *default* `profileId`, which
`?profileId=athena` overrides.

**Root cause.** `handleMcpOperation` was written as one shared body for all three route families and
the auth/ownership check was added to only one of them.

**Fix applied** (one change, `mcp.routes.ts`): a `readOnly` mode. `QueryProfile`, `SetMCPEnabled` and
`ClientQuestLogin` still run; every other operation returns the same well-formed empty envelope the
`default` branch already produces, and never enters the mutation switch.

**Why this shape and not the obvious one.** The finding originally proposed gating
`dedicated_server` behind `Config.REGISTER_SECRET`. That was rejected, correctly: `config.ts:110`
defaults it to `''` and the established idiom in this codebase — `matchmaking.routes.ts:953` and
`:1001` — is `if (Config.REGISTER_SECRET && …)`, which **fails open**. Copying it would have closed
the finding while leaving the route wide open. Returning `403` was also rejected: `mcp.routes.ts:226`
carries a deliberate "never return a 404 for unknown operations" rule. The envelope satisfies both.

**Fails safe:** if some caller legitimately needed one of these operations, it now receives a valid
no-op envelope rather than an error. Evidence that nothing calls them (zero `/dedicated_server/` in
10,532 lines of `cobalt.log`; `grep` finds it only in route definitions) is an *absence* argument and
is graded PLAUSIBLE — which is exactly why the fix returns an envelope instead of erroring.

**Verified by positive signal, not absence:**

```
[MCP] Refusing unauthenticated mutating operation EquipBattleRoyaleCustomization on <acct> (profile athena)
[MCP] Refusing unauthenticated mutating operation PurchaseCatalogEntry on <acct> (profile common_core)
```
Control: bogus route family → `204`. Read via `dedicated_server/QueryProfile` → `200`, 81,168 bytes,
unchanged. Profile before vs after the mutation attempt: **identical once `serverTime` is excluded**.
`npx tsc --noEmit` exits 0.

**Asymmetry:** none. Same code, both machines.

---

### P1 — `gameserver-register` is unauthenticated on the live coordinator · CONFIRMED · **NOT FIXED**

`matchmaking.routes.ts:953` and `:1001` gate registration on
`if (Config.REGISTER_SECRET && b.secret !== Config.REGISTER_SECRET)`. `config.ts:110` defaults
`REGISTER_SECRET` to `''`. On the live coordinator I confirmed read-only over SSH that
`NOVA_REGISTER_SECRET` is absent from both `.env` and `/proc/<pid>/environ`. **An empty secret skips
the gate entirely.**

`/nova/api/gameserver/register` sets the `address`/`port` every player is routed to;
`/nova/api/gameserver/unregister` with `playlist:"*"` removes a host.

Per audit scope this was identified and recorded but **not exercised** — no registration was posted.

**Not fixed, explicitly accepted for now, with reasons:** (a) one change at a time, and the MCP fix
is the one that shipped; (b) unlike the MCP case there is no shape that fails safe — making the gate
fail-closed breaks hosting on every deployment that has not distributed a secret, and that is a
deployment decision, not a code decision. **Recommended:** set `NOVA_REGISTER_SECRET` on the
coordinator and in the host agent's environment *first*, then change the idiom to fail closed.

**Reachability caveat.** `config.ts:33` binds `127.0.0.1`; exposure comes entirely from Tailscale
serve/funnel. I could not confirm the live funnel config (`tailscale` is not on that user's PATH), so
**public** reachability is UNVERIFIED. Tailnet reachability is not in doubt — and per
`PRODUCTION-HARDENING.md` every player's launcher silently joins the tailnet with a pre-approved key,
so tailnet membership *is* the player population.

---

### P2 — Reboot's `crash.log` records exceptions the process **survived** · CONFIRMED

`Project Reboot/dllmain.cpp:65` installs `RebootCrashHandler` via
`AddVectoredExceptionHandler(1, …)` — **first-chance** — and returns `EXCEPTION_CONTINUE_SEARCH`.
Its own comment claims "It only acts on genuinely fatal faults", which a VEH cannot know.

Proof the process survived: the newest `crash.log` entry is `Sat Aug 15 17:53:55 2026` with
`gameBase 0x00007FF7E7600000`; `baseaddress.log` records that base **exactly once** (one Reboot init,
no restart); and `cobalt.log` shows that same process still playing at 18:01 and reaching
`[Restart] match over - recycling in 20s`. `structs.cpp:40-46` already concedes the point in a
`__try/__except` comment.

**Why this matters more than its severity suggests:** every crash investigation this project has run
from `crash.log` has been unable to distinguish a fatal crash from a handled first-chance exception.
Two recurring signatures exist — one with no Reboot frames at all, one with `Project Reboot.dll+0x66A41`
— and nothing marks which were fatal. **Recommended:** record `EXCEPTION_RECORD.ExceptionFlags`
(`EXCEPTION_NONCONTINUABLE`) and add a process-exit breadcrumb, so a survived exception is labelled
as such.

---

### P3 — Warmup / join-window drift · **REFUTED as stated**; stale documentation CONFIRMED

Kept in full because it is the clearest example of the failure mode this project keeps hitting.

**What is true.** `config.ts:96-105` still asserts "Defines::WarmupWaitSeconds = 90s in the Reboot
DLL" and "~30s of headroom", while defaulting `JOIN_WINDOW_MS` to 60000. `definitions.h:73` is now
`45.f`. Commit `11a4d8f` ("Halve the warmup") touched **six files**, none of them `config.ts`, and
`git log -S JOIN_WINDOW_MS` shows the value untouched since the initial commit. All three shipped
`Project Reboot.dll` copies are md5 `EB2E0464…` and contain `45.0f ×2 / 90.0f ×2`. The live
coordinator uses the 60000 default. Runtime confirmation: `cobalt.log` 17:53:49
`[Warmup] holding the lobby open for 45s so players can join`.

**What killed it.** I claimed the two clocks share an origin because `markMatchOpened` "stamps when
the first player is routed". They do not. `resolveGameServer` is called from the ticket path with
`requireJoinable` defaulting to **false**, and `markMatchOpened` no-ops without an entry
(`:170 if (!e) return;`). In `HOST_ELECTION` mode — which is live — the players who trigger the
election ticket *before* any gameserver is registered, so nothing is stamped. The stamp is created by
the first post-registration ticket, at that player's own arrival. "60 − 45 = −15" is not the
operative quantity.

**The asymmetry claim was wrong.** Margin = `45 − time_routed − map_load`, and `time_routed` is set
by *when a human presses Play*, ranging over the whole window — it is not a machine property. At
`time_routed = 40 s` even the PC's measured ~13 s load goes negative; at `5 s` even a 25 s laptop
load boards the bus. It breaks **both** machines late in the window and works on **both** early.
Per the standing rule, that is not an explanation of the observed split.

**No observed failure.** The 45 s hold has executed exactly **once** in 10,532 lines of `cobalt.log`
— today — and that session reached gameplay and ran to match end. Every earlier session ran the 90 s
hold, where the invariant held.

**The fix would have made things worse.** `hasLiveGameServer()` feeds both the MMS release
(`xmpp.server.ts:678`) and `decideHost` (`matchmaking.routes.ts:614`). Shrinking the window means
that N seconds after the stamp the live server stops counting as joinable, so **the next player to
press Play is elected host** and spins up a second server instead of joining. On a two-person server
that converts "B is a bit late" into "A and B never play together" — the exact pathology already
documented at `matchmaking.routes.ts:624-625`. It cannot fail safe. **Not applied.**

**What to record instead:** the comment documents a constant that no longer exists and a headroom
figure that is now negative (P3, fix the comment). The real defect in this area is the **anchor** —
the join window should be stamped when the gameserver reports warmup start, not when a ticket
happens to find a registered entry. That defect is pre-existing; `11a4d8f` did not create it.

---

### P3 — `harvesting.cpp` offset lookups use the wrong property name · CONFIRMED

`Project Reboot/harvesting.cpp:109,110,113,114` — four lookups ask for `"InstigatedBy"` while their
variable names, and the original commented-out code preserved on the same line, say `DamageCauser`
and `Damage`. The block is prefaced `// UGH` (`:106`). The commented-out originals were also
null-guarded (`Fn ? FindOffsetStruct(…) : 0`); the replacements are not.

On 7.40 the CarCopper branch is live (`processevent.cpp:86-89` hooks Car_Copper below 8.00), so
`DamageCauser` loads the *controller*; `:162` then tests `IsA(FortWeaponPickaxeAthena)` / `IsA(Melee)`,
both false, and returns without harvesting. **Cars likely yield no materials** — PLAUSIBLE, not
observed.

Also trap 8's exact shape at `:146-148`: `Damage` is a *derived pointer*
(`(float*)(Parameters + DamageOffset)`), so `!Damage` is never true even when the offset is 0. The
offset is what must be tested.

**Runtime evidence:** `cobalt.log` shows `Failed to find3 InstigatedBy` ×3 then `Failed to find3
Damage` ×1, at one timestamp, in 12 separate sessions (lines 1293-1296, 2673-2675, … 10247-10250).

**A hypothesis of mine the data refuted.** I predicted the failing `Damage` lookup was
`BuildingActor_DamageOffset` on the *main* path, which would make `bHitWeakspot = (Damage == 100.f)`
(`:29`) never true and suppress the weakspot bonus at `:51`. Testable prediction: `ResourcesToGive`
never exceeds 6. **Falsified** — across 110 logged harvests the distribution is 3→20, 4→31, 5→30,
6→17, **7→1, 8→4, 9→3, 10→3, 11→1**. Twelve harvests only a weakspot can produce. The main path is
fine; severity drops P2 → P3.

---

### NOVA-303 — measured for the first time

Using `FortniteGame.log` (which no workstream had located):

```
FortniteGame.log:1841  LogOnline: Warning: OSS: Invalid response. CorrId=FN-Yb8rP6eIXEqknl12zZj8vQ
  code=401 … Message=Token is missing key ID value … "originatingService":"friends"
FortniteGame.log:1842  OSS: QueryFriendSettings request failed. (wasUpdate: 0)
```

**Escape count for the 2026-08-15 session: 1 in the client, 0 in the gameserver.**

The escaped call was `QueryFriendSettings` → `friends-public-service-prod…/friends/api/v1/<id>/settings`
— an endpoint Cobalt *also* logged as hooked at 17:53:10.873 in the same session. Same endpoint,
hooked once and escaped once: consistent with the documented race, and it **rules out** a missing
entry in `url.h`'s host table (the native workstream separately confirmed the table has no gap
against all 3,633 logged URLs).

**Practical consequence:** NOVA-303 is a lottery whose severity is decided by *which* request escapes.
This time it hit friend settings — a warning. Had it hit `QueryProfile` during sign-in, the result is
"Login Failed — Profile Query Failed", which `nova-proxy` already documents at `proxy.js:80-97`.

---

### Party v1 — working with a startup race, **not** broken

The completeness critic reported party "failing outright". That overstates it, and the correction
belongs here because it is the same error pattern the audit exists to catch.

| | count |
|---|---|
| `SendToParty` success | 25 |
| `SendToParty` failure | 5 |
| `PublishPartyInfoToPresence` success | 12 |
| `PublishPartyInfoToPresence` failure | 2 |

Failures cluster at `07:48:54:424` and the first success follows at `07:48:54:858` — 434 ms later.
That is a startup race (party config update attempted before the XMPP socket is ready) that
self-corrects, not a broken relay. Separately, `LogXmpp: Warning: MUC: JoinPublicRoom failed. Another
operation already pending for room Fortnite_Nova_global_…` ×3 — duplicate join attempts, minor.

---

### Remaining findings (workstream-graded, **not** independently verified)

| ID | Sev | Grade | Location | One line |
|---|---|---|---|---|
| `bundled-hotfix-wrong-xmpp-port` | P2 | PLAUSIBLE | `resources/…/cloudstorage/DefaultEngine.ini:3-4` | Bundled hotfix hard-codes XMPP `ws://127.0.0.1:3596`; repo copy says 3551. Port 3596 exists nowhere else. |
| `tailnet-identity-never-checked` | P3 | PLAUSIBLE | `tailscale.rs:159-166` | "Connected" decided solely by the IP starting `100.`, so a *different tailnet* reports healthy. |
| `firstlaunch-kills-hosted-server` | P3 | PLAUSIBLE | `carter.rs:302-327`, `main.rs:46` | Every Play press runs `taskkill /F /IM FortniteClient-Win64-Shipping.exe`, which also matches the hosted gameserver. |
| `selfcheck-wrong-gamelog-path` | P2 | CONFIRMED | `diagnostics.rs:317-327` | Looks for `FortniteGame.log` in the build folder; it lives in `%LOCALAPPDATA%`. NOVA-301/303/305 have had no data. |
| `backend-eaddrinuse-zombie` | P2 | CONFIRMED | `index.ts:152-161` | A backend that loses the port race logs it and **keeps running** with no HTTP surface. |
| `port-checks-have-no-identity-probe` | P2 | CONFIRMED | `diagnostics.rs:94-102` | NOVA-201/202 pass on a bare TCP connect — a stale backend on 3551 reads as healthy. |
| `minhook-null-aliases-all-hooks` | P2 | CONFIRMED | `dllmain.cpp:304-312`, `MinHook.h:88` | `MH_EnableHook((PVOID)0)` **is** `MH_EnableHook(MH_ALL_HOOKS)`; a failed scan silently enables everything. |
| `cobalt-reports-success-unverified` | P2 | CONFIRMED | `Cobalt/dllmain.cpp:468-483` | Prints "initialized sucessfully" and reports healthy without checking the hook installed. |
| `cobalt-logs-bearer-tokens` | P2 | CONFIRMED | `curlhook.h:80`, `log.cpp:73-88` | `eg1~` JWTs appear in URL paths and are written to `cobalt.log` and POSTed to the backend. |
| `trap8-systemic-unguarded-offsets` | P2 | CONFIRMED | `structs.cpp:414-422` | Offset-0-means-failure unchecked at most assignment sites (my own sweep: 257 of 299 with no zero-check in-file). |
| `mcp-rvn-from-client` | P2 | CONFIRMED | `mcp.routes.ts:20-31` | Revisions computed from the client's `rvn` query param rather than stored state. |
| `common-core-stateless-rvn` | P2 | CONFIRMED | `common_core.ts:80,122` | `rvn`/`commandRevision` hard-coded to 1 and never persisted. |
| `ws-root-path-fabricates-matchmaking` | P2 | CONFIRMED | `xmpp.server.ts:186-217` | Any WS upgrade to `/` without the `xmpp` subprotocol registers a matchmaking waiter. |
| `trap1-buffering-premise-wrong` | P2 | CONFIRMED | `dllmain.cpp:227`, `log.cpp:320-368` | The brief's own trap-1 premise about Reboot buffering does not hold as stated. |
| `clientquestlogin-grants-nothing` | P3 | CONFIRMED | `mcp.routes.ts:57-64` | Aliased to QueryProfile, so quest state is never created. |
| `no-capability-floor` | P2 | CONFIRMED | `matchmaking.routes.ts:418-423` | No floor below which a machine is never elected host. |
| `stale-dist-preferred` / `shipped-dist-drift-quantified` | P3 | CONFIRMED | `main.rs:156-168` | `start_backend` prefers `dist/` over sources; shipped dist stale by two files, neither host-agent-relevant. |
| `launcher-evidence-is-self-erasing` | P3 | CONFIRMED | `main.rs:174-188` | `nova-agent.log` truncated on every start; proxy has no log at all. |
| `firewall-result-discarded` | P3 | CONFIRMED | `tailscale.rs:269-289` | Firewall-rule result discarded at both call sites; error read from the wrong stream. |
| `nova-307-dead-check-and-exit-code-3` | P3 | CONFIRMED | `diagnostics.rs:384-414` | NOVA-307 greps `cobalt.log` for a string only ever written to `nova-agent.log`. |
| `cobalt-binary-provenance` / `cobalt-stamp-frozen` | P2 | CONFIRMED | `log.cpp:326` | Banner stamp is `log.cpp`'s compile time, so two different binaries self-identify identically. |
| `hotfix-uploaded-timestamp-churn` | P3 | PLAUSIBLE | `cloudstorage.routes.ts:230-243` | `uploaded` stamped at request time, so every enumeration looks new. |
| `no-early-startup-curl-gap` | P4 | **downgrade to UNVERIFIED** | `carter.rs:975-1023` | Claims a window does *not* exist — a universal negative, unmeasurable from `cobalt.log` by construction. |

Two of my earlier observations are **withdrawn**: the `nova-agent.log` "0 bytes" reading was stale
NTFS directory metadata for a file held open by a running process (it is 23,003 bytes), and the
Cobalt "1.0.0 vs v0.1" log-format question resolves to an experiment reverted the same day —
both current binaries are the v0.1 lineage.

---

## 4. Fixes applied

**One.** `Main backend/src/services/mcp/mcp.routes.ts` — read-only guard on the two unauthenticated
MCP route families. Detail, verification and fail-safe reasoning in §3.

**Sweep for the same pattern** (unauthenticated route families that reach persistent writers):

| File | routes | `requireAuth` | persistent writers reached |
|---|---|---|---|
| `eos/eos.routes.ts` | 88 | **0** | `addFriend`, `removeFriend` |
| `social/social.routes.ts` | 49 | **0** | `addFriend`, `removeFriend`, `writeFileSync` |
| `compat`, `storefront`, `entitlement` | 17 | 0 | none |
| `cloudstorage` | 5 | 4 | `writeFileSync` |
| `stats` | 7 | 2 | none |

`social.routes.ts` and `eos.routes.ts` carry the same shape and are **not fixed**. Explicitly
accepted, with reasons: one change at a time; and `social.routes.ts` is on the live, working
friends/party path whose startup race is already documented above — changing its auth without a
two-machine test risks breaking something that currently works. Whether they are actually exploitable
is **UNVERIFIED**; I did not probe them.

Nothing else was changed. No DLL was rebuilt or installed. No live service was modified. The audit's
only writes were to a scratch database (since deleted) and this report.

---

## 4a. Post-report actions (2026-08-15, later the same day)

**The MCP fix was deployed to the live coordinator.** It was running the byte-identical pre-fix
source (verified by diff against local `HEAD`, the 271-byte delta being CRLF), while
`tailscale funnel status` confirms `:8443` is served to the public internet — so the unauthenticated
write was internet-reachable, not tailnet-only.

Procedure: backup to `~/nova-backend/mcp.routes.ts.bak-20260815-210107` → upload → verify the marker
strings landed → swap → `kill $(pgrep -f 'tsx src/index.ts')`; `run-nova.sh` respawns in ~3 s.

Verified on the live box, control in the same run:

| probe | result |
|---|---|
| bogus path (control) | `200`, 2 B |
| `lightswitch/…/bulk/status` (real read) | `200`, 330 B |
| unauth `dedicated_server/EquipBattleRoyaleCustomization` | `200`, **empty envelope**, `profileChanges: []` |
| live `nova.log` | `[MCP] Refusing unauthenticated mutating operation EquipBattleRoyaleCustomization on …` |

Rollback if ever needed: `cp ~/nova-backend/mcp.routes.ts.bak-20260815-210107
~/nova-backend/src/services/mcp/mcp.routes.ts && kill $(pgrep -f 'tsx src/index.ts')`.

**Two open items from §5 are now closed:**

- **#3 — public reachability: YES.** `tailscale funnel status` shows Funnel on for both `:443`
  (→ `:3000`) and `:8443` (→ `:3551`). Note for the record: I first inferred the *opposite* from
  DNS — `clientfinder.tail0a8fd0.ts.net` resolves to the CGNAT address `100.96.188.28` from a public
  resolver, which looked like "not exposed". **That inference was wrong**; Funnel routes by SNI and
  does not change the A record. The box's own config is authoritative, and it contradicted me.
- **`bundled-hotfix-wrong-xmpp-port` — not live, latent only.** The coordinator serves the correct
  `ServerAddr="ws://127.0.0.1:3551"` (456 B, 2-file batch: `DefaultEngine.ini` + `DefaultGame.ini`,
  matching what the PC fetched at 17:53). Because `/fortnite/api/cloudstorage/*` is *not* in
  nova-proxy's `LOCAL_PREFIXES`, cloudstorage always comes from the coordinator in P2P mode, so the
  bundled `:3596` file never reaches a client there. It would bite in **standalone/LAN mode**, where
  the local backend serves its own bundled copy. Downgrade to **P3, latent**.

**Registration gate — decision recorded: leave open, documented.** The maintainer chose not to change
`/nova/api/gameserver/register` for now, and that is the defensible call: the gate at
`matchmaking.routes.ts:953` fails open when `REGISTER_SECRET` is empty, and flipping it to fail
closed breaks hosting for every launcher in the field until each one is updated to send the secret.
It stays an **accepted open P1**. The clean fix, when someone is cutting a release anyway: have the
coordinator serve `NOVA_REGISTER_SECRET` to authenticated launchers the same way it already mints
Tailscale keys (`/nova/api/tailnet-authkey`), *then* flip the gate. Note the §0a tailnet fix reduces
the practical blast radius — an attacker-registered address is still routed to, but a wrong-tailnet
*candidate* can no longer win election.

**Also observed:** account `7d413f66f6634e5c6801244281e0cc8e` announced from *both* `100.88.226.108`
(8c/7.6 GB) and `100.99.211.58` (12c/15.9 GB) — one account identity in use on two machines, which
will confuse per-account host reservation. Recorded, not investigated.

---

## 5. Could not verify

Stated plainly, because "the gate did not run" is not "the gate passed".

1. **Anything at all about the laptop.** No artifact from it was examined. Every cross-machine
   candidate below is a mechanism read out of PC-side code with the laptop-side premise untested:
   wrong tailnet · UDP 7776 not firewalled · Cobalt/Reboot build skew · the `ws://…:3596` bundled
   hotfix · standard-user UAC relocating `%LOCALAPPDATA%` · no capability floor in election.
   **Zero are confirmed and they are not mutually exclusive.** One negative result exists:
   paths-with-spaces was swept and **cleared**.
2. **Whether a two-machine session has ever worked.** See §0.
3. **Whether the coordinator is reachable from the public internet.** `tailscale` is not on the
   coordinator user's PATH; funnel config unread. This is the difference between P1 and P0 for the
   registration finding.
4. **Whether `/nova/api/gameserver/register` is exploitable in practice.** Deliberately not
   exercised, per scope.
5. **Which four of the seven `harvesting.cpp` offset lookups return 0.** Static reading cannot
   settle it; my first hypothesis was falsified by the data.
6. **How many of the 257 unguarded `GetOffset` sites can actually return 0 on 7.40.** Most name
   properties that exist. Reporting them as 257 bugs would be noise.
7. **22 of 30 workstream findings** never went through adversarial verification. Given that 5 of the
   8 that did were refuted or downgraded, assume a similar rate applies.
8. **`database.ts` (999 lines), `anticheat.service.ts`, `version-router.ts`, the party half of
   `xmpp.server.ts`, and `eos.routes.ts` (1,352 lines) were not audited.** Notably: whether the
   coordinator and host agent can ever open the same `DB_PATH` concurrently.
9. **Whether Fortnite 7.40 actually sends the `xmpp` WebSocket subprotocol.** The server negotiates
   it correctly when present, but the real client's `Sec-WebSocket-Protocol` header was never
   observed — which leaves `ws-root-path-fabricates-matchmaking` unresolved.
10. **The 9 `_backup-*` directories** were not checked for whether any lies on the launcher's
    binary-resolution path.

---

## 6. The one experiment that would settle the most

One instrumented two-machine session, ~25 minutes. **Run the pre-flight on the laptop before
launching anything**, then play together.

**A. Laptop pre-flight** — collect the text output of each:

```bat
tailscale status --json
whoami /groups | findstr /i "S-1-5-32-544"
echo %LOCALAPPDATA%
certutil -hashfile "C:\Users\Scott Mahony\Downloads\7.40\7.40\Engine\Binaries\ThirdParty\NVIDIA\NVaftermath\Win64\GFSDK_Aftermath_Lib.x64.dll" SHA256
certutil -hashfile "%LOCALAPPDATA%\Project Launcher\resources\Project Reboot.dll" SHA256
dir "%LOCALAPPDATA%\Project Launcher\resources\Backend-Coordinator\data\cloudstorage"
netstat -ano | findstr ":3551 :3552 :7777 :7776"
```

This settles in one shot: wrong-tailnet (`TailscaleIPs` + `MagicDNSSuffix`), admin-vs-standard user
and therefore which `%LOCALAPPDATA%` is real, Cobalt/Reboot build skew **by hash rather than by the
frozen banner**, and whether the 3596 hotfix is in the laptop's bundle.

**B. During the session**, watch the *game's* log on the laptop, not `cobalt.log`:

```bash
powershell Get-Content "$env:LOCALAPPDATA\FortniteGame\Saved\Logs\FortniteGame.log" -Wait -Tail 50
```

**C. Trap-2 control, from the laptop, in the same run:**

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://clientfinder.tail0a8fd0.ts.net:8443/this/path/does/not/exist
```

**D. Collect from both machines afterwards:** all of
`%LOCALAPPDATA%\FortniteGame\Saved\Logs\FortniteGame*.log`,
`%LOCALAPPDATA%\ProjectNova\Logs\cobalt.log`, `nova-agent.log` **copied before the next launcher
start** (it is truncated on start), and `<build>\…\Win64\crash.log` + `baseaddress.log`.

**What it settles:** the joiner path (does the laptop's `LogNet: Browse:` show the PC's `100.x`, and
does the PC's server log show `NotifyAcceptingConnection accepted from:` a *different* IP — the
question §0 says has never been answered); NOVA-303's escape rate per machine by counting
`CorrId=FN-`; whether the party race is symmetric; and the four laptop-provenance unknowns.

> **Redact before sharing.** `FortniteGame_2.log:2297` contains a live `eg1~` bearer token in
> cleartext (`Login request:`), as does `launcher-startup.log` (`-AUTH_PASSWORD=`) and `cobalt.log`
> (`/oauth/sessions/kill/eg1~…`). Strip `eg1~[A-Za-z0-9._-]+` first.

---

## 7. Honest closing position

One P1 was found, verified by independent reproduction, fixed at root cause with a change that fails
safe, and confirmed closed by a positive signal with a control in the same run. A second P1 was
confirmed and deliberately left open because no available fix fails safe — that is a deployment
decision, and it is flagged rather than papered over.

Against that: **five of eight claimed P1s did not survive scrutiny, including my own strongest
finding, whose fix I did not ship because a skeptic showed it would have made things worse.** Twenty-
two further findings were never adversarially reviewed and should be treated as leads.

The largest result is not a bug. It is that the audit's founding premise is unsupported: the only
end-to-end success in the entire evidence base is one machine talking to itself over its own tailnet
address, and no laptop artifact has ever been examined. Several plausible mechanisms for a
cross-machine failure exist — the unfirewalled UDP 7776 the gameserver also listens on is the most
interesting, precisely because it would break a remote joiner while leaving a loopback session
untouched — but **not one is confirmed**, and this report should not be read as explaining why the
laptop fails. It explains why nobody yet knows.

The cheapest way to change that is §6, and it should happen before any further code is written
against the cross-machine question.
