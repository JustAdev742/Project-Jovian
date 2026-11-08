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

## On every player's PC: live mode and the fleet dashboard

From launcher 1.9.4, every launcher starts the doctor in **live mode** and the coordinator collects
what it finds into one admin dashboard covering every player.

```
nova-doctor live ──POST /nova/api/doctor/local, /local-report──▶ host agent (127.0.0.1:3552)
launcher (diagreport.rs, every 20 s) ──GET /pending, then POST /nova/api/doctor/ingest (player token)──▶ coordinator
```

The doctor holds no credential. It hands its findings to the local agent, and the launcher forwards
them under the player's own token. The DLLs' diagnostics already use this attribution model.

**Light on the player's PC.** The launcher starts it as
`node resources/doctor/nova-doctor.mjs live --agent … --parent <launcher pid>` with no window and at
below-normal priority. It exits when the launcher does. Its limits are in `lib/live.mjs` (`LIMITS`):

- **Log reading**: every 10 s it stats the logs and reads only the bytes appended since the last
  read, at most 1 MiB per file per read. It never re-reads a whole file and follows rotation.
- **What it sends**: problem lines only. That means catalog matches that aren't benign or not-ours,
  UE4 Error and Fatal lines, and warnings in Nova-owned categories. At most 1,000 are queued;
  beyond that the oldest are dropped and counted.
- **Full report**: a player-profile scan (about 2–3 s of one core), at most once every 10 minutes and
  never while the game is writing its log. It runs about 90 s after start-up if no game is
  running, and again when a game session goes quiet. The upload is a summary plus the gzipped
  report, 1.5 MB at most, with evidence trimmed beyond that.

**Privacy.** Before anything is queued, tokens are redacted, the host part of an IPv4 address is
masked, the Windows user name in paths becomes `<user>`, and the PC name becomes
`PC-<8 hex of sha256>`. That label still tells two PCs on one account apart. Settings → Diagnostics
→ *Share problems with the Nova admins* writes `%LOCALAPPDATA%\ProjectNova\doctor.off`; with that
file present nothing is sent. The local report is still written to
`%LOCALAPPDATA%\ProjectNova\Doctor`. Live mode logs to `…\Logs\doctor-live.log`.

**The dashboard** is at `/nova/api/doctor/dashboard` on the coordinator (admin secret, the same
sign-in as the incidents dashboard). It has three views:

- **Fleet**: every reporting player, the problems they share and who has each one, and a live feed
  of problem lines. The feed can be filtered by player and severity, the filter is kept in the link,
  and it can be paused.
- **Player**: a page per player with the causes found on their PC.
- **Full report**: the player's full doctor report, served in a CSP sandbox because it comes from
  their machine.

The coordinator re-validates and clamps every field (`services/doctor/doctor.validate.ts`),
rate-limits each account, and keeps 2,000 lines per player, 200,000 in total, and each player's
last 3 reports.

A problem line normally reaches the dashboard in about 20 s, and in about 45 s at worst (one read,
one hand-off, one forward).

**Test it without the game.** `NOVA_DOCTOR_FAST=1` runs the same code with second-scale limits. The
end-to-end harness, `node tools/fleet-e2e.mjs`, starts a coordinator, an agent and a live doctor on a
fake `LOCALAPPDATA`, writes a game session into its logs, and forwards the results the way the
launcher does. As of 2026-11-08 this has **not** been seen in a real match, because there is no 7.40
build on the dev PC.

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
