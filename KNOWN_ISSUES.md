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

---

### `nova-303-request-escape` · CONFIRMED · **now has a named endpoint** · open
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

**What is known:** the endpoint IS routed by Nova (`social.routes.ts`, 59 calls in the retained
sessions), so this is not a coverage gap — the request never arrived. The hotfix Nova serves
(`data/cloudstorage/DefaultEngine.ini`) overrides **no service base URLs at all**, only XMPP and the
party system, so every HTTP service URL comes from the client's compiled-in defaults and Cobalt's
hook is the only thing redirecting them.

**A lead, and how far it was taken (2026-09-05).** If service URLs are *configurable*, a hotfix
could point them at Nova directly and the redirect would no longer depend on Cobalt's hook at all —
for every service, not just this one. That would retire a whole class of failure without a DLL
release. What the binary says:

| question | answer | grade |
|---|---|---|
| Are there per-service config sections? | **Yes** — `OnlineSubsystemMcp.BaseServiceMcp` ×1, `…OnlineIdentityMcp` ×2, `…OnlineFriendsMcp` ×1 (UTF-16) | CONFIRMED |
| Are service URLs compiled in? | **Almost none.** Only three `*.ol.epicgames.com` literals exist in the whole 106 MB binary: `datarouter`, `metric-public-service-prod`, `fnreplay-public-service-prod11`. Everything else comes from config | CONFIRMED |
| Does the `[Section Env]` convention work on this build? | **Yes** — Nova's own hotfix already uses `[OnlineSubsystemMcp.Xmpp Prod]` and XMPP works | CONFIRMED |
| Is the key called `Domain`? | **Unresolved.** `Domain` occurs 78× in UTF-16 but **not** within 4 KB of any of the three section names | UNKNOWN |
| What keys ARE near them? | Per-operation absolute-URL keys: `QueryOffersUrl`, `QueryItemsUrl`, `QueryCategoriesUrl`, `QueryEndpointsUrl`, `CheckAffiliateNameUrl` (BaseServiceMcp); `EnumerateUserFilesUrl`, `UserFileUrl`, `WriteUserFileUrl`, `RequestUsageInfoUrl`, `ReceiptRoute` (OnlineIdentityMcp). **None for OnlineFriendsMcp** | STRONGLY SUPPORTED |

So the model is probably per-operation URL keys rather than one base `Domain` — but string pooling
means proximity is weak evidence in both directions, and the friends section yielded no keys at all.

**Not guessed, deliberately.** A wrong INI key is merely ignored by UE4, so trying one is *cheap* —
but it is untestable from here, and shipping an unverified config change to a live deployment is
precisely what produced 1.5.2 and 1.5.6. **What would settle it:** a 7.40-era `DefaultEngine.ini`
from any source that used these sections, or one test launch with a candidate key and a check of
whether the request lands on Nova.

Note `QueryEndpointsUrl` alongside the client's `%s/api/endpoints` fragment — that looks like service
discovery, which would be a cleaner lever than overriding each service. It is routed by Nova only as
a Tier-2 stub (`200 {}`), has never been observed being called, and **nothing in the corpus documents
its shape.**

---

## Open — P2

| id | grade | location | issue |
|---|---|---|---|
| ~~`selfcheck-wrong-gamelog-path`~~ | **FIXED 2026-09-05** | `diagnostics.rs` | Read the build folder; UE4 writes to `%LOCALAPPDATA%`. Now reads the two newest `FortniteGame*.log` there. First run produced NOVA-301 and NOVA-303. See [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) NOVA-AUDIT-014. |
| ~~`backend-eaddrinuse-zombie`~~ | **FIXED 2026-09-05** | `index.ts` | A failed HTTP bind is now fatal with a named cause and `exit(1)`. HTTPS stays non-fatal. Regression test spawns two real instances. NOVA-AUDIT-011's sibling; see `startup.test.ts`. |
| ~~`port-checks-have-no-identity-probe`~~ | **FIXED 2026-09-05** | `diagnostics.rs` | Now GETs `/nova/api/components` and requires a 200 **and** the expected body. Third outcome added for "something else is on this port". NOVA-AUDIT-015. |
| `minhook-null-aliases-all-hooks` | CONFIRMED | `dllmain.cpp:304-312` | `MH_EnableHook((PVOID)0)` **is** `MH_ALL_HOOKS`; a failed signature scan silently enables everything. |
| `cobalt-reports-success-unverified` | CONFIRMED | `Cobalt/dllmain.cpp:468-483` | Prints "initialised successfully" without checking the hook installed. |
| `cobalt-logs-bearer-tokens` | CONFIRMED, **narrowed 2026-09-05** | `curlhook.h:80`, `log.cpp:73-88` | `eg1~` JWTs written to `cobalt.log` and POSTed to the backend. The backend now **redacts on ingest** (NOVA-AUDIT-012), so nothing Cobalt sends is stored or served with a live token — that half needed no DLL release and the earlier framing of it as "the Cobalt half" was what kept it open. What remains is only the plaintext token in `cobalt.log` **on disk**, which needs a Cobalt build. |
| `trap8-systemic-unguarded-offsets` | CONFIRMED | `structs.cpp:414-422` | Offset-0-means-failure unchecked at most assignment sites (257 of 299 with no in-file zero-check). |
| `mcp-rvn-from-client` | CONFIRMED | `mcp.routes.ts:20-31` | Revisions computed from the client's `rvn` query param rather than stored state. Latent on 7.40, and **narrower than it looks**: a binary scan shows this build reads only `profileChangesBaseRevision` and `profileChanges` — `profileRevision`, `profileCommandRevision` and `responseVersion` are absent from it entirely, so those three are ignored. See [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §2b. |
| `common-core-stateless-rvn` | CONFIRMED | `common_core.ts:80,122` | `rvn`/`commandRevision` hard-coded to 1, never persisted. |
| `ws-root-path-fabricates-matchmaking` | CONFIRMED, **narrower than first stated** | `xmpp.server.ts` | A WS upgrade that is neither XMPP nor an EOS path registers a matchmaking waiter the instant it opens, and in P2P mode a waiter is demand — enough of it elects a host and starts a gameserver for nobody. **But it is not separable by path or subprotocol:** the real MMS client also connects to the *root* path with no usable subprotocol (39 coordinator upgrades recorded `"ws"` 15, `"wss"` 11, `""` 11, `"xmpp"` 2 — the first two are URL schemes, not subprotocols). EOS paths are already excluded upstream. **Do not invert the routing default on a guess** — the code says so too. Since 2026-08-31 the one unambiguous case, a *non-root* path, is recorded as an `UNEXPECTED_STATE` diagnostic instead of silently counting as a player. |
| `no-capability-floor` | CONFIRMED | `matchmaking.routes.ts:418-423` | No floor below which a machine is never elected host. |
| ~~`unauth-route-families`~~ | **CONFIRMED then FIXED 2026-08-31** | `social.routes.ts`, `eos.routes.ts` | Probed at last. It was real: unauthenticated callers could add a friend request to, block on, and unfriend from **any** account, in both families, persisting across a restart. Fixed with an ownership guard on both. The same probe found that the POST/DELETE forms 7.40 actually uses were never routed at all. See [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) NOVA-AUDIT-007. |

## Open — P3

| id | grade | location | issue |
|---|---|---|---|
| `harvesting-wrong-property-name` | CONFIRMED | `harvesting.cpp:109-114` | Four offset lookups ask for `"InstigatedBy"` where the variable names say `DamageCauser`/`Damage`. Cars likely yield no materials (PLAUSIBLE, not observed). |
| `clientquestlogin-grants-nothing` | CONFIRMED | `mcp.routes.ts:57-64` | Aliased to QueryProfile, so quest state is never created. 57 calls per session. |
| `stale-dist-preferred` | CONFIRMED | `main.rs:156-168` | `start_backend` prefers `dist/` over sources. |
| `launcher-evidence-is-self-erasing` | CONFIRMED | `main.rs:174-188` | `nova-agent.log` truncated on every start; proxy has no log at all. |
| `firewall-result-discarded` | CONFIRMED | `tailscale.rs:269-289` | Firewall-rule result discarded at both call sites; error read from the wrong stream. |
| ~~`nova-307-dead-check`~~ | **FIXED 2026-09-05** | `diagnostics.rs` | Now reads `nova-agent.log`, reports any non-zero exit, and is called independently of `cobalt.log` existing. NOVA-AUDIT-014. |
| `cobalt-stamp-frozen` | CONFIRMED | `log.cpp:326` | Banner stamp is `log.cpp`'s compile time, so two different binaries self-identify identically. |
| `config-comment-stale` | CONFIRMED | `config.ts:96-105` | Asserts `WarmupWaitSeconds = 90s`; `definitions.h:73` is now `45.f`, making the documented "~30s of headroom" negative. **Comment only — do not "fix" the value**, see below. |
| `join-window-anchor` | CONFIRMED | `matchmaking.routes.ts` | The join window is stamped when a ticket first finds a registered gameserver, not when the server reports warmup start. Pre-existing; the wrong anchor is the real defect. |
| `bundled-hotfix-wrong-xmpp-port` | CONFIRMED, latent | `resources/…/cloudstorage/DefaultEngine.ini:3-4` | Bundled hotfix hard-codes `ws://127.0.0.1:3596`. Not live in P2P mode (cloudstorage always comes from the coordinator); would bite in standalone/LAN. |
| `dependency-hygiene` | CONFIRMED | `Launcher/src-tauri/Cargo.toml`, `Launcher/package.json` | `mongodb = "2.8"` has **zero** usages in `src-tauri/src/`; `electron` has zero imports in `Launcher/src`; `warp` is used only for one `impl Reject`. Build weight only, no runtime effect. Not removed — verify against a full build first. |

---

## Fixed in the tree, NOT yet on any player's machine

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

7. **Why the escaped request escapes.** NOVA-303 now has a named endpoint and proof of who answered,
   but not a mechanism. The request is `QueryFriendSettings` at XMPP-login time; Cobalt's hook covers
   `*.ol.epicgames.com` and the endpoint is routed by Nova, so "the hook missed this one call" is a
   description, not a cause. **What would settle it:** a `cobalt.log` and a `FortniteGame.log` from
   the SAME launch — the escaped call is by definition absent from `cobalt.log`, so the pair of files
   localises it to the exact request the hook did not see, and the surrounding lines say what was
   different about it.

8. **The per-service config key names.** The 7.40 binary has `OnlineSubsystemMcp.OnlineFriendsMcp`
   and friends, so service base URLs are configurable — which would make the redirect independent of
   the hook. The KEY names inside those sections are not established, and guessing them would be a
   Rule 5 violation. **What would settle it:** UTF-16 string extraction around those section names,
   or a 7.40-era `DefaultEngine.ini` from any source that used them.
