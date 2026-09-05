# REGRESSION_HISTORY

One entry per fixed defect. The rule: **a fix without a regression test is not finished**, and a fix
whose verification has no control in the same run is not verified.

Format per [AUDIT_PROMPT.md](AUDIT_PROMPT.md) Phase 11: id · symptom · root cause · affected version ·
subsystem · evidence · fix · regression test · date.

---

## NOVA-AUDIT-001 — live bearer tokens served to unauthenticated callers

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Severity** | P1 (credential disclosure) |
| **Subsystem** | backend / nova diagnostics |
| **Affected versions** | all Nova backends; every deployment |
| **Grade** | CONFIRMED — reproduced with a canary, control in the same run |

**Symptom.** None visible. That is the point: nothing failed, so nothing drew attention to it.

**Root cause.** Three separately reasonable decisions composing into a leak:

1. `index.ts` logged `request.url` verbatim on every request.
2. Fortnite 7.40 puts a **live session token in the URL path** — every sign-out is
   `DELETE /account/api/oauth/sessions/kill/eg1~<jwt>`. 76 such calls in the retained `cobalt.log`.
3. `logStore.installLogCapture()` captures all console output into a ring buffer, and
   `GET /nova/api/logs` serves that buffer **with no `Authorization` header required**.

So any caller who could reach the backend could poll the log endpoint and harvest live tokens. On the
coordinator this matters more than it looks: `tailscale funnel status` confirms `:8443` is served to
the public internet.

**Evidence.**

```
# planted a canary token in the path, then read the log back unauthenticated
$ curl -X DELETE .../account/api/oauth/sessions/kill/eg1~AUDITCANARY2.x.y
$ curl .../nova/api/logs            # no Authorization header
  "msg":"[HTTP] DELETE /account/api/oauth/sessions/kill/eg1~AUDITCANARY2.x.y"
```

**Fix.** `redactSecrets()` in `services/nova/diagnostics.ts`, applied in the request logger, the
not-found handler and the error handler. Strips `eg1~` tokens, bare JWTs, secret-bearing query
parameters and `Basic`/`Bearer` credentials, while keeping the endpoint identity readable.

Chosen over requiring auth on `/nova/api/logs` because redaction **removes the secret from the data**
rather than moving the boundary — it protects every consumer of the buffer, including the console and
any future export, and it cannot break a launcher in the field. The residual (account ids, internal
endpoint names remain visible) is recorded in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

**Verified, with controls in the same run:**

| probe | before | after |
|---|---|---|
| canary token in unauthenticated `/nova/api/logs` | **present** | **0 occurrences** |
| redaction marker `eg1~<redacted>` | — | present |
| control: `GET` unrouted path | `200`, 2 B | `200`, 2 B (unchanged) |
| control: `POST` unrouted path | `204` | `204` (unchanged) |
| control: `GET /fortnite/api/game/v2/enabled_features` | `[]` | `[]` (unchanged) |
| control: `GET /fortnite/api/v2/versioncheck/Windows` | `{"type":"NO_UPDATE"}` | unchanged |

**Regression tests.** `src/services/nova/diagnostics.test.ts` → `redactSecrets` suite (5 tests),
including the exact 7.40 sign-out URL shape and a test asserting that an ordinary URL is left
untouched.

**Still open:** the Cobalt-side half. `cobalt.log` and the log lines Cobalt POSTs to the backend still
contain raw `eg1~` tokens (`curlhook.h:80`, `log.cpp:73-88`). That needs a DLL rebuild and is not in
this change.

---

## NOVA-AUDIT-002 — diagnostic evidence evicted before it could be read

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Severity** | P2 (diagnosability) |
| **Subsystem** | backend / nova diagnostics |
| **Grade** | CONFIRMED — measured, then reproduced |

**Symptom.** Every investigation into a player-reported failure found the relevant log lines already
gone. This is the reason the project's central question — *what failed, where, why, in which
version* — has never been answerable from the running system.

**Root cause.** `logStore.ts` is an 800-entry FIFO and `index.ts` writes one line per request. The
busiest single minute in the retained `cobalt.log` is **289 client requests**, so the entire
diagnostic window is **under three minutes**, and a repeated problem evicts everything else first.

**Evidence.** Measured against a scratch backend, not estimated:

```
planted a marker line, then fired the observed 289 req/min
  after 289 requests  → marker present, buffer at 330/800
  after 889 requests  → marker GONE, buffer at 800/800
                        top of buffer = the log viewer's own polls
```

**Fix.** `services/nova/diagnostics.ts` — an aggregating store alongside (not replacing) the ring
buffer. One row per *distinct* problem keyed by `category|method|normalisedRoute|gameVersion`, with an
occurrence counter, first/last seen, a bounded distinct-user count, and a documented severity score.
Repeats increment; they do not evict. Bounded at 400 distinct problems, evicting lowest-score first
so a noisy low-severity entry can never displace a serious one.

**Response shapes are unchanged.** The not-found handler still returns `200 {}` / `204`. The change
makes the silence *countable*, not audible.

**Verified — the same flood, both surfaces, one run:**

```
fired 1 rare MISSING call, then 900 routed requests
  GET /nova/api/logs        → rare endpoint: 0 occurrences   (evicted, as before)
  GET /nova/api/diagnostics → rare endpoint: still present,
                              route normalised to /fortnite/api/game/v2/…/{accountId}
```

**Regression tests.** `diagnostics.test.ts`: aggregation of 706 repeats into one row; a 5,000-event
flood failing to evict a single rare `AUTH_FAILURE`; per-version separation; distinct-user counting
without retaining account ids; `recordDiagnostic` never throwing on malformed input.

**A test caught a real design error during development.** The first severity thresholds
(40/20/8/3) made almost anything in matchmaking or auth read `CRITICAL` on its second occurrence,
which would have made the ranking worthless. Recalibrated against five worked scenarios documented in
the source, and both directions are now asserted: a rare matchmaking outage outranks 1,000 telemetry
misses, *and* those 1,000 telemetry misses do not reach `CRITICAL`.

---

## NOVA-AUDIT-003 — reading the log polluted the log

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P3 · **Subsystem** backend / launcher |
| **Grade** | CONFIRMED |

**Symptom.** With the launcher's Logs tab open, the buffer filled with the log viewer's own requests.

**Root cause.** `Logs.tsx:46` polls `GET /nova/api/logs` every 2,500 ms, and the request logger
logged that request — so observing the system perturbed it, and accelerated NOVA-AUDIT-002.

**Fix.** The request logger skips `/nova/api/logs`, `/nova/api/components` and
`/nova/api/diagnostics`. **Verified:** 0 self-referential entries after repeated polling, with a
control confirming ordinary requests are still logged.

---

## NOVA-AUDIT-004 — deliberate errors were never classified

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P2 (diagnosability) · **Subsystem** backend |
| **Grade** | CONFIRMED — found by a failing end-to-end probe, not by reading code |

**Symptom.** After wiring diagnostics into Fastify's `setErrorHandler`, an invalid bearer token
produced **no** `AUTH_FAILURE` event.

**Root cause.** `utils/error-handler.ts`'s `sendEpicError` calls `reply.status().send()` directly
rather than throwing, so Fastify's error handler never runs. Every deliberate 401/404/400 in the
codebase — the most diagnostically valuable class of failure — bypassed the instrumentation.

**Fix.** Record the diagnostic inside `sendEpicError` itself, the single funnel all of them pass
through, reading the request off `reply.request`. Wrapped in `try/catch` so a diagnostics failure can
never stop an error response being sent.

**Verified, with a control in the same run:**

```
2 invalid-token requests (2 different accounts) + 1 unrouted control
→ byCategory {"AUTH_FAILURE":2,"MISSING":1}
  MEDIUM x2 AUTH_FAILURE cloudstorage GET /fortnite/api/cloudstorage/user/{accountId} -> 401
  LOW    x1 MISSING      other        GET /control/unrouted/path -> 200
  detail: "errors.com.epicgames.common.oauth.invalid_token: The token is invalid or has expired."
```

Note the two different account ids aggregated into one row with `count=2` — the behaviour
NOVA-AUDIT-002 depends on.

**Regression test.** Covered indirectly by the classification tests; the direct end-to-end probe is
recorded above. **Gap:** there is no automated HTTP-level integration test. Recorded as the next test
to write.

---

## NOVA-AUDIT-005 — fabricated matchmaking demand is now attributable

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P3 (diagnosability) · **Subsystem** matchmaking / xmpp |
| **Grade** | CONFIRMED behaviour; the *fix* is instrumentation, not a behaviour change |

**Symptom.** A gameserver can spin up with nobody waiting to play.

**Mechanism.** `handleMatchmaker` calls `matchmakingStarted()` the instant a socket opens, and in
P2P mode a waiter *is* demand. Any WS upgrade routed there therefore fabricates a match.

**Why this is instrumentation and not a fix.** The obvious change — route only sockets carrying the
`xmpp` subprotocol away, or reject unknown paths — cannot be made safely, because a **real** Play
press is indistinguishable from an accident: it connects to `Config.MMS_URL`, which is the **root**
path, and arrives with no usable subprotocol. Inverting the default would break matchmaking to fix a
guess, and the existing code already carries a comment warning against exactly that.

The one separable case is a **non-root** path: nothing legitimate matchmakes against a sub-path, and
EOS sockets are already returned earlier. That case now records an `UNEXPECTED_STATE` diagnostic
naming the path and subprotocol, rather than silently counting as a player.

**Verified live, with both controls in the same run:**

| socket | expected | result |
|---|---|---|
| `/` (what a real Play press looks like) | not flagged | not flagged |
| `/lobby/abc` (EOS, excluded upstream) | not flagged | not flagged |
| `/stray/socket/path` | **flagged** | `UNEXPECTED_STATE` recorded with path and subprotocol |

**Gap:** covered by a live probe, not an automated test. An HTTP/WS integration test is blocked on
`index.ts` running `main()` at import time — it binds ports and starts XMPP on :80, so it cannot be
imported into a test process. Making it importable is worth doing, but it is the live service's
entrypoint and deserves its own change rather than being restructured in passing.

---

## NOVA-AUDIT-006 — the 38 latent client endpoints are routed

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P3 · **Subsystem** compat |
| **Grade** | endpoint list CONFIRMED (from the client binary); most response shapes UNKNOWN and treated as such |

**What changed.** Every endpoint the 7.40 binary can call now has a route
(`services/compat/latent.routes.ts`, 49 declarations covering the 38 previously-unrouted fragments).
Full reasoning in [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §2c.

**The rule applied.** A wrong shape is worse than no route. 14 declarations return a documented or
reference-backed shape; the other 35 return **exactly** what the catch-all returned, verified
byte-identical, and record an `UNKNOWN` diagnostic so a real call becomes visible. `MISSING` is
reserved for genuinely unrecognised paths so the new module cannot swallow that signal.

**Two real defects found while building it:**

1. **A duplicate route that broke startup.** `/fortnite/api/stats/accountId/:accountId/bulk/window/:windowId`
   was added here while `compat.routes.ts:21` already declared the same shape with a differently
   *named* parameter (`:window`). Fastify treats those as one route and throws
   `FST_ERR_DUPLICATED_ROUTE` — the backend fails to bind at all, not just that endpoint. The
   fragment `api/stats/%s` had read as unrouted because the real path has a literal `accountId`
   segment before the parameter. compat.routes.ts also implements it *better* than the reference
   does — it seeds and returns real player stats where LawinServerV3 returns `{}` — so the duplicate
   was simply dropped.

2. **An integer that serialised larger than Int64.MAX.** `totalStorage` is `9223372036854775807` in
   Epic's documented example, which is not representable as a JavaScript double; `JSON.stringify`
   emits `9223372036854776000`. A client parsing that into an int64 overflows — on a value we
   invented by rounding. The body is now serialised by hand so the exact documented integer reaches
   the wire.

**Regression tests** (`latent.routes.test.ts`, 4 tests): no route shape declared both here and
elsewhere; no duplicate shape within the file; the stats route specifically stays out; and every
parametric-service-prefix route pins at least two literal segments so none can broaden into a
catch-all. **The collision test was verified to fail** by re-injecting the exact duplicate — it
reported both the shape clash and the specific stats guard, and passed again once reverted.

**Verified live:** all 49 routes registered without conflict and probed (0 unexpected statuses); the
endpoints 7.40 actually uses re-checked unchanged in the same run; a still-unrouted control returning
`200 {}` and recording `MISSING`.

---

## NOVA-AUDIT-007 — friend and blocklist writes had no owner

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P1 (unauthorised write to another player's account) |
| **Subsystem** | social · eos |
| **Grade** | CONFIRMED — reproduced against a scratch database, persisting across a process restart |

**Symptom.** None. Every handler did exactly what it said; the route simply never asked who was
calling.

**Root cause.** `accountId` came straight off the URL path with no auth check on any of the friend or
blocklist writers, in **two** families that reach the same tables:
`/friends/api/v1/:accountId/...` and `/epic/friends/v1/:deploymentId/users/:userId/...`. The EOS side
is trivially targetable because `productUserMap.get(x) || x` lets an unmapped value fall through as a
raw account id.

**Evidence** — no `Authorization` header, scratch database, control in the same run:

```
POST   /friends/api/v1/<victim>/friends/<attacker>   -> 204, victim now has an outgoing request
POST   /friends/api/v1/<victim>/blocklist/<anyone>   -> 204, victim's blocklist modified
DELETE /friends/api/v1/<victim>/friends/<real friend>-> 204, an existing mutual friendship removed
POST   /epic/friends/v1/<dep>/users/<victim>/blocked/<x> -> 204, visible via the FRIENDS api
control: POST /bogus/api/v1/x/friends/y             -> 204   (so 204 alone proves nothing;
                                                              the persistence check is the signal)
```

All of it survived killing and restarting the process — these are committed rows, not cache.

**A second, functional defect found in the same place.** Only the **GET** forms of the legacy
`/friends/api/public/...` API were routed. The **POST/DELETE** forms — the ones 7.40 actually uses —
had no route and fell to the catch-all, which answers a POST with `204`. **Adding a friend in game
returned success and did nothing, silently.** The binary settles which API this build uses: it
contains `friends/api/v1` zero times, and the only friends-related literals anywhere in it are
`api/public/friends/` and `api/public/blocklist/`.

**Fix.** One set of handlers behind an ownership guard, registered on both path families. The guard
checks that the caller's token belongs to *the account named in the path* — not merely that a token
exists. EOS reuses that file's own `resolveAccountId`, which accepts a real EOS v2 token but not the
anonymous ids the token endpoint hands to unidentified callers.

**Why requiring auth here is the safe direction** — the argument that matters, since adding auth
usually is not: the `public` forms did nothing at all before, and the `v1` forms are not on 7.40's
path. A caller that needs one and has no token now fails *visibly* as an `AUTH_FAILURE` diagnostic
instead of silently succeeding while doing nothing.

**Verified, with both controls:** unauthenticated → `401` and no state change; valid token on
**another** account → `401`; valid token on **your own** account → `204` **and the write lands** —
including through the legacy path that previously no-opped.

**Regression tests.** `friends-auth.test.ts`, 17 tests, HTTP-level via `app.inject()` — no port
bound, no network, `index.ts` never imported. Covers all 11 refusal routes, both wrong-account cases,
and the positive path in both families.

---

## NOVA-AUDIT-008 — module-level timers stopped any process from exiting

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P3 · **Subsystem** eos · matchmaking · validation |
| **Grade** | CONFIRMED — the hang was observed, then fixed, then the same suite exited cleanly |

**Symptom.** The first run of `friends-auth.test.ts` executed its assertions and then **never
returned** — it had to be killed after two minutes.

**Root cause.** Four `setInterval` calls at module top level, armed by the mere act of *importing*
the file, with no `.unref()`. Node keeps the event loop alive for a referenced timer, so any process
that loads these modules — a test runner, a script, a one-off tool — hangs on exit forever.
`reapStaleWaiters` in `matchmaking.routes.ts` already called `.unref?.()`; three others and the EOS
session reaper had simply missed it.

**Fix.** `.unref?.()` on all four. The timers still fire for as long as the server runs; they just no
longer hold a process open on their own.

**Beyond tests:** this is also why nothing that imports these modules can shut down cleanly.

---

## An error I made, recorded because the trap is the point

While writing `friends-auth.test.ts` I set `process.env.NOVA_DB_PATH` at the top of the file and
imported the database module normally. **`import` declarations are hoisted** — they run before any
top-level statement — so `config.ts` resolved `Config.DB_PATH` *before* the assignment executed, and
the suite ran against `Main backend/data/nova.db`. It created a `tester` account and a blocklist row
in the real database.

Removed afterwards: a backup was taken first (`data/nova.db.bak-before-cleanup-*`), 4 rows deleted
across `accounts`, `tokens`, `currency` and `friends`, and the result verified — 114 accounts remain,
the friends table is empty, and the real user account is intact.

`config.ts` warns about exactly this: without `NOVA_DB_PATH`, "did my change work" and "did I just
edit live player accounts" become the same question. The fix is structural, not a note to be careful:
the database modules are now loaded **dynamically inside `before()`**, and `assertScratchDatabase`
refuses to run the suite unless the resolved path is a temp file. Three tests exercise that guard
directly — pointing it at real data to prove it by experiment is the one thing it exists to prevent.

---

## NOVA-AUDIT-009 — read-modify-write silently lost stats across processes

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P2 (silent data loss) · **Subsystem** database |
| **Grade** | CONFIRMED — measured with two real processes, then re-measured after the fix |

**Symptom.** Kills and matches quietly not counting. No error, no corruption, nothing in a log.

**Root cause.** `incrementPlayerStat` read the current value and wrote `current + delta` back through
`setPlayerStat`'s absolute `INSERT OR REPLACE` — two statements with nothing holding the row between
them. Inside one process that is safe *by accident*: better-sqlite3 is synchronous and Node is
single-threaded, so nothing can interleave. It stops being safe as soon as a second process opens the
same file, which `backend-eaddrinuse-zombie` makes reachable — that zombie keeps the database open.

**Evidence.** Two processes, 400 increments each, one file:

```
before:  407 of 800 landed — 393 lost.  integrity_check ok, 0 SQLITE_BUSY, 0 errors
after :  800 of 800 landed —   0 lost
```

**Fix.** One atomic UPSERT that adds inside SQL
(`ON CONFLICT … DO UPDATE SET stat_value = stat_value + excluded.stat_value`). SQLite holds the row
lock for the statement's duration, so no interleaving can lose an increment. Single-process behaviour
is unchanged, including creating the row when absent.

**Also fixed, same class:** `ensureAccount` and `getCurrency` both SELECT, find nothing, then plain
`INSERT`. Two processes can pass that check together and the loser throws
`SQLITE_CONSTRAINT_PRIMARYKEY` on a race whose correct outcome is "the row exists now, which is what
you wanted". Both now use `INSERT OR IGNORE`, matching the sibling currency insert that already did.

**Also hardened:** the `exec()` shim reset raw mode *after* `.all()` rather than in a `finally`.
Verified that better-sqlite3's raw mode survives a throw — after `stmt.raw().all()` throws, a plain
`stmt.all()` returns arrays instead of objects. No current path depends on it, because every reader
goes through `exec()` and `exec()` always re-applies `.raw()`. Pinned down anyway: the invariant the
comment claimed was one line from not holding, and the failure would be a silent shape change.

**Regression tests.** `database.test.ts`. **The first version of the concurrency test was worthless
and I caught it by trying to break it** — reverting the fix left it passing, because two synchronous
calls in one process run strictly one after the other and never interleave. It was replaced with a
structural assertion that the increment is a single UPSERT with no `SELECT`, which *does* fail
against the old code. The cross-process measurement lives here rather than in the suite, because it
cannot be reproduced inside one test process.

---

## NOVA-AUDIT-010 — the tokens table was never cleaned

| | |
|---|---|
| **Date** | 2026-08-31 · **Severity** P3 · **Subsystem** database |
| **Grade** | CONFIRMED — counted on the real database |

**Evidence.** `Main backend/data/nova.db`: **201 token rows, all 201 expired**, oldest dated
2026-05-02. Not one live token. It grows with logins × players and nothing ever removed a row.

**Fix.** `storeToken` deletes expired rows as it writes. Safe by construction — `validateToken`
already rejects anything past `expires_at`, so removing those rows cannot log anyone out. Done inline
rather than on a timer because it is self-limiting: purging on each new token keeps the table at
roughly the number of *live* tokens. A timer would also have needed `.unref()` (NOVA-AUDIT-008).

**A bug in my own fix, caught by its test.** The first version compared
`expires_at < datetime('now')`. This table stores **two different timestamp formats** — `expires_at`
is ISO-8601 from JavaScript (`2026-05-02T12:43:34.000Z`), `created_at` uses SQLite's
`datetime('now')` default (`2026-05-02 08:43:34`). They differ at character 10, `T` versus a space,
and `T` sorts *above* a space. So the comparison is wrong whenever both fall on the same date: a
token that expired an hour ago reads as still live. Against the real table it looked perfect, because
every row there was months old and the dates diverged before reaching that character. A test using a
token that expired 60 seconds ago exposed it. Now compares against a JS ISO string.

**That format split is a live trap for any future date comparison in SQL** and is recorded in
[ARCHITECTURE.md](ARCHITECTURE.md) §4.

---

## NOVA-AUDIT-011 — anti-cheat flagged the honest host for every player after the first

| | |
|---|---|
| **Date** | 2026-09-05 · **Severity** P2 (wrongful autoban) · **Subsystem** backend / anticheat |
| **Grade** | CONFIRMED — reproduced by test before the fix |

**Symptom.** Match results silently discarded for most players in a match, and the player who
*hosted* accumulating anti-cheat risk for doing so.

**Root cause.** `analyzeReportAuthority` was passed `match_participants` as the answer to "was this
subject in the match". `match_participants` is the **results** table — it lists players whose results
have already been stored — so it answers a completely different question. In any match with more than
one player that inverted: the host reported player one (accepted, stored), and every player after
that was judged against a list containing only player one. Each got `report.subject_not_in_match` at
severity 8, charged to the **reporter**, and had their results thrown away. A four-player match cost
an honest host 24 risk; with `NOVA_AC_AUTOBAN_AT` anywhere near the value in `config.ts`'s own
example, hosting a few matches was enough to be banned for hosting.

**Fix.** The parameter is renamed `roster` and documented as "the expected roster, empty means
unknown". Nothing in this backend records a roster — `match_history` stores only the host — so the
call site passes `[]` and the membership check is skipped. `alreadyReported` still uses
`match_participants`, which is the question that table genuinely answers.

Kept as a parameter rather than deleted, so the check is ready the moment a real roster exists; the
obvious source is the set of players routed to a match at matchmaking time.

**A process note, which is the more useful half.** The service-side fix and its tests were already
written and sitting uncommitted in the working tree — but the **call site was never updated**. The
tree did not typecheck and three tests failed. A half-applied rename is indistinguishable from a
finished one in a diff of the file you were editing; only `npm run typecheck` and `npm test` see it.

**Regression test.** `anticheat.test.ts` — three players reported into one match must all be
accepted with zero reporter flags; a repeat of the same player must still be rejected; and a non-host
reporting someone else's match must flag the reporter, never the subject.

---

## NOVA-AUDIT-012 — the ingest path served live tokens; only the smaller half had been fixed

| | |
|---|---|
| **Date** | 2026-09-05 · **Severity** P1 (credential disclosure) · **Subsystem** backend / nova logs |
| **Grade** | CONFIRMED — canary through the real ingest path, with a control |

**Symptom.** None, again.

**Root cause.** NOVA-AUDIT-001 redacted the `[HTTP]` line **this process writes about its own
requests**. That was real, and it was the smaller half. The line that actually carries the tokens
comes from another process: Cobalt runs inside the game, logs `URL: <full url>` for every request it
redirects, and POSTs those lines to `/nova/api/logs/ingest`. 7.40 ends every session with
`DELETE /account/api/oauth/sessions/kill/eg1~<jwt>`, so a live bearer token is in the URL **path** of
a line `ingestLogs` receives. It stored `msg` verbatim, and `GET /nova/api/logs` requires no
`Authorization` header.

`KNOWN_ISSUES.md` filed the remainder as `cobalt-logs-bearer-tokens` — "the Cobalt half is still
open" — i.e. as something only a new DLL could fix. That framing was wrong, and it is the reason this
sat open: whatever a component chooses to *send*, this process decides what it *stores* and *serves*.

**Fix.** `redactSecrets()` applied in `ingestLogs`, to both `msg` and the component `status.text`
(served by the same route). One import; `diagnostics.ts` has no imports of its own, so there is no
cycle. Fixes it for every launcher already installed, which a Cobalt release cannot.

**Regression test.** `logstore-redaction.test.ts` — four tests; three fail against the pre-fix code
and the fourth (ordinary lines pass through byte-identical) passes both before and after, as the
control.

---

## NOVA-AUDIT-013 — the installer shipped a month-old backend, including three P1s recorded as fixed

| | |
|---|---|
| **Date** | 2026-09-05 · **Severity** P2 · **Subsystem** release process |
| **Grade** | CONFIRMED — compared file by file against the source tree |

**Symptom.** None observable. Fixes were verified in source, verified on the coordinator, and
recorded as FIXED — and were not present on any player's machine.

**Root cause.** The installer bundles a **compiled** backend at
`Launcher/src-tauri/resources/Backend-Coordinator/dist`, and `start_backend` in `main.rs` prefers
`dist/` over sources, so that copy is what an installed launcher runs as its host agent. Staging it
was a manual copy step in RELEASING.md §2. Nobody performed it between 2026-08-01 and 2026-09-05, so
releases 1.5.1–1.5.9 all shipped a 1 August backend.

**Evidence.** Bundle `index.js` dated 2026-08-01; source 35 days newer. Absent from the bundle:

| missing | recorded as |
|---|---|
| `services/nova/diagnostics.js` | the entire 2026-08-31 diagnostics subsystem |
| `services/compat/latent.routes.js` | NOVA-AUDIT-006, the 38 latent client routes |
| friends ownership guard | NOVA-AUDIT-007 — **P1** |
| MCP `readOnly` guard | `mcp-unauth-mutation` — **P1** |
| `redactSecrets` in the request logger | NOVA-AUDIT-001 — **P1** |

**Bounded, and worth stating plainly.** `Config.HOST` is hard-coded to `127.0.0.1`, so the host agent
is not reachable off the machine; exploiting any of the three needed code already running on the
player's own PC. The coordinator was never affected — it runs `tsx src/`. What was untrue was the
word "fixed".

**Fix.** `tools/stage-backend.mjs`. Compiles, replaces the bundle wholesale (a merge would leave
orphans of deleted modules), asserts the two modules that went missing are present, and refuses to
ship a database, log, `.env` or private key. `--check` makes staleness a loud non-zero exit fit for a
release script. RELEASING.md §2 now points at it and records why it exists.

**A bug in my own guard, caught on its first run.** It blocked any `data/` directory, following
RELEASING.md's wording — and flagged `Backend-Coordinator/data/cloudstorage/*.ini`, which is
*intended* payload that standalone mode serves. It now matches files that matter (`*.db`, `*.log`,
`.env`, `*.key`/`*.pem`) rather than directory names.

**Regression test.** `node tools/stage-backend.mjs --check`, which exits 1 against the stale bundle
and 0 after staging. Not part of `npm test` because it is a repository-state check, not a unit test.

---

## NOVA-AUDIT-014 — four self-check codes could not fire on any machine

| | |
|---|---|
| **Date** | 2026-09-05 · **Severity** P2 (diagnostics) · **Subsystem** launcher / diagnostics.rs |
| **Grade** | CONFIRMED — the real log was found, read, and produced findings immediately |

**Symptom.** The self-check reported "No record of a previous game launch" on a machine that had run
the game many times.

**Root cause.** `check_last_run` read
`<build>\FortniteGame\Saved\Logs\FortniteGame.log`. UE4 writes a **packaged** client's log to
`%LOCALAPPDATA%\FortniteGame\Saved\Logs\`. `tail()` returned `None` every time and the function
short-circuited, so NOVA-300/301/303/305 — three of them the codes the module header says cost two
sessions each to identify — had never evaluated against data.

NOVA-307 was separately dead: it grepped `cobalt.log` for `Gameserver exited (code=…)`, which
`hostRunner.ts` prints to the **backend's** stdout, which `main.rs` redirects to `nova-agent.log`.

**Evidence.** The real `FortniteGame.log` was 580 904 bytes and a month old while the check reported
no log. Reading it produced NOVA-301 (Warn — UAC ran, did not kick) and NOVA-303 (Error) on the first
attempt.

**Fix.** `game_log_candidates()` searches `%LOCALAPPDATA%` first and the build folder as a fallback,
and returns the **two** newest `FortniteGame*.log` files — when a PC hosts there are two Fortnite
processes and UE4 names the second `FortniteGame_2.log`, so reading one file drops half the evidence
on exactly the machines with the most interesting problems. NOVA-307 reads `nova-agent.log`, reports
any non-zero exit rather than only `0xC0000005`, and is called from `run_diagnostics` rather than
from the end of `check_server_run`, where a missing `cobalt.log` would have skipped it — the same
shape of mistake as the bug being fixed.

**NOVA-303's rule was also wrong, which mattered more once it could run.** It keyed on `CorrId=FN-`,
reasoning "Epic answers with a correlation id; Nova never does". The 7.40 binary carries
`X-Epic-Correlation-ID` itself, so the id may be one the client generated; and with exactly one HTTP
error in every log on the reference machine there is no negative control to test the rule against. It
now keys on the response **body**: Nova stamps `originatingService` as `nova-backend` or
`com.epicgames.account.public`, so any other value came from a server that is not Nova.

**What that found.** The 2026-08-15 escape is real and now has a name:

```
HttpResult: 401 … "originatingService":"friends" … "Token is missing key ID value"
QueryFriendSettings request failed
```

Epic's live friends service rejecting a Nova-issued JWT for having no `kid` header, from
`QueryFriendSettings` at XMPP-login time. Proven from the body alone — Nova writes neither that
message nor that service name. See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) `nova-303-request-escape`.

**Regression test.** The launcher's **first tests** — it had none. Eight covering both rules,
including the verbatim 2026-08-15 log line and a negative control for each.

---

## NOVA-AUDIT-015 — the port checks passed on anything that accepted a connection

| | |
|---|---|
| **Date** | 2026-09-05 · **Severity** P2 (diagnostics) · **Subsystem** launcher / diagnostics.rs |
| **Grade** | CONFIRMED — read directly, and reproduced against a hung socket in test |

**Symptom.** NOVA-201/202 reporting green while the game could not reach Nova.

**Root cause.** Both used `port_open()`, a bare `TcpStream::connect_timeout`. A stale backend left
over from an earlier launch, or any unrelated program holding 3551, satisfies that — and reads as
healthy. Worse than no check: a green tick sends the search somewhere else, and "another program may
be using port 3551" is what NOVA-201's own advice text tells the player to go and look for.

**Fix.** `probe_nova()` sends `GET /nova/api/components` and requires **both** a 200 and a
`{"components": …}` body. That endpoint is the right question: nova-proxy keeps it local
(`LOCAL_PREFIXES`), so a good answer on 3551 proves the proxy is up *and* routing to the host agent,
without depending on the coordinator being reachable — a separate question with its own codes
(NOVA-203/204) that must not be folded into this one. Raw socket rather than `reqwest`, because
`run_diagnostics` is synchronous and this has to stay under a second.

Three outcomes replace two: "something else is using this port" is now its own finding, because the
fix for it (find the leftover `node.exe`) is nothing like the fix for a port with nothing on it. On
3552 that case also means the stale process is still holding the database open — the condition
measured in NOVA-AUDIT-009.

`port_open()` is now unused and removed.

**Regression test.** Six, against real localhost sockets: a genuine Nova answer, a closed port,
another program's HTML, a catch-all that 200s on everything, a 503 whose body happens to contain the
right word, and a server that accepts and never replies. The last also asserts the probe returns in
under three seconds.

---

## Test suite

Added 2026-08-31 — there were **no tests in this repository before this date.** The launcher had
none until 2026-09-05.

```bash
cd "Main backend"        && npm test        # 74 tests · node:test via tsx
cd "Main backend"        && npm run typecheck
cd Launcher/src-tauri    && cargo test --bin sololauncher   # 14 tests
node tools/stage-backend.mjs --check                        # installer payload is current
```

Note the Rust target: `diagnostics` is a module of `main.rs`, not the `solo` lib, so `cargo test`
without `--bin sololauncher` runs **zero** tests and reports success.

**Coverage, stated honestly.**

| area | covered |
|---|---|
| nova diagnostics store, redaction, severity | yes |
| log ingest redaction (NOVA-AUDIT-012) | yes |
| friends/blocklist ownership (NOVA-AUDIT-007) | yes |
| anti-cheat authority, plausibility, admin gating | yes |
| database concurrency, stat increments, token purge | yes |
| latent route registration and narrowness | yes |
| process startup / port contention (NOVA-AUDIT-011) | yes |
| launcher: NOVA-303 escape rule, game-log discovery, port identity | yes |
| **matchmaking, MCP, auth, XMPP, cloudstorage** | **no** |

The highest-value next additions, in order: contract tests asserting the response shape of each of
the 34 endpoints 7.40 actually calls (see [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §2);
an HTTP-level integration test for the auth failure path; and a regression test for
`mcp-unauth-mutation`, which is still protected only by a manual probe.

**Two traps this suite has already paid for.** A regression test that has never been run against the
unfixed code is a hypothesis, not a test — both NOVA-AUDIT-011 and -012 were confirmed by reverting
the fix and watching them fail. And a suite that passes while `tsc --noEmit` fails is not green:
NOVA-AUDIT-011 reached the working tree as a rename that compiled in the file being edited and
nowhere else.
