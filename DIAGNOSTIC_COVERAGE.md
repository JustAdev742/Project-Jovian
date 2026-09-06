# DIAGNOSTIC_COVERAGE

**What the diagnostic pipeline actually captures, measured 2026-09-06.**

This document exists because "we capture everything" is a claim, and the brief that commissioned this
work was explicit that an accurate partial number beats an impressive total. Every ✅ below has a
verified path from the failure happening to the dashboard showing it. Every ⚠️ and ❌ says why not.

**Nothing here is aspirational.** A row is not marked captured because code exists that could capture
it — it is marked captured because the path was driven and observed.

---

## The pipeline as built

```
FORTNITE CLIENT ──┐
                  │  Cobalt (in-process, curl hook)
                  ↓
              cobalt.log ──► POST /nova/api/diagnostics/local   (local agent, unauthenticated,
                  │                                              localhost-only)
REBOOT / HOST ────┘
                  ↓
            forward queue (bounded 500, oldest dropped, drop count forwarded)
                  ↓
            LAUNCHER drains it, POSTs under the player's own token
                  ↓
        POST /nova/api/diagnostics/ingest   (rate-limited 120 burst / 2 per sec per account)
                  ↓
BACKEND ────► recordDiagnostic() ──► aggregate by (source|category|method|route|version)
                  │                        │
                  │                        ├─► replay ring (200) ──► GET /diagnostics/since
                  │                        └─► live subscribers   ──► GET /diagnostics/stream (SSE)
                  ↓
            GET /nova/api/dashboard  (admin-gated, fails closed)
```

Call sites feeding it, counted rather than estimated: **9 backend**, **6 Cobalt**, **1 Reboot**,
**14 launcher**.

---

## Coverage table

Legend: ✅ verified end to end · ⚠️ captured but with a stated limit · ❌ not captured · **T** tested

### HTTP / API surface — the backend sees every request, so this is the strongest area

| Failure surface | Captured | Source | Transport | Dashboard | Tested |
|---|---|---|---|---|---|
| Unrouted path | ✅ | backend `setNotFoundHandler` | in-process | ✅ | **T** |
| Thrown exception in a handler | ✅ | backend `setErrorHandler` | in-process | ✅ | **T** |
| **Sent** 4xx/5xx (not thrown) | ✅ | `sendEpicError` + `onResponse` hook | in-process | ✅ | **T** |
| Auth failure (401/403) | ✅ | classified from status | in-process | ✅ | **T** |
| Method mismatch | ⚠️ | surfaces as unrouted, not as its own class | in-process | ✅ | **T** |
| Malformed / invalid JSON body | ⚠️ | Fastify rejects it → 400 → captured as `FAILED`, but not distinguished from other 400s | in-process | ✅ | — |
| Latent (unimplemented) route hit | ✅ | `latent.routes.ts` | in-process | ✅ | — |

**Method mismatch is the honest ⚠️.** Fastify answers an unknown method on a known path via the
not-found handler, so it is recorded — as `MISSING`, indistinguishable from a genuinely absent path.
`tools/method-audit.mjs` catches this class statically instead (currently 33/33 clean). Splitting it
at runtime needs a route-table lookup on the miss path, which is not built.

### Process and runtime

| Failure surface | Captured | Source | Transport | Dashboard | Tested |
|---|---|---|---|---|---|
| Uncaught exception | ✅ | `process.on('uncaughtException')` | in-process | ⚠️ see note | **T** |
| Unhandled promise rejection | ✅ | `process.on('unhandledRejection')` | in-process | ⚠️ see note | **T** |
| Startup failure | ✅ | `main().catch` | in-process | ⚠️ see note | **T** |
| Non-zero process exit | ✅ | `process.on('exit')` | console only | ❌ | **T** |
| Clean shutdown (must NOT alarm) | ✅ | SIGTERM/SIGINT handled separately | — | — | **T** |

**The ⚠️ that matters most in this table.** The diagnostic store is **in-memory**. A crash records
the event and then dies with it — the dashboard never sees the last thing that happened before a
crash, which is the single most valuable record there is. The console line survives in the agent log
(which now appends rather than truncating), so the evidence exists; it just does not reach the
aggregate. **This is the largest known gap in the system.** Closing it needs a durable store, which
is Phase 9 and is not built.

### Native components

| Failure surface | Captured | Source | Transport | Dashboard | Tested |
|---|---|---|---|---|---|
| Cobalt hook install failure | ✅ | `dllmain.cpp` | local → launcher → ingest | ✅ | — |
| Cobalt signature/version mismatch | ✅ | `signatures.h`, `dllmain.cpp` | same | ✅ | — |
| Request escaping to Epic (unmatched host) | ✅ | `curlhook.h` | same | ✅ | — |
| Request escaping via the VEH re-arm window | ❌ | **unobservable by construction** | — | — | — |
| Cobalt: HTTP status / latency per request | ❌ | see note | — | — | — |
| Reboot offset-lookup failures | ⚠️ | `Offsets::Report()` — console only, not a diagnostic | — | ❌ | — |
| Reboot host/session failures | ❌ | 1 report site total | — | — | — |
| Native crash (either DLL) | ⚠️ | Reboot writes `crash.log`/`crash.dmp`; not ingested | — | ❌ | — |

**Two blind spots stated precisely, because they are structural rather than unfinished:**

> **The VEH re-arm window is unobservable from inside the process.** A request that escapes because
> the hook was momentarily unarmed *never reaches the detour*, so the component that would report it
> is by definition not running at that moment. `curlhook.h` says so at the call site. The only
> evidence is indirect — Epic's own `FN-` correlation ids appearing in `FortniteGame.log`. See
> `nova-303-request-escape`.

> **Cobalt cannot see response status or latency.** It hooks `curl_easy_setopt`, which runs *before*
> the request and only sets options. Status and timing would require hooking `curl_easy_perform` or
> `curl_easy_getinfo`, for which no signature exists — and signatures cannot be derived offline
> because the client's `.text` section is encrypted on disk (entropy 8.00; see `tools/README.md`).
> **This is not a real loss:** Cobalt redirects everything to the backend, and the backend already
> records status, route, version and outcome for every request. Cobalt's unique value is the traffic
> the backend *never sees* — which is exactly what it reports.

### UE4 / Unreal

| Failure surface | Captured | Source | Transport | Dashboard | Tested |
|---|---|---|---|---|---|
| UE4 `Error:` / `Warning:` / `Fatal` lines | ❌ | `FortniteGame.log` is read by the launcher for self-checks but **not turned into diagnostics** | — | — | — |
| Engine init / module load failure | ❌ | same log, same gap | — | — | — |
| Assertions, ensures | ❌ | same | — | — | — |
| Crash dumps (`UE4CC-*`) | ❌ | directories exist on disk; not read | — | — | — |

**This is the largest unbuilt area, and it is genuinely observable.** `FortniteGame.log` is a real
UE4 error surface sitting on disk that the launcher already opens for other reasons — 36 `Error:` and
411 `Warning:` lines in the session inspected on 2026-09-06. Turning those into diagnostics is
tractable work that has not been done. It is listed here as ❌ rather than described as partial,
because nothing currently ingests it.

### Transport / network

| Failure surface | Captured | Source | Transport | Dashboard | Tested |
|---|---|---|---|---|---|
| WebSocket upgrade on an unexpected path | ✅ | `xmpp.server.ts` → `UNEXPECTED_STATE` | in-process | ✅ | — |
| Backend unreachable from the launcher | ⚠️ | launcher self-check reports it locally | not forwarded | ❌ | — |
| DNS / TLS failure | ❌ | no instrumentation | — | — | — |
| Timeout | ⚠️ | category exists in the schema; nothing currently emits it | — | — | — |

**`TIMEOUT` is in the schema and unused.** Stating that plainly matters more than leaving the row
implying coverage: a category existing is not the same as something reporting it.

---

## Honest coverage summary

Expressed the way the brief asked for, as observed paths rather than as a headline:

```
Backend HTTP failures ................ 100% of responses (every 4xx/5xx and every unrouted path)
Backend exceptions ................... 100% recorded, but LOST ON CRASH (in-memory store)
Backend process events ............... 100% of the four handled signals
Cobalt hook/version failures ......... 100% of observable ones (6 report sites)
Cobalt per-request status/latency .... 0% — architecturally unavailable, and duplicated by the backend
Cobalt VEH-window escapes ............ 0% — unobservable by construction
Reboot host/session failures ......... ~minimal: 1 report site
Reboot offset failures ............... console only, not ingested
UE4 log errors ....................... 0% — observable, not yet built
Native crash dumps ................... 0% — files exist, not read
WebSocket anomalies .................. partial (one class)
DNS / TLS / timeout .................. 0%
```

---

## What was verified, and how

Not claimed — driven and observed:

| Path | Evidence |
|---|---|
| Sent 4xx/5xx reaches the store | 8 tests in `error-capture.test.ts`, incl. that a 2xx records nothing |
| No double counting | Measured before/after: one `Errors.*` rejection gave **2** diagnostics, now gives **1** |
| Uncaught exception exits non-zero | 5 spawned-process tests; found a real bug where `.unref()` meant `exit(1)` never ran and a crashed backend reported success |
| Live stream delivers | 445 bytes of `hello` + `diagnostic` frames, direct and through the proxy |
| SSE blocked by the tunnel | **0 bytes** through `trycloudflare`, same request that worked locally |
| Fallback delivers over that tunnel | cursor 0 → 2 events with seq numbers, `missed: 0`, re-poll returns 0 |
| Subscriber safety | A throwing subscriber cannot break recording; cap is reported, not silently starved |
| No account ids on the wire | Asserted on the serialised live event |

---

## Known blind spots, ranked by what they cost

1. **Diagnostics are lost on crash.** In-memory store. The most valuable record — what happened
   immediately before a crash — is the one guaranteed not to survive it. Needs Phase 9.
2. **UE4 errors are not ingested.** A real, readable surface on disk, unused.
3. **Reboot is barely instrumented.** One report site. Host and session failures are invisible.
4. **Native crashes are not collected.** `crash.log`/`crash.dmp` are written and never read.
5. **No timeout/DNS/TLS instrumentation.** Categories exist; nothing emits them.
6. **Correlation is per-event, not per-incident chain.** `correlationId` is carried and stored, but
   nothing walks a chain to identify the *first* failure — Phase 8's central goal is unbuilt.

---

## What this document is not

It is not a claim that the system captures every failure. It captures **every failure response the
backend produces**, which is a real and useful guarantee, plus a defined subset elsewhere. The rows
above marked ❌ are not oversights being glossed — they are the work that remains, written down so
the next person does not have to rediscover the boundary.
