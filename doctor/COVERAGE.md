# What nova-doctor covers, and what does not apply

The brief asked for a diagnostics platform for "the actual Unreal Engine project". The first
investigation (2026-11-08) established what that project is:

- **There is no Unreal project, editor or engine build for Nova on this PC.** No `.uproject` belongs
  to Nova; the two found on D: (CitySample, GASP SuperheroFlight) are unrelated UE5 samples, and the
  one under `Documents\Hello neighor modding` is a separate project. No UE4 editor, UnrealBuildTool,
  UnrealHeaderTool or UnrealPak for 4.22 is installed.
- **The game is a shipped binary.** Fortnite 7.40 (UE 4.22, CL-5046157): a packed shipping exe plus
  AES-encrypted, cooked paks. Its Blueprints and assets are Epic's, compiled to bytecode.
- **Nova's own code** is a TypeScript backend, a Rust/React launcher, two C++ DLLs (Cobalt in the
  client, Reboot in the gameserver), a Node proxy, and the coordinator's deployment.

So the doctor investigates those, and reports the editor-era items as **not applicable, with the
reason**, rather than as a clean bill of health. Each row below says how the item is covered.

## Requested diagnostic coverage

| Requested | How it is covered | Module |
|---|---|---|
| UE editor logs and runtime logs | Runtime: every `FortniteGame*.log` (client and headless server, current and rotated), parsed with the launcher's own UE4 grammar; client and server told apart by `-nullrhi`. Editor logs: **n/a**, there is no editor. | logs |
| Blueprint compilation errors and warnings | **n/a**: no Blueprint source exists for Nova; the game's Blueprints are cooked bytecode in encrypted paks. | blueprint |
| Blueprint node failures, invalid references | Runtime Blueprint failures from `LogScript` (Accessed None, runaway loops, script messages). Graph-level checks (broken pins, references): **n/a**, for the same reason. | blueprint |
| C++ compilation, linking, UHT errors | Cobalt and Reboot built with MSBuild into a temp dir (`--build`), every `C####`/`LNK####` diagnostic read and graded (C4129 and friends promoted); six static defect patterns this project has shipped before. UHT: **n/a**, Nova's C++ is not UObject-reflected engine code. | native |
| Unreal Build Tool failures | **n/a**: Nova's C++ is built with plain MSBuild solutions, not UBT. The MSBuild results are covered above. | native |
| Missing assets, redirectors, broken references | Missing packages the game asks for (`Couldn't find file for package`), classified not-ours. Pak footers checked when the build is present (two crash reports on this PC were pak corruption). Redirectors and broken references: **n/a**, no editor content. | logs, assets |
| Invalid and circular dependencies | Nova-side dependency integrity: the bundled node must load the native SQLite module, and Cobalt's import table must not grow past 9 DLLs. Circular asset dependencies: **n/a**. | native |
| Configuration and project setting inconsistencies | Launcher version files must agree; local Engine.ini patch; the served cloudstorage hotfix (which outranks every local config); coordinator `.env` rules (presence only, never values); forbidden files in the installer payload. | scanner, assets, native |
| Gameplay system failures | Catalog rules for the inventory/quickbar chain, spawn races, offset lookups that read the vtable, gameserver exits by code. | logs, rootcause |
| Networking, replication, multiplayer | LogNet timeouts and travel failures, listen failures, the WorldInventory replication race, port identity probes, coordinator reachability from this PC. | logs, runtime |
| EOS and Fortnite integration | Requests escaping Cobalt's redirect to Epic (by foreign `originatingService`), Epic token rejections, hotfix batch failures, XMPP endpoint, the 7.40 session replay (`e2e-probe`, 22 steps), the endpoint method audit. 7.40 is an MCP-era build; the EOS SDK path is not exercised by it. | logs, verify |
| Asset loading, packaging, cooking | Streaming hitches and disk-search fallbacks; pak integrity. Packaging and cooking: **n/a**, nothing is cooked by Nova. | logs, assets |
| Crashes, assertions, ensures, recurring warnings | Every UE4CC report read (exception and modules from the minidump, role from the command line), grouped by fault frame, current-vs-stale by the crashing Reboot build's PE stamp; `=== Critical error: ===`, assertions, ensures; warnings tallied per category, never dropped. | runtime, logs |
| Deprecated functionality and incompatible APIs | MSVC C4996 (deprecated) when building; ABI compatibility of the bundled native module. Engine API deprecation: **n/a**, no engine source is compiled. | native |
| Performance problems and resource leaks | Game-thread hitches with count and worst duration; streaming disk searches. Leak detection needs a live process to sample, and is not built. | logs |
| Errors only under particular conditions | Intermittency as a rate per session (e.g. the ProcessEvent scan miss rate across host sessions); timing correlation in the Root Cause Analyzer (party presence before vs after XMPP login; client crashes after a dropped server connection). | logs, rootcause |

## Requested modules

| Module | Status |
|---|---|
| 1 Project Scanner | built: `modules/scanner.mjs` |
| 2 Log Intelligence | built: `modules/logs.mjs` + 55-rule catalog |
| 3 Blueprint Inspector | built for what exists (runtime LogScript); compile/graph checks n/a |
| 4 C++ Analyzer | built: `modules/native.mjs` (C++, plus the Rust launcher and TS backend) |
| 5 Asset Inspector | built: `modules/assets.mjs` |
| 6 Runtime Diagnostics | built: `modules/runtime.mjs` |
| 7 Root Cause Analyzer | built: `modules/rootcause.mjs`, 10 chains |
| 8 Repair Engine | built: `lib/repair.mjs`, mechanical repairs only (code defects are findings for a person) |
| 9 Regression Tester | built: `lib/verify.mjs`, 8 suites + baseline re-scan |
| 10 Diagnostic Dashboard | built: `lib/render.mjs`, `nova-doctor serve` |

## Known gaps, stated rather than rounded away

- **Anything that needs the game is skipped while the 7.40 build is missing** (paks, the Aftermath
  slot, Reboot's crash files). Pass `--game <folder>` once it is restored.
- **Cobalt's VEH re-arm window is unobservable from inside the process** (DIAGNOSTIC_COVERAGE.md);
  the doctor sees its consequences in UE4's logs instead.
- **Leaks and live resource use** are not sampled; the doctor reads evidence after the fact.
- **The route-auth audit reads handler bodies.** An auth step done somewhere else would not be seen,
  which is why those findings are graded PROBABLE.
- **Symbolising Reboot frames** in crash reports is not automated yet. The doctor records whether the
  crashing build matches today's PDB, which is the precondition.
