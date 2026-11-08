# nova-doctor

Finds, groups and helps fix what is wrong with Project Nova, from the evidence that actually exists:
UE4's own logs and crash reports, Nova's logs, the backend/launcher/Cobalt/Reboot sources and builds,
the installed copies of each, and (optionally) the live coordinator.

It has no dependencies. It runs on the Node the launcher already bundles.

## Run it

```bash
node doctor/nova-doctor.mjs                    # scan: the fast modules, a few seconds
node doctor/nova-doctor.mjs scan --build       # also compile everything and read every warning
node doctor/nova-doctor.mjs scan --remote      # also check the live coordinator (read-only)
node doctor/nova-doctor.mjs scan --game "D:\Builds\7.40"   # when the build is not where the launcher last saw it
node doctor/nova-doctor.mjs serve              # view the report at http://127.0.0.1:4310/
```

The report is written to `doctor/out/latest/report.html` (and `report.json`), with a timestamped
copy under `doctor/out/runs/`. Reports quote local log evidence, so `doctor/out/` is gitignored.
Every quoted line is redacted for tokens and secrets before it is written.

## The loop it is built for

```bash
node doctor/nova-doctor.mjs scan --save-baseline   # 1. remember where things stand
# 2. read the causes, fix one, build
node doctor/nova-doctor.mjs repair                 # 3. list mechanical repairs (dry run)
node doctor/nova-doctor.mjs verify                 # 4. every test suite, then a re-scan vs the baseline
```

`verify` exits non-zero if any suite fails or the re-scan finds anything new. A finding that drops
out is reported as "no longer reported", never "fixed": a log can rotate away.

## How to read a finding

Two separate grades, deliberately:

- **Severity** says how bad it is if real: `P0` blocks play or hosting, `P1` serious, `P2` degraded,
  `P3` minor, `INFO` worth knowing.
- **Confidence** says how sure the doctor is that it is real: `CONFIRMED` (a positive signal was
  observed, such as a log line, a hash mismatch or a failed build), `PROBABLE` (one link inferred),
  `POTENTIAL` (a heuristic match; a lead, not a finding).

**Status** separates current problems from history: `open`, `stale` (not seen in the most recent
sessions: possibly fixed, possibly not exercised), `not-ours` (engine or content behaviour Nova
cannot change), `known-benign` (proven harmless), `resolved`.

Counts are never capped. Only the evidence samples kept per finding are, and the total is always shown.

## Modules

| module | file | what it reads |
|---|---|---|
| Project Scanner | `modules/scanner.mjs` | versions, staging gates, installed vs built binaries, NUL-torn files, the game build; `--remote`: coordinator drift by content diff, reachability, config rules |
| Log Intelligence | `modules/logs.mjs` + `rules/signatures.mjs` | every line of every UE4, cobalt, agent and launcher log, against the signature catalog; stale-vs-current; intermittency rates |
| Runtime Diagnostics | `modules/runtime.mjs` + `lib/minidump.mjs` | every UE4CC crash report (XML + minidump), Reboot crash files, live ports with identity probes, the running agent's own diagnostics |
| Asset & install | `modules/assets.mjs` | Engine.ini patch, served cloudstorage hotfix, sliver window, bumper files, pak footers, the Aftermath slot |
| Blueprint | `modules/blueprint.mjs` | LogScript runtime errors |
| Source & build | `modules/native.mjs` | C++ defect patterns, emitter drift, stale-tree references, forbidden payload files, bundled-node ABI, Cobalt imports, route auth; `--build`: tsc, cargo, MSBuild |
| Root Cause Analyzer | `modules/rootcause.mjs` | chains findings into causes, measuring timing where timing decides |
| Repair Engine | `lib/repair.mjs` | mechanical repairs with backup, verification and rollback |
| Regression Tester | `lib/verify.mjs` | every suite, judged by its output, then a baseline re-scan |
| Dashboard | `lib/render.mjs` | the self-contained HTML report |

What each requested capability maps to, and what does not apply here, is in [COVERAGE.md](COVERAGE.md).

## Teaching it a new failure

When you diagnose something once, add it to `rules/signatures.mjs` so it is recognised next time:

```js
{
  id: 'short-kebab-id', sources: ['ue4:client'],      // ue4, ue4:client, ue4:host, cobalt, agent, startup, coordinator
  re: /the exact text the log writes/,
  severity: 'P1', confidence: 'CONFIRMED', component: 'reboot', category: 'gameplay',
  cause: 'group-id', kb: 'KNOWN_ISSUES.md#the-entry',
  title: 'What happened, in plain words',
  explain: 'Why it matters and what it implies.',
},
```

Then add a line to `test/rules.test.mjs` with a real log line, including one that must NOT match.
The catalog's first runs against real logs produced three wrong rules; each is now pinned by a test.

## Tests

```bash
node --test doctor/test/*.test.mjs
```
