# INCIDENT_MODEL

How Nova decides what is worth an operator's attention, and in what order.

Implementation: `Main backend/src/services/nova/incidents.ts` (trends, scope) and `diagnostics.ts`
(severity). Every number below is adjustable; the formulas are meant to be argued with rather than
trusted.

---

## 1. Severity is not a count

```
score = subsystemWeight × categoryWeight × (1 + log10(count)) × userFactor × growthFactor
```

Each term is bounded so none can dominate:

| term | range | why |
|---|---|---|
| `subsystemWeight` | 0.5 – 5 | matchmaking and auth block play; telemetry does not |
| `categoryWeight` | 2 – 6 | a crashed gameserver outranks an unrouted path |
| volume | logarithmic | 10 occurrences ≈ 2×, 100 ≈ 3× — volume matters but cannot outrank importance |
| `userFactor` | 1 – 3× | one player hitting a wall is a bug report; twenty is an incident |
| `growthFactor` | 1 – 2× | rises when most occurrences are inside the trend window |

### Bands

| severity | score | meaning |
|---|---|---|
| `CRITICAL` | ≥ 100 | cannot connect / cannot play, **and widespread** |
| `HIGH` | ≥ 40 | major functionality broken |
| `MEDIUM` | ≥ 15 | significant feature failure |
| `LOW` | ≥ 5 | minor |
| `INFORMATIONAL` | < 5 | not a failure |

Calibrated from worked cases rather than round numbers:

```
telemetry MISSING    ×1000 events, 20 users  ->   36  MEDIUM    (loud, nobody blocked)
storefront MISSING   ×1 event,      1 user   ->   13  LOW
mcp MISSING          ×5 events,     1 user   ->   45  HIGH
matchmaking 500      ×3 events,     3 users  ->   96  HIGH
matchmaking 500      ×100 events,  20 users  ->  450  CRITICAL
```

### CRITICAL requires breadth

**A problem affecting one player can never be CRITICAL, however loud it is.**

Found on the live dashboard: a single player retrying matchmaking 480 times scored 103 and rendered
CRITICAL directly above the caption "one machine — probably local to that player". Both statements
were true; together they were absurd. The brief defines CRITICAL as "cannot connect / cannot play /
**widespread** failure", so breadth is part of the definition, not a tuning knob.

The score is left untouched, so ranking *within* HIGH still reflects how loud something is.

---

## 2. Scope — whose problem is it

Severity says how bad. Scope says who to go and talk to, and the two are independent.

| scope | condition | what it means |
|---|---|---|
| `ISOLATED_CLIENT` | ≤ 1 affected | one machine; almost always their install or their network |
| `SMALL_CLUSTER` | 2–4 affected | worth watching, not yet an outage |
| `VERSION_SPECIFIC` | concentrated in one build while others exist | a regression |
| `HOST_ISSUE` | `source: HOST` | a gameserver, not the players |
| `BACKEND_OUTAGE` | `BACKEND` + 5xx-class + ≥ 5 affected | we are the cause |
| `NETWORK_WIDESPREAD` | `NETWORK` + ≥ 5 affected | clients cannot reach us at all |
| `WIDESPREAD` | ≥ 5 affected | broad, no sharper shape fits |

### `VERSION_SPECIFIC` needs a real second build

On a single-build deployment *everything* is concentrated in one build, so this would be a permanent
false positive. Two guards: more than one build must be present, and **`unknown` does not count as a
build** — it is what a request with no parseable User-Agent gets, including a browser opening the
dashboard. That second guard was added after the live board classified everything as a regression;
the unit test had passed because it was handed a clean set.

---

## 3. Spike detection

Twelve five-minute buckets per problem, one hour of history, advanced lazily so an idle problem costs
nothing.

```
spiking  =  current >= 10  AND  current >= baseline × 3
```

Both terms are necessary:

- **Without the absolute floor**, 0 → 2 is an infinite-percentage rise and the board fills with noise
  the moment anything happens twice.
- **Without the multiple**, a steadily busy endpoint looks like a permanent emergency.

A problem with no history spikes on the absolute term alone, which is the behaviour you want for
something that has genuinely never happened before.

The brief's worked example — 5 → 8 → 11 → 74 → 631 — is detected, and a test pins it.

Anything spiking ranks above everything else regardless of score: a quiet high total should not
outrank something that is actively getting worse.

---

## 4. State

`ACTIVE` until 30 minutes of silence, then `RESOLVED`. Resolved incidents stay on the board, dimmed,
because "this stopped on its own" is information.

## 5. Identity

`SUBS-XXXX` — a subsystem prefix plus a short hash of `source|category|method|route|version`. Stable
across polls so a row can be followed over time, and short enough to quote in a message. The same
problem always produces the same id; a different route produces a different one.

---

## 6. Tuning

Change the weight tables and thresholds, not the formulas:

| what | where |
|---|---|
| subsystem importance | `SUBSYSTEM_WEIGHT` in `diagnostics.ts` |
| category importance | `CATEGORY_WEIGHT` in `diagnostics.ts` |
| severity bands | `severityFor()` in `diagnostics.ts` |
| spike sensitivity | `SPIKE_MIN_ABSOLUTE`, `SPIKE_MULTIPLE` in `incidents.ts` |
| resolve delay | `RESOLVE_AFTER_MS` in `incidents.ts` |
| bucket size / history | `BUCKET_MS`, `BUCKET_COUNT` in `incidents.ts` |

Tests in `diagnostics-distributed.test.ts` pin the behaviours that matter — including that volume
cannot outrank importance, and that a steady high-volume endpoint is not a spike.
