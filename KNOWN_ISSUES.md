# KNOWN_ISSUES

Living register. Grades are evidence grades, not confidence-in-severity.
Sources: `AUDIT_REPORT.md` (2026-08-15, adversarially verified), the 2026-08-31 pass, and the
2026-09-05 corpus cross-reference.

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

**Re-checked 2026-09-05 and the assessment stands.** `host.rs:147` `p2p_register_host` sends no
credential at all — no bearer token, no secret — and it is live, called from `useLauncher.ts:120`.
So there is nothing already in the request to authenticate against, and closing the gate really does
break every launcher in the field. The prerequisite is a launcher release, not a backend change.

**2026-09-06 — STEP ONE IS DONE. The gate is still open, deliberately.**

The plan above said the clean fix was to have the coordinator serve the secret to authenticated
launchers, *then* flip the gate. The first half now exists end to end:

| piece | where |
|---|---|
| `GET /nova/api/register-secret`, behind `requireAuth` | `matchmaking.routes.ts` |
| launcher fetches it with the player's bearer token | `host.rs` `p2p_fetch_register_secret` |
| launcher passes it into the agent's environment at spawn | `main.rs` `start_backend` → `NOVA_REGISTER_SECRET` |
| agent sends it when registering | `hostRunner.ts` — **unchanged**, it always did |

That last row is why this was small: `hostRunner.ts` has always sent
`secret: Config.REGISTER_SECRET || undefined`. The secret was simply never populated on a player's
machine, because nothing could tell the agent what it was. The manual playit path passes it too.

Six tests in `register-secret.test.ts`, including the two that matter: the secret it serves is
accepted by the register gate, and a wrong one is still refused — the second guards the first, which
would otherwise pass just as well against a gate that accepted everything.

**Why the gate is STILL open, and why that is correct.** Nothing observable changes yet. Flipping it
now would lock out every launcher already installed, because none of them send a credential. The
field has to be running this build first. **Step two — deleting the `Config.REGISTER_SECRET &&`
short-circuit so an unset secret no longer skips the gate — belongs in a release AFTER this one has
had time to propagate**, and it is a two-line change when that day comes.

The secret is passed by environment, not argv: command lines are world-readable on Windows.

---

### `nova-303-request-escape` · CONFIRMED · **now has a named endpoint** · open

**2026-09-06 — what the git history rules OUT, and one candidate withdrawn.**

**RETRACTED: the "null `CurlSetOpt`" candidate recorded earlier today does not hold.** The theory was
that 1.4.3's detour called through a null `CurlSetOpt` on every invocation, which VEH masks (the hook
is often unarmed) but an inline hook would not. `git show 69ac12f` kills it: **1.4.3 had the same
three `CurlSetOpt` fallback signatures the code has now.** Redirection demonstrably works today, so
that pointer resolves on 7.40, so it resolved in 1.4.3 too. Withdrawn rather than left standing —
the fix it prompted (refusing to install when the setter is missing) is still correct on its own
merits, but it does not explain this.

**What the history DOES establish — the address is not the variable.**

| | 1.4.3 (`69ac12f`) | today |
|---|---|---|
| address hooked | `CurlEasySetOpt`, the raw scan result | `CurlEasySetOpt`, the raw scan result |
| `CurlSetOpt` resolution | 3 signatures, same order | 3 signatures, same order |
| method | MinHook inline | VEH page-guard, deferred re-arm |

They hook **the same address**. `FindFunctionEntry()` computes `entry` and only ever *logs* it —
it is never passed to the hook — so all of `IsRcxSpill`, `SafeRead` and `FindFunctionEntry` are
diagnostics, not behaviour. The byte dump that proved the scan point is the true entry therefore
removed the only address-based explanation without changing what either version targeted.

**So the remaining variable is the hooking method alone, at a correct entry.** Two theories were
raised and both fail on inspection:

- *Loader lock.* `DllMain` does `CreateThread(0, 0, Main, 0, 0, 0)` rather than working inline, and
  that thread cannot run until the lock is released. MinHook's thread suspension is not fighting it.
- *Mid-prologue patch.* Ruled out by the byte dump — the scan point is the first instruction.

The live one, untested and explicitly not shipped: MinHook's `Freeze()` suspends every other thread
and rewrites instruction pointers that land inside the relocated bytes. The Frontend map load is
exactly when curl traffic peaks across threads. That is a hypothesis, not a finding.

**Still: do not ship an inline hook without reproducing the crash.** The bar in the original comment
was "understand it first", and narrowing the variable is not the same as understanding it.
A request escapes Cobalt's redirect and reaches Epic's live servers. Observed 2026-08-15 07:48:55 in
`FortniteGame.log`:

```
HttpResult: 401 Code: 1014 … "originatingService":"friends",
  "errorMessage":"Token is missing key ID value"
QueryFriendSettings request failed. (wasUpdate: 0)
```

Epic's live **friends** service rejecting a Nova-issued JWT because it carries no `kid` header. The
call is `QueryFriendSettings` → `GET /friends/api/v1/{accountId}/settings`, issued moments after
`FOnlinePartySystemMcp::OnLoggedIntoXmpp` — so it is part of the social bring-up, not a random
request.

**Why this is Epic and not Nova, from the body alone:** Nova stamps `originatingService` as
`nova-backend` or `com.epicgames.account.public` and writes the message "The token is invalid or has
expired." Neither matches. This does not depend on the `CorrId` reasoning, which is unreliable — see
NOVA-AUDIT-014.

**THE MECHANISM IS CONFIRMED — and was already written down.** Corrected 2026-09-05: the previous
entry here said the mechanism was unknown. It is not, and has not been since 2026-08-01. It is
documented at length in Cobalt's own source (`Launcher/cobalt/Cobalt/dllmain.cpp`, the block above
`Hook(CurlEasySetOpt, …)`), which I had not read when I wrote that.

Cobalt hooks `curl_easy_setopt` with a **VEH page-guard** hook, and `PAGE_GUARD` is a **one-shot**
alarm:

1. The kernel clears the guard bit the instant it fires — so from that moment the function is
   unhooked **for every thread in the process**, because the bit lives in the page table, not the
   thread.
2. Re-arming is deferred to a second exception (`STATUS_SINGLE_STEP`) on the faulting thread. If that
   thread is descheduled in between, the hole stays open for a scheduler quantum.
3. The guard covers a whole 4 KB page, so a call to any neighbouring libcurl function knocks it down
   too.
4. UE4 issues ~25–30 `curl_easy_setopt` calls per request across several threads, and Fortnite fetches
   its four hotfix files back to back in the same millisecond.

Any call landing in one of those holes runs the **real** function, its URL is never rewritten, and it
leaves for Epic. Ten distinct `FN-` correlation ids appear across the captured logs, and the captured
sequence shows the damage mechanism exactly:

```
04:56:48:489  Hotfix file (DefaultEngine.ini) downloaded. Size was (456)   <- ours
04:56:48:775  Invalid response. CorrId=FN-… code=401 "Token is missing key ID value"  <- ESCAPED
04:56:48:775  Hotfix file (DefaultGame.ini) failed to download
04:56:48:775  OnHotfixCheckComplete 0                                      <- WHOLE BATCH DISCARDED
```

UE4's hotfix batch is **all-or-nothing**, so one escaped file throws away every file in it —
including `DefaultEngine.ini`, which is what tells the client where the server is. That is the
"Fortnite was not started correctly" / stuck-in-matchmaking class of failure, and it is why it looks
random. The `QueryFriendSettings` escape found in the 2026-08-15 log is the same fault, later in the
session.

**The known fix is blocked, not unknown.** An inline hook has no unprotect window at all. 1.4.3
shipped one and hard-crashed the game loading the Frontend map; the 1.4.8 byte dump then established
that the scan point IS the function entry, which *removed* the explanation for that crash rather than
confirming it. Cobalt's own comment is right that shipping the same hook again on the theory "the
address must have been wrong" would repeat a known failure on an untested hypothesis.

**The config route now looks like the better fix, and this reframes it.** If the client's service
URLs already pointed at Nova, an *unhooked* `curl_easy_setopt` would set a URL that already goes to
Nova — the request would arrive anyway and the hook would stop being load-bearing. The evidence for
that route:

| question | answer | grade |
|---|---|---|
| Are there per-service config sections? | **Yes** — `OnlineSubsystemMcp.BaseServiceMcp` ×1, `…OnlineIdentityMcp` ×2, `…OnlineFriendsMcp` ×1 (UTF-16) | CONFIRMED |
| Are service URLs compiled in? | **Almost none** — only three `*.ol.epicgames.com` literals in 106 MB: `datarouter`, `metric-public-service-prod`, `fnreplay-public-service-prod11`. The rest come from config | CONFIRMED |
| Does the `[Section Env]` convention work on this build? | **Yes** — Nova's own hotfix uses `[OnlineSubsystemMcp.Xmpp Prod]` and XMPP works | CONFIRMED |
| Is the key called `Domain`? | **Unresolved** — `Domain` occurs 78× in UTF-16 but not within 4 KB of any of the three sections | UNKNOWN |
| What keys ARE near them? | Per-operation absolute-URL keys: `QueryOffersUrl`, `QueryItemsUrl`, `QueryCategoriesUrl`, `QueryEndpointsUrl`, `CheckAffiliateNameUrl`, `EnumerateUserFilesUrl`, `UserFileUrl`, `WriteUserFileUrl`, `ReceiptRoute`. **None for OnlineFriendsMcp** | STRONGLY SUPPORTED |

**Put it in the LOCAL `DefaultEngine.ini`, not the hotfix.** The hotfix is itself fetched over HTTP,
so it cannot protect the fetch of the hotfix — the bootstrap the batch failure destroys. The build's
own config file is read from disk before any network I/O, so an override there would apply from
startup and would cover the hotfix batch as well.

**Still not guessed.** A wrong INI key is merely ignored by UE4, so trying one is cheap — but it is
untestable from here, and shipping an unverified config change to a live deployment is what produced
1.5.2 and 1.5.6. **What would settle it:** a 7.40-era `DefaultEngine.ini` that uses these sections,
or one test launch with a candidate key and a check of whether the request lands on Nova.

---

## Open — P2

| id | grade | location | issue |
|---|---|---|---|
| ~~`selfcheck-wrong-gamelog-path`~~ | **FIXED 2026-09-05** | `diagnostics.rs` | Read the build folder; UE4 writes to `%LOCALAPPDATA%`. Now reads the two newest `FortniteGame*.log` there. First run produced NOVA-301 and NOVA-303. See [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) NOVA-AUDIT-014. |
| ~~`backend-eaddrinuse-zombie`~~ | **FIXED 2026-09-05** | `index.ts` | A failed HTTP bind is now fatal with a named cause and `exit(1)`. HTTPS stays non-fatal. Regression test spawns two real instances. NOVA-AUDIT-011's sibling; see `startup.test.ts`. |
| ~~`port-checks-have-no-identity-probe`~~ | **FIXED 2026-09-05** | `diagnostics.rs` | Now GETs `/nova/api/components` and requires a 200 **and** the expected body. Third outcome added for "something else is on this port". NOVA-AUDIT-015. |
| ~~`minhook-null-aliases-all-hooks`~~ | **FIXED 2026-09-06** | `dllmain.cpp:304-312` | Now refuses a null target and checks both MinHook status codes. Was unreachable in the shipped build — `USE_MINHOOK` is commented out — which the original grade never stated. See the detail below. |
| ~~`cobalt-reports-success-unverified`~~ | **FIXED 2026-09-06** | `Cobalt/dllmain.cpp:468-483` | `Hook()` returns a result, `InitializeCurlHook()` no longer returns an unconditional `true`, and the caller's existing failure path is now reachable. |
| ~~`cobalt-logs-bearer-tokens`~~ | **FIXED 2026-09-06** | `curlhook.h:80`, `log.cpp:73-88` | **Both halves closed.** `WriteLine` redacts every line through the existing tested `Nova::Diag::Redact`, covering the file *and* the upload at one choke point. |
| `trap8-systemic-unguarded-offsets` | CONFIRMED | `structs.cpp` | **Instrumented 2026-09-06, still open.** Every failed lookup is now recorded and reported after startup, and `GetOffsetChecked()` exists for migration. The ~306 remaining call sites are unchanged — deliberately. See the detail below. |
| `mcp-rvn-from-client` | CONFIRMED | `mcp.routes.ts:20-31` | Revisions computed from the client's `rvn` query param rather than stored state. Latent on 7.40, and **narrower than it looks**: a binary scan shows this build reads only `profileChangesBaseRevision` and `profileChanges` — `profileRevision`, `profileCommandRevision` and `responseVersion` are absent from it entirely, so those three are ignored. See [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §2b. |
| `common-core-stateless-rvn` | CONFIRMED | `common_core.ts:80,122` | `rvn`/`commandRevision` hard-coded to 1, never persisted. |
| `ws-root-path-fabricates-matchmaking` | CONFIRMED, **narrower than first stated** | `xmpp.server.ts` | A WS upgrade that is neither XMPP nor an EOS path registers a matchmaking waiter the instant it opens, and in P2P mode a waiter is demand — enough of it elects a host and starts a gameserver for nobody. **But it is not separable by path or subprotocol:** the real MMS client also connects to the *root* path with no usable subprotocol (39 coordinator upgrades recorded `"ws"` 15, `"wss"` 11, `""` 11, `"xmpp"` 2 — the first two are URL schemes, not subprotocols). EOS paths are already excluded upstream. **Do not invert the routing default on a guess** — the code says so too. Since 2026-08-31 the one unambiguous case, a *non-root* path, is recorded as an `UNEXPECTED_STATE` diagnostic instead of silently counting as a player. |
| `no-capability-floor` | CONFIRMED | `matchmaking.routes.ts:418-423` | No floor below which a machine is never elected host. |
| ~~`unauth-route-families`~~ | **CONFIRMED then FIXED 2026-08-31** | `social.routes.ts`, `eos.routes.ts` | Probed at last. It was real: unauthenticated callers could add a friend request to, block on, and unfriend from **any** account, in both families, persisting across a restart. Fixed with an ownership guard on both. The same probe found that the POST/DELETE forms 7.40 actually uses were never routed at all. See [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) NOVA-AUDIT-007. |

## Open — P3

| id | grade | location | issue |
|---|---|---|---|
| ~~`harvesting-wrong-property-name`~~ | **FIXED 2026-09-06** | `harvesting.cpp:109-114` | Cars could never yield materials — the consequence was graded PLAUSIBLE and is in fact unconditional. Fixed self-guardingly; see the detail below. |
| `clientquestlogin-grants-nothing` | CONFIRMED | `mcp.routes.ts:57-64` | Aliased to QueryProfile, so quest state is never created. 57 calls per session. |
| `stale-dist-preferred` | CONFIRMED | `main.rs:156-168` | `start_backend` prefers `dist/` over sources. |
| ~~`launcher-evidence-is-self-erasing`~~ | **FIXED 2026-09-06** | `main.rs:174-188` | `nova-agent.log` is opened **append** rather than `File::create`, with a session separator and 5MB rotation to one `.1` file. A crash-restart no longer destroys the log of the crash it is recovering from. |
| ~~`firewall-result-discarded`~~ | **FIXED 2026-09-06** | `tailscale.rs:269-289` | Both call sites now go through `ensure_firewall_reporting()`, which logs the outcome and surfaces a failure in `MeshStatus.detail`. Also reads **stdout** — netsh reports "requires elevation" there, so reading only stderr produced `Err("")`, an error carrying no information. |
| ~~`nova-307-dead-check`~~ | **FIXED 2026-09-05** | `diagnostics.rs` | Now reads `nova-agent.log`, reports any non-zero exit, and is called independently of `cobalt.log` existing. NOVA-AUDIT-014. |
| ~~`cobalt-stamp-frozen`~~ | **FIXED 2026-09-06** | `log.cpp:326` | Reads the DLL's own last-write time instead of log.cpp's compile time, so two different builds no longer self-identify identically. |
| ~~`config-comment-stale`~~ | **NOT A DEFECT — register was wrong, 2026-09-06** | `config.ts:96-105` | Re-checked: the only `definitions.h` that defines it says `inline float WarmupWaitSeconds = 90.f;` (line 59). The comment asserting 90s and ~30s of headroom is **correct**. This entry claimed 45.f at line 73; nothing in any of the four Reboot trees says that. Corrected rather than "fixing" an accurate comment. |
| `join-window-anchor` | CONFIRMED | `matchmaking.routes.ts` | The join window is stamped when a ticket first finds a registered gameserver, not when the server reports warmup start. Pre-existing; the wrong anchor is the real defect. |
| ~~`bundled-hotfix-wrong-xmpp-port`~~ | **FIXED 2026-09-06** | `resources/…/cloudstorage/DefaultEngine.ini` | The stale bundled copy (`ServerPort=3596` — nothing listens there in either mode: standalone is 3551, agent 3552) is **deleted**, so `seedCloudstorageDefaults()` generates it from the live port as designed. That function never overwrites an existing file, which is exactly why a bundled copy won permanently. `stage-backend.mjs` now REFUSES to ship if `DefaultEngine.ini` reappears in the payload — proven to fire. The other three hotfix .ini files carry no port and still ship. |
| `dependency-hygiene` | CONFIRMED | `Launcher/src-tauri/Cargo.toml`, `Launcher/package.json` | `mongodb = "2.8"` has **zero** usages in `src-tauri/src/`; `electron` has zero imports in `Launcher/src`; `warp` is used only for one `impl Reject`. Build weight only, no runtime effect. Not removed — verify against a full build first. |

---

## Fixed in the tree, NOT yet on any player's machine

### `curl-setopt-null-deref` · CONFIRMED · **FIXED 2026-09-06** · *new, found while fixing the above*
`InitializeCurlHook()` printed **"Failed to find CurlSetOptAddr! But we will go ahead.."** and
installed the detour anyway. That was not a degraded mode, it was a guaranteed crash:

```
CURLOPT_SSL_VERIFYPEER -> CurlSetOpt_(...) -> CurlSetOpt(data, option, arg)
CURLOPT_URL            -> CurlSetOpt_(...) -> CurlSetOpt(data, option, arg)
anything else          ->                     CurlSetOpt(data, tag, arg)
```

`CurlSetOpt` is a plain function pointer initialised to `nullptr` (`curlhook.h:13`) and **no path
checks it**. Installing the detour with it unresolved calls through null on the first
`curl_easy_setopt` the game makes — during startup, every time. Now refuses to install, sets the
failure status and raises `VERSION_MISMATCH`. The game then runs unredirected and says why, which is
recoverable; a null-deref inside a curl call is not, and looks like the game crashing on its own.

**Bearing on `nova-303-request-escape`: WITHDRAWN 2026-09-06, same day it was raised.** This was
offered as a candidate explanation for the unexplained 1.4.3 inline-hook crash — a null `CurlSetOpt`
being survivable under VEH but fatal under an inline hook. `git show 69ac12f` disproves it: 1.4.3
carried the same three `CurlSetOpt` fallback signatures the code has now, and the pointer resolves on
7.40 (redirection works), so it resolved then too. The guard stands on its own merits; it explains
nothing about 1.4.3.

### `minhook-null-aliases-all-hooks` · CONFIRMED · **FIXED 2026-09-06**
`MH_ALL_HOOKS` is `#define`d to `NULL` (`vendor/MinHook/MinHook.h:88`), so `MH_EnableHook(nullptr)`
means *enable every hook created so far*. `Hook()` now refuses a null target and reports it.

Worth recording precisely: it was **unreachable in the shipped build** — `USE_MINHOOK` is commented
out in `settings.h`, so the VEH branch is what compiles. The grade was right and the reachability was
never stated. Fixed anyway, because "safe because of one commented-out `#define`" is not a property
to rely on.

### `cobalt-reports-success-unverified` · CONFIRMED · **FIXED 2026-09-06**
`Hook()` returned `void` and discarded both MinHook status codes; `InitializeCurlHook()` returned an
unconditional `true`. So "Cobalt v0.1 initialized sucessfully" was printed whether or not anything
had been hooked. `Hook()` now returns a result, both status codes are checked and named, and the
caller's existing failure path — which was correct all along and simply unreachable — now runs.

### `cobalt-logs-bearer-tokens` · CONFIRMED · **FIXED 2026-09-06** · *both halves now closed*
The remaining half was the plaintext token in `cobalt.log` **on disk** — a file players are routinely
asked to send when something breaks, which is exactly when a live token gets pasted into a chat.

`Cobalt::Log::WriteLine` now redacts every line through `Nova::Diag::Redact`. That is the only choke
point needed: `std::cout` is redirected into `QueueStreamBuf`, which calls `WriteLine` per line, and
**both** consumers — the file blob and the JSON upload body — are built from the queue it fills.
Reuses the existing redactor rather than adding a second: `tests/test_redact.cpp` covers it (11 cases
plus a Cobalt/Reboot drift check, all passing), and two implementations would drift.

### `cobalt-stamp-frozen` · CONFIRMED · **FIXED 2026-09-06**
The banner used `__DATE__ " " __TIME__`, which is **log.cpp's** compile time — and log.cpp changes far
less often than dllmain.cpp, so two genuinely different builds introduced themselves identically.
Now reads the DLL's own last-write time via `GetModuleHandleEx` + `GetFileAttributesEx`, which
changes whenever the linker runs regardless of which source file caused it. Falls back to the macros
if the module path cannot be read.

This matters more than a P3 usually would: this project's recurring failure is a component being
older than everyone assumes, and the banner is the one place that should have said so.



### `trap8-systemic-unguarded-offsets` · CONFIRMED · **INSTRUMENTED 2026-09-06 · still open**
307 lookup sites (re-counted; the register said 299) treat `GetOffset`'s return of **0** as a usable
offset. It means both *"this member does not exist on this build"* and *"it exists and it is the
first one"*, and the caller cannot tell which — so the standard pattern silently reads the start of
the struct and then dereferences it.

**Not theoretical:** `harvesting-wrong-property-name` was exactly this shape, and cars could never
yield materials because of it.

**Why this is not "fixed" by editing 307 call sites.** That is a mechanical change across a
gameserver that cannot be tested in this environment, where a wrong offset is a crash on a player's
machine. The change would be far more dangerous than the bug. So the work done is the part that
makes fixing them *possible*, and none of it alters a single decision the code makes:

| | |
|---|---|
| **All failures are now recorded** | `GetProperty` and `GetPropertySlow` call `Offsets::NoteMissing()` on every miss — **including when the caller suppressed the warning**, which is how probes hid theirs. Deduplicated by (owner, member), thread-safe. |
| **And reported, once, after startup** | `Offsets::Report()` runs from `dllmain.cpp` right after `"Initialized"` and prints every distinct miss with the owning class named. |
| **The owner is resolved LATE, on purpose** | `NoteMissing` stores the `UObject*`, not its name. `GetName()` is a `ProcessEvent` into `KismetSystemLibrary`, and the record path runs from `static auto` initialisers whose timing is arbitrary — possibly before the engine can service that call. Doing engine work on an error path, to describe the error, is how a diagnostic becomes the outage. |
| **A safe accessor exists for migration** | `UObject::GetOffsetChecked()` returns **-1** for an absent member (not 0, which is valid), asks `GetProperty` rather than inferring from a returned 0, and returns -1 rather than crashing on a null `this` — `FindObject` returns null for a class a build lacks, and calling straight through it is the easiest mistake here. |
| **One site migrated** | `harvesting.cpp`'s `ParamOffset` now uses it, so there is one implementation of the pattern rather than two. |

The old warning text was `"Failed to find3 <member>"` — no owner, a tag nobody can grep, and one
line in a log full of them. Now `"Failed to find property 'X' (see the offset report)"`, with the
owner in the report where naming it is safe.

**What is still open:** the other ~306 sites. **The next step is not to edit them blindly** — it is
to run a match, read the report, and migrate the ones that actually fail on 7.40. That list has never
existed before; now it does. Note that not every entry will be a defect: a lookup on a class that
legitimately lacks an optional member appears too.

### `harvesting-wrong-property-name` · CONFIRMED · **FIXED 2026-09-06** · *consequence upgraded from PLAUSIBLE to certain*
All six Car parameter lookups in `harvesting.cpp` asked for `"InstigatedBy"`. The commented-out
originals beside them named `DamageCauser` and `Damage`, and the `BuildingActor` block immediately
below does it correctly — so the intent was never in doubt.

**The consequence is not "likely no materials", it is unconditional.** `DamageCauserOffset` equalled
`InstigatedByOffset`, so:

```cpp
auto InstigatedBy = *(UObject**)(Parameters + InstigatedByOffset);   // the controller
auto DamageCauser = *(UObject**)(Parameters + DamageCauserOffset);   // the SAME controller
...
if (!DamageCauser->IsA(FortWeaponPickaxeAthenaClass) && !DamageCauser->IsA(MeleeClass))
    return false;
```

`InstigatedBy` has just passed `Helper::IsPlayerController` on the line above, and a PlayerController
is never a pickaxe or a melee weapon — so that early return fired on **every** car hit and `Harvest`
was unreachable for `Car_DEFAULT` and `Car_Copper`. `Damage` pointed at the same slot too, making a
`float*` out of half a UObject pointer; it escaped being dereferenced only because the function
returned above it, which would have become a live crash the moment the class check alone was fixed.

Independently confirmed against the shipped binary: it contains the string `DamageCauser` exactly
**once** — the single correct `BuildingActor` lookup. The rebuilt DLL contains it four times.

**SELF-GUARDING, because none of this can be tested here.** A match cannot be run in this
environment and a wrong offset in the gameserver is a crash on a player's machine, so the fix is
built to be safe when it is wrong. New `ParamOffset()` helper:

| hazard | old code | now |
|---|---|---|
| `FindObject` returns null on a build without that blueprint | `Fn->GetOffset(...)` — null dereference | returns -1, logs |
| `GetOffset` returns 0 for both *absent* and *first member* (`trap8-systemic-unguarded-offsets`) | indistinguishable | asks `GetProperty` first, which is null only when genuinely absent |
| the correct name may not exist on some build | n/a | falls back to `"InstigatedBy"` — **exactly today's behaviour**, so a build without the field is no worse off |
| an unusable offset reaching the read | would index before the struct and dereference garbage | `-1` sentinel (not 0, which is a valid offset) checked at the point of use |

So on a build that has `DamageCauser`/`Damage`, cars harvest. On one that does not, behaviour is
byte-for-byte what it was. Neither path can read wild memory.

### `cobalt-sigscan-hangs-forever` · CONFIRMED · **FIXED 2026-09-06**
`dllmain.cpp` `InitializeCurlHook()` retried the `curl_easy_setopt` signature in
`while (!addr) { addr = sigscan(same); Sleep(200); }` — **unbounded**. On any build the signature was
not written for, the game did not fail, it **hung silently forever**. The `if (!CurlEasySetOptAddr)`
check below it was unreachable, and its author had marked it `// impossibel ol`. The caller already
implemented a proper failure path — status line plus message box — which could never run.

Now bounded to 100 × 200 ms (20 s, far longer than module mapping takes), then it logs
"This build is probably not 7.40", sets the failure status, and raises a `VERSION_MISMATCH`
diagnostic from `Source::Version` so an unsupported build appears on the coordinator dashboard as
what it is rather than as a network fault. Built and verified: the new strings are present in
`Cobalt.dll` with a positive and a negative control in the same scan.

### `reboot-dll-present-always-false-for-players` · CONFIRMED · **FIXED 2026-09-06**
`tailscale.rs` `reboot_dll_present()` checked **one absolute path on the developer's machine** and
nothing else:

```
C:\Users\Admin\Documents\backends\_extracted\Project-Reboot-main\Project Reboot\x64\Release\Project Reboot.dll
```

On that machine it answered `true`. **On every real installation it answered `false`** — reporting
the gameserver DLL as missing while it sat correctly bundled under `resources/`. `inject_reboot`
resolved the same file properly (`beside_exe` first), so two functions answered the same question
differently and only one of them was right. Both now share `host::resolve_reboot_dll()`.

### `reboot-authoritative-tree-was-not-the-one-referenced` · CONFIRMED · **FIXED 2026-09-06**
The hardcoded path above pointed into `Documents\backends\_extracted\`, which is **not** where the
shipped DLL comes from. There are five Project Reboot checkouts on this machine:

| tree | built DLL |
|---|---|
| **`Project Nova/Project-Reboot-DLL/`** (in this repo, git-tracked) | **`25011fc5c3de` · 796,672 · 5 Sep — this is what ships** |
| `backends/_extracted/Project-Reboot-main/` | `1f97f85d999e` · 778,752 · 26 Jul |
| `backends/_extracted/Project-Reboot-main_backup-nova/` | — |
| `backends/_backup-reboot-20260720-092843/` | — |
| `backends/Fortnite-GS-Archive-release3/Project Reboot (S3-S18)/` | — |

`DEFAULT_REBOOT_DLL` is gone; the dev-tree fallback resolves `Project-Reboot-DLL/` relative to the
exe. Also corrected in memory, which named the wrong tree.

### `reboot-dll-stale-beside-dev-exe` · CONFIRMED · **FIXED 2026-09-06**
The same defect as `cobalt-dll-three-live-copies`, in a third component and found the same way.
`beside_exe()` is asked first, so a dev-tree launcher injected
`target/release/Project Reboot.dll` — the **26 July** build — while players got the 5 September
bundle. The developer was testing a different gameserver from the one that ships.

`tools/stage-cobalt.mjs` now covers both native DLLs:

```bash
node tools/stage-cobalt.mjs --check           # Cobalt
node tools/stage-cobalt.mjs reboot --check    # Project Reboot
```

**Three components have now had this exact bug** — backend payload, Cobalt, Reboot. The pattern is
always: built to one path, loaded from another, nothing comparing them. Any new bundled artefact
needs its `--check` in the same commit.

### `cobalt-dll-three-live-copies` · CONFIRMED · **FIXED 2026-09-06**
The same "fixed in source, not shipped" failure as `stale-dist-preferred`, in a second component.
`build.ps1 -Deploy` copied `Cobalt.dll` to `target/release` and `target/debug` only — **not** to
`resources/`, which is what `tauri.conf.json` bundles. And `carter.rs` resolves via
`beside_exe("Cobalt.dll")` **first**, so the build output was the one copy guaranteed not to load.

Three different builds were live simultaneously:

| hash | date | path | who loads it |
|---|---|---|---|
| `a62d20cc` | 2026-09-06 | `cobalt/x64/Release/` | nobody |
| `22c87f01` | 2026-09-05 | `src-tauri/resources/` | an installed launcher; shipped in 1.6.0 |
| `84622a61` | **2026-07-25** | `src-tauri/target/release/` | **a dev-tree launcher, first** |

Fixed by `tools/stage-cobalt.mjs`, mirroring `stage-backend.mjs`: it copies the build output to all
five consumed locations and `--check` exits 1 if any differs. Wired into RELEASING.md next to the
backend check.

**The pattern, now seen twice:** a component is built to one path and loaded from another, with
nothing comparing them. When adding any new bundled artefact, add its `--check` at the same time.

Everything in this section is done and tested in source. It reaches players only when a launcher
installer is next built and released. Recorded separately because conflating the two is exactly the
mistake that produced NOVA-AUDIT-013.

| fix | reaches players via | status |
|---|---|---|
| NOVA-AUDIT-014 self-check reads the real game log; NOVA-307 reads `nova-agent.log` | next installer (Rust) | pending |
| NOVA-AUDIT-015 port identity probe | next installer (Rust) | pending |
| all backend fixes on a player's own host agent | next installer, after `node tools/stage-backend.mjs` | payload staged, **release pending** |
| all backend fixes on the coordinator | direct deploy | **DONE 2026-09-05** |

### The coordinator deploy, 2026-09-05 — and a correction

`~/nova-backend` is **not a git checkout**; it was populated by file copy, so "it runs `tsx src/`"
never meant "it is current". Checked rather than assumed on 2026-09-05: it had the 2026-08-15 work
and **none** of the 2026-08-31 work — no `diagnostics.ts`, no `latent.routes.ts`, no URL redaction,
and **no friends ownership guard**. Tailscale Funnel publishes `:8443 → 127.0.0.1:3551` to the open
internet, so `unauth-route-families` was live and remotely reachable, not bounded to localhost as
this document previously implied.

Deployed and verified the same day. Probes against the live box afterwards:

| probe | before | after |
|---|---|---|
| unauth `POST /friends/api/public/friends/{victim}/{attacker}` | wrote the friendship | **401**, nothing persisted |
| unauth `POST /friends/api/v1/{victim}/friends/{attacker}` | wrote it | **401** |
| unauth `POST /epic/friends/v1/{dep}/users/{victim}/blocked/{x}` | wrote it | **401** |
| `eg1~` canary in a URL path, read back from unauthenticated `/nova/api/logs` | served raw | **`eg1~<redacted>`** |
| same canary through `/nova/api/logs/ingest` (NOVA-AUDIT-012) | served raw | **`eg1~<redacted>`** |

Unchanged controls in the same run: timeline 2 408 B, lightswitch 330 B, `versioncheck`
`{"type":"NO_UPDATE"}`, catalog 8 630 B, `oauth/token` still mints. `/nova/api/diagnostics` answers
for the first time on that box. Procedure and probes: [coordinator/README.md](coordinator/README.md).

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


---

## Audit — MCP operation coverage vs the 7.40 client

Measured 2026-09-06 by scanning the shipping client for all 149 operation names the endpoint corpus
documents, with controls in both directions (`QueryProfile`, `ClientQuestLogin`, `CreateNewIsland`
PRESENT; `ProtoJuno_CreateWorld` ABSENT). Reproduce with:

```bash
node tools/binscan.js <exe> count $(ls <corpus>/FN-Service/Game/Profile/Operations | sed 's/\.md$//')
```

**84 of 149 exist in 7.40. Nova handles 34.** The two-way diff is the useful part.

### Nova handles it, but 7.40 does not have it — 7 operations · CONFIRMED · not a defect

`AthenaPinQuest` · `CompletePlayerSurvey` · `CopyCosmeticLoadout` · `DeleteCosmeticLoadout` ·
`SetCosmeticLockerBanner` · `SetCosmeticLockerSlot` · `SetHardcoreModifier`

Mostly *correct* and worth stating as such: `SetCosmeticLockerSlot` / `SetCosmeticLockerBanner` are
the later-era locker path, and Nova also implements 7.40's own `EquipBattleRoyaleCustomization` /
`SetBattleRoyaleBanner`. That is real cross-version support that already existed and was undocumented.

One genuine oddity: **`AthenaPinQuest` is handled and is absent from 7.40**, while
`AthenaTrackQuests` — which the corpus says replaced it — is *not* handled. So the quest-pinning
handler covers a middle era and neither end of the range. Harmless today (nothing calls it), recorded
because it looks like support and is not.

### 7.40 has it, Nova does not handle it — 63 operations · CONFIRMED · mostly correct

These fall to the `default:` branch, which returns an empty-success envelope rather than a 404. That
is the deliberate and right answer for almost all of them: **the large majority are Save the World**
(expeditions, homebase, squads, collection book, crafting, research, world items) **or Creative**
(islands, plot permissions), and Nova is a Battle Royale backend. A 404 would be worse.

The ones that are *not* obviously out of scope, listed so the decision is explicit rather than
implicit:

| operation | note |
|---|---|
| `QueryPublicProfile` | other players' profiles — BR-relevant |
| `ClaimQuestReward` · `UpdateQuests` · `UpdateQuestClientObjectives` | BR challenges. Compare `clientquestlogin-grants-nothing` in P3: quest state is never created, so there is nothing for these to act on either. Same root cause. |
| `EndBattleRoyaleGame` | match-end stats. Corpus marks it **`DedicatedServer ONLY`**, and Nova's `dedicated_server` route deliberately refuses unauthenticated mutations, so this is gated by an existing security decision rather than missing. `EndBattleRoyaleGameV2` is ABSENT from 7.40 — this build is on the V1 side of that boundary. |
| `LockProfileForWrite` · `UnlockProfileForWrite` | also **`DedicatedServer ONLY`**. Empty success is defensible for a backend with no concurrent profile writers. |
| `SetGameplayStats` · `ServerQuestLogin` · `SetMtxPlatform` · `SkipTutorial` | never observed in a session; no evidence any of them is needed. |

### The corpus itself is modern-biased — worth knowing before trusting it on Chapter 1

Scanning the 34 operations Nova handles directly against the client (rather than deriving them by
set arithmetic against the corpus) turned up two that are **in 7.40 and not documented in the corpus
at all**: `EquipBattleRoyaleCustomization` and `SetBattleRoyaleBanner` — which are precisely 7.40's
own locker and banner paths, the ones this deployment depends on every session.

So the 149-operation list is not a superset of what old builds use, and absence from it is not
evidence of anything. Of Nova's 34 handlers, **22 are present in 7.40 and 12 are absent**;
`operations.test.ts` pins both sets and fails if a handler is added or removed without the audit
moving with it.

**Nothing here is being implemented on this evidence.** A literal in a shipping binary proves the
build knows the name, not that any reachable path calls it — and none of these appear in the observed
request log. Recorded so that "Nova handles 34 MCP operations" is not mistaken for coverage.

## Cannot be answered from current evidence

> **Updated 2026-09-05.** Two long-standing items below moved, and one new limit appeared.


1. **Anything about the laptop.** No laptop artifact has ever been examined. Every cross-machine
   claim is a mechanism read out of PC-side code.
2. **Whether a two-machine session has ever worked.** The only end-to-end success on record is the PC
   connecting to *itself* over its own tailnet address.
3. ~~**Whether `social.routes.ts` / `eos.routes.ts` are exploitable in practice.**~~ **Answered
   2026-08-31: yes, and both are now fixed.** Note the shape of the mistake — the finding sat at
   PLAUSIBLE for two weeks because probing it was deferred, and it turned out to be a real P1 that
   took one afternoon to confirm. The remaining unprobed items below deserve the same suspicion.
4. ~~**Whether the coordinator and a host agent can open the same `DB_PATH` concurrently, and
   `database.ts` (999 lines) has never been audited.**~~ **Both answered 2026-08-31.** Measured with
   two real processes on one file: no corruption, no `SQLITE_BUSY` — but **393 of 800 increments
   silently lost** to a read-modify-write, now fixed and re-measured at 800/800. The audit also found
   the tokens table was never purged (201 rows, 100% expired) and a timestamp-format split that makes
   date comparisons in SQL unsafe. See [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) NOVA-AUDIT-009
   and -010, and [ARCHITECTURE.md](ARCHITECTURE.md) §4.
5. ~~**Whether 7.40 sends the `xmpp` WebSocket subprotocol.**~~ **Partly answered 2026-08-31.** The
   client binary contains `Sec-WebSocket-Protocol` and 27/28 occurrences of `xmpp`, so the machinery
   exists (STRONGLY SUPPORTED). That is not the same as observing the header on the wire for the
   XMPP connection specifically, so `ws-root-path-fabricates-matchmaking` stays open — but the
   cheap remaining step is now just logging `Sec-WebSocket-Protocol` on upgrade in
   `xmpp.server.ts`, not a two-machine experiment.
6. ~~**Endpoint coverage for flows the six retained sessions never exercised.**~~ **Answered
   2026-08-31** — the client's full 83-fragment endpoint table was extracted from the binary; see
   [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §2a. 44 routed, 39 latent-and-unrouted, none
   of them a bug today. Also self-answering at runtime via
   `GET /nova/api/diagnostics?category=MISSING`.

7. ~~**Why the escaped request escapes.**~~ **ANSWERED — and it always was.** The mechanism is
   documented in Cobalt's own source and has been since 2026-08-01: the VEH page-guard hook has a
   one-shot guard bit and a deferred re-arm, so there is a window in which the function is unhooked
   for every thread. See `nova-303-request-escape` above. **The lesson is about method, not about
   curl:** this sat recorded as "cannot be answered" for a day because the investigation searched
   logs and binaries and did not read the source of the component being investigated.

8. **The per-service config key names.** The 7.40 binary has `OnlineSubsystemMcp.OnlineFriendsMcp`
   and friends, so service base URLs are configurable — which would make the redirect independent of
   the hook. The KEY names inside those sections are not established, and guessing them would be a
   Rule 5 violation. **What would settle it:** UTF-16 string extraction around those section names,
   or a 7.40-era `DefaultEngine.ini` from any source that used them.
