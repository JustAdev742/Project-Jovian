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

## Test suite

Added 2026-08-31 — there were **no tests in this repository before this date.**

```bash
cd "Main backend" && npm test
```

19 tests, `node:test` via `tsx`, no new dependency. `npm run typecheck` runs `tsc --noEmit`.

**Coverage is narrow and should be stated as such:** it covers the diagnostics module only. The
matchmaking, MCP, auth and XMPP subsystems have no tests. The highest-value next additions, in order:
contract tests asserting the response shape of each of the 34 endpoints 7.40 actually calls
(see [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md) §2); an HTTP-level integration test for the
auth failure path; and a regression test for `mcp-unauth-mutation`, which is currently protected only
by a manual probe.
