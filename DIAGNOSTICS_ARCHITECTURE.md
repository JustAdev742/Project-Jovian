# DIAGNOSTICS_ARCHITECTURE

How a failure on one player's machine becomes a ranked incident an operator can act on.

Built 2026-09-05. Schema in [DIAGNOSTIC_SCHEMA.md](DIAGNOSTIC_SCHEMA.md); ranking and spike rules in
[INCIDENT_MODEL.md](INCIDENT_MODEL.md).

---

## 1. The path

```
Cobalt (in the game)     ─┐
Project Reboot (in the    ├─► POST /nova/api/diagnostics/local   ← unauthenticated, LOCALHOST ONLY
  gameserver)            ─┘        (host agent / standalone backend on this machine)
                                              │
Backend's own failures ──────────────────────►│  recordDiagnostic()
                                              ▼
                                    aggregate + redact + bound
                                              │
        launcher forwards, with ITS token ────┼──► POST /nova/api/diagnostics/ingest  (coordinator)
                                              ▼
                                    incident model (time series, scope)
                                              ▼
                          GET /nova/api/incidents · /nova/api/dashboard   ← ADMIN ONLY
```

## 2. Why there are two ingest endpoints

This is the part worth understanding before changing anything.

| | `/diagnostics/local` | `/diagnostics/ingest` |
|---|---|---|
| who calls it | Cobalt, Reboot | the launcher |
| auth | **none** | player token required |
| reachable from | this machine only | the coordinator, over Funnel |
| records an account | **no** | yes, from the token |

**Neither DLL holds a credential, and neither should.** Cobalt sees bearer tokens as a matter of
course — it hooks the call that sets curl's URL — so a component that authenticated its own telemetry
by borrowing the player's token would be doing precisely what the brief forbids. Instead the in-game
components report anonymously to localhost, and the launcher (which legitimately holds a token)
attributes and forwards.

`Config.HOST` is hard-coded to `127.0.0.1`, and `/nova/api/diagnostics/local` is in nova-proxy's
`LOCAL_PREFIXES` **for this reason, not for routing**. Without that entry the proxy would forward it
to the coordinator, putting an unauthenticated ingest endpoint on a host that Tailscale Funnel
publishes to the open internet.

## 3. The read side is a different boundary

The incident list is cross-population data: routes, builds, affected counts. It is gated behind
`NOVA_AC_ADMIN_SECRET` (falling back to `NOVA_REGISTER_SECRET`) and **fails closed** — unset means
unavailable, with a page that explains how to enable it rather than a 404.

A player may write. A player may not read, including their own aggregate.

## 4. What it costs on a player's machine

Measured constraints, not aspirations. The emitter runs inside the game.

| | value | why |
|---|---|---|
| distinct problems held locally | 64 | rows, not events — repeats increment a counter |
| bytes per URL / detail | 256 / 200 | truncated before the lock is taken |
| flush interval | 30 s | 40× less often than the log channel's 750 ms; these are aggregates |
| HTTP timeout | 4 s | a stalled backend must not accumulate threads |
| work on the hot path | one lock, one map lookup, one increment | no I/O, no allocation after first sight of a problem |
| load-time dependencies added | **zero** | verified with `dumpbin /dependents`: kernel32, user32, CRT only |

That last row is a hard constraint, not a nicety: Cobalt is loaded through the game's import table as
`GFSDK_Aftermath_Lib.x64.dll`, so its dependency list must stay as small as the file it replaces.
WinHttp is resolved with `GetProcAddress` on the background thread and never linked.

**Telemetry is never a hard dependency.** If the backend is unreachable the local table simply stops
growing at its cap, the flush is a no-op, and the game is unaffected. Nothing blocks, retries hard,
or reports its own failure to the user.

**Overflow is visible.** When the 64-row table is full, further distinct problems are counted and
that count is reported as its own event. "We stopped counting" appears in the same place as
everything else instead of being silent.

## 5. Untrusted input, on purpose

Events arrive over HTTP from player machines. `parseEvent` whitelists enums, truncates strings,
clamps counts, range-checks status codes and drops unknown fields. A client that lies can make its own
rows wrong and nothing else:

- an invented category becomes `UNKNOWN` rather than one with a high ranking weight
- `count: 1e9` clamps to 1,000
- a 10,000-event batch truncates to 50
- an `accountId` in the body is ignored; attribution comes from the token
- a per-account token bucket (120 burst, 2/s refill) answers `429` with `Retry-After` rather than
  dropping silently, so a well-behaved client can back off instead of spinning

**Everything rendered on the dashboard is escaped.** A reported URL of `</script><script>…` renders as
visible text; a test asserts it.

## 6. Redaction happens twice

`Redact()` in the C++ emitter, before anything is queued, and `redactSecrets()` in the backend, on
receipt. Two layers because the cost of one live credential reaching a database is not worth a clever
single implementation.

**The C++ half has its own test, and it earned it.** The first version matched `code=` anywhere,
which turned `Gameserver exited (code=3221225477)` — the single most useful host diagnostic in the
project — into `(code=<redacted>`. Reading the code did not catch that; running it did. Secret query
parameters now require a preceding `?` or `&`.

```bash
Launcher/cobalt/Cobalt/tests/build-and-run.cmd
```

That script also fails if the emitter has drifted from the copy Reboot builds — the two must stay
byte-identical or the dashboard silently loses its ability to compare a client failure with a host
one.

## 7. Correlation

`Nova::Diag::SetCorrelationId()` stamps subsequent reports on the calling thread; Cobalt sets a fresh
id per redirected request. The id travels with the event and is shown on the incident, so one player
action can be followed from the game through the backend to the host — the difference between knowing
what failed last and knowing where it failed first.

Thread-local on purpose: a shared global would leak one request's id into another thread's unrelated
report, which is worse than having none.

## 8. What each component reports

| component | source | what it is uniquely able to see |
|---|---|---|
| Cobalt | `CLIENT` / `NETWORK` | an Epic host the redirect list did not match — the escape, **at source**, rather than as a 401 in a log an hour later |
| Reboot | `HOST` | a gameserver that never opened its lobby (NOVA-306); from outside this looks like matchmaking hanging, and only this process knows why |
| backend | `BACKEND` | unrouted paths, deliberate 4xx, thrown errors — already wired since 2026-08-31 |

**What Cobalt's check cannot catch, stated plainly.** A request that escapes because the VEH hook was
*unarmed* during its re-arm window never reaches the detour at all, so it is invisible from there by
construction. That is the larger cause (see KNOWN_ISSUES `nova-303-request-escape`). What the check
does catch is the other one — a host nobody added to the list — and the two are worth telling apart.

## 9. Not yet wired

**The launcher does not yet forward local events to the coordinator.** Everything below that step
works and is tested; the Rust side is the remaining piece, and until it ships, local events stay on
the player's machine and are visible only through that machine's own `/nova/api/diagnostics`.

The coordinator's own backend failures already appear on the dashboard today.
