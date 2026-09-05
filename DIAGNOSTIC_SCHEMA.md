# DIAGNOSTIC_SCHEMA

The wire format every Nova component uses to report a failure. Three processes emit it — the backend,
Cobalt inside the game client, Project Reboot inside the gameserver — and the central view is only
worth anything while they agree.

Definitions: `Main backend/src/services/nova/diagnostics.schema.ts` (authoritative) and
`Launcher/cobalt/Cobalt/diagnostics.h` (the C++ mirror).

---

## Event

```jsonc
{
  "source":        "CLIENT",              // CLIENT | HOST | BACKEND | NETWORK | VERSION
  "category":      "MATCHMAKING_FAILURE", // see below
  "method":        "POST",                // HTTP verb, or a short verb like LAUNCH / TRAVEL
  "url":           "/fortnite/api/...",   // path or operation; normalised server-side
  "component":     "cobalt",              // cobalt | reboot | launcher | backend
  "build":         "7.40",                // SHORT build id - never a User-Agent
  "status":        503,                   // optional, 100-599
  "detail":        "no gameserver registered",
  "correlationId": "NV-1A2B3C4D0007",     // optional; ties one action across components
  "count":         12                     // occurrences already aggregated by the emitter
}
```

Batched as `{ "events": [ ... ] }`.

### `build` is a short id, not a User-Agent

It is part of the aggregation key. Feeding it a raw User-Agent made every browser that opened the
dashboard its own "build", keyed rows on 200-character strings, and made the incident model report
`VERSION_SPECIFIC` for everything. Use the id from `identifyVersion` — `"7.40"`, or `"unknown"`.

---

## Categories

Canonical set. The first ten predate the distributed work and are unchanged.

| category | meaning |
|---|---|
| `MISSING` | no route matched; the catch-all answered |
| `FAILED` | a handler ran and deliberately returned 4xx |
| `TIMEOUT` | no response in time |
| `AUTH_FAILURE` | token absent, malformed or rejected |
| `INVALID_RESPONSE` | answered, but not in a shape the caller could use |
| `UNEXPECTED_STATE` | reached a state that should not occur |
| `NETWORK_FAILURE` | never reached anything |
| `INTERNAL_ERROR` | 5xx, or a handler threw |
| `VERSION_MISMATCH` | the caller's build is not the one this behaviour was written for |
| `SESSION_FAILURE` | a session could not be created, joined or kept |
| `MATCHMAKING_FAILURE` | the player could not be placed in a match |
| `PARTY_FAILURE` | a party could not be formed or maintained |
| `CRASH` | a component died |
| `UNKNOWN` | unclassified |

### Accepted aliases

The ingest boundary accepts these and normalises them, so the C++ emitters and the engineering brief
can keep their own vocabulary without a second taxonomy existing:

| sent | stored as |
|---|---|
| `MISSING_CALL`, `UNROUTED_PATH` | `MISSING` |
| `FAILED_CALL` | `FAILED` |
| `OTHER` | `UNKNOWN` |
| `SESSION_ERROR` / `MATCHMAKING_ERROR` / `PARTY_ERROR` | the `_FAILURE` form |

`UNROUTED_PATH` and `MISSING_CALL` fold into `MISSING` because they are the same event seen from the
client rather than the server — and `source` already carries that distinction. Keeping them separate
would produce three rows for one problem.

**Anything unrecognised becomes `UNKNOWN`.** A client cannot invent a category, and so cannot pick
one with a high ranking weight to climb the board.

---

## Sources

| source | who |
|---|---|
| `CLIENT` | the game client (Cobalt) |
| `HOST` | the gameserver (Reboot) |
| `BACKEND` | Nova itself |
| `NETWORK` | the request never reached anything identifiable |
| `VERSION` | a build/compatibility mismatch |

An unrecognised source becomes `CLIENT`, **never** `BACKEND` — defaulting to BACKEND would let a
client's own failure be attributed to the server, which is the exact confusion this field exists to
prevent.

---

## Limits

Every one is reachable from untrusted input, so each is enforced rather than assumed.

| limit | value |
|---|---|
| events per batch | 50 |
| `url` | 512 chars |
| `detail` | 300 chars |
| `component` | 40 chars |
| `build` | 80 chars |
| `correlationId` | 64 chars |
| `count` claimed by one emitter | 1,000 |
| per-account rate | 120 burst, 2/s refill, then `429` + `Retry-After` |

An event with no `url` is dropped: there is nothing to aggregate it under. A malformed event is
skipped rather than failing its batch — one bad row from a client must not discard the good ones that
came with it.

---

## Never transmitted

Tokens, cookies, passwords, private keys, session secrets, and account ids from the in-game
components.

Redaction runs **twice**: in the C++ emitter before anything is queued, and in the backend on receipt.
See [DIAGNOSTICS_ARCHITECTURE.md](DIAGNOSTICS_ARCHITECTURE.md) §6 for why two layers, and for the
over-redaction bug that testing caught.
