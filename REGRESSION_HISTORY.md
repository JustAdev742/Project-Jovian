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

## Test suite

Added 2026-08-31 — there were **no tests in this repository before this date.**

```bash
cd "Main backend" && npm test
```

56 tests, `node:test` via `tsx`, no new dependency. `npm run typecheck` runs `tsc --noEmit`.

**Coverage is narrow and should be stated as such:** it covers the diagnostics module only. The
matchmaking, MCP, auth and XMPP subsystems have no tests. The highest-value next additions, in order:
contract tests asserting the response shape of each of the 34 endpoints 7.40 actually calls
(see [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §2); an HTTP-level integration test for the
auth failure path; and a regression test for `mcp-unauth-mutation`, which is currently protected only
by a manual probe.
