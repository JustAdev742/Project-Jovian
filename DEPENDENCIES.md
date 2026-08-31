# DEPENDENCIES

What this project needs to build and run, and which of those requirements are *hidden* — the ones
that make a clean machine behave differently from the developer's.

Verified 2026-08-31.

---

## 1. Runtime — what a player's machine must have

| requirement | needed by | how it is obtained | failure mode if absent |
|---|---|---|---|
| Windows x64 | everything | — | n/a |
| Fortnite **7.40** build (CL-5046157) | client + gameserver | supplied separately by the player | offsets in both DLLs are 7.40-specific; a different build silently mis-hooks |
| Tailscale | P2P mode only | launcher installs / joins with a key from the coordinator | no mesh → cannot host or join across machines |
| Node.js | `Main backend`, `nova-proxy` | bundled by the launcher | backend never starts |
| Visual C++ runtime | `Cobalt.dll`, `Project Reboot.dll` | usually already present | DLL fails to load |

**The hard version coupling is native, not backend.** Both DLLs resolve engine addresses by
signature scan. That is the project's tightest constraint on supporting a second build, and it is
**not** something a backend version adapter can abstract.

---

## 2. Backend — `Main backend/package.json`

Runtime: `fastify@^4.28`, `@fastify/cors`, `@fastify/formbody`, `@fastify/static`,
`better-sqlite3@^13`, `jsonwebtoken@^9`, `selfsigned@^2.4`, `uuid@^10`, `ws@^8.20`,
`xml-parser`, `xml2js`, `xmlbuilder`.

Dev: `tsx@^4.19`, `typescript@^5.5`, `@types/*`.

- `better-sqlite3` is the only **native** dependency — it needs a prebuilt binary or a toolchain, and
  it is the most likely thing to fail on a clean machine or a Node major-version bump.
- Tests use Node's built-in `node:test` via `tsx`. **No test framework was added.**
- The coordinator runs `tsx src/index.ts` directly. There is no build step in production, so
  `npm run typecheck` is the only thing standing between a type error and a live deploy.

## 3. `nova-proxy`

Node + `http-proxy`. Started by the launcher. Splits `/nova/api/host/*`, `/nova/api/logs`,
`/nova/api/components` to the local agent (`:3552`) and everything else to the coordinator.

## 4. Launcher — Tauri 1.5

**Rust** (`src-tauri/Cargo.toml`): `tauri` (updater + api-all), `reqwest`, `tokio`, `serde`,
`winapi`, `windows`, `injrs` (DLL injection), `zip` / `zip-extract`, `sysinfo`, `num_cpus`, `sha2`,
`libloading`, `ntapi`, `tasklist`, `discord-rpc-client`, `window-shadows`, `window-vibrancy`,
`tauri-plugin-deep-link` (**a git dependency, not a crates.io release**).

**Frontend**: React + Vite + TanStack Router/Query + Tailwind 4 + axios + tsparticles.

### Dependency hygiene — CONFIRMED, not fixed

| dependency | evidence | assessment |
|---|---|---|
| `mongodb = "2.8"` (Rust) | **zero** matches for `mongodb`/`mongo::` in `src-tauri/src/` | dead; heavy (pulls a large async tree, slows builds) |
| `electron` (npm) | **zero** imports in `Launcher/src` | dead in a Tauri app; large install |
| `warp = "0.3"` | one line only: `impl warp::reject::Reject for MyError {}` (`main.rs:18`) | vestigial; the trait impl is the sole tie |
| `child_process` (npm) | a stub package; Node's real module is built in | almost certainly unintended |

**Deliberately not removed in this session.** Rule 2 — a dependency with no source reference can
still be load-bearing through a build script, a feature unification, or a transitive requirement, and
removing four at once with no full build to verify against is exactly the unforced risk this project
should stop taking. The right sequence is: remove one, build, run, repeat.

`tauri-plugin-deep-link` tracking a git **branch** is a genuine supply-chain and reproducibility
risk — the build is not pinned and can change without any commit here. Worth pinning to a revision.

## 5. Native components

Both are MSVC, `PlatformToolset v143` (VS 2022), x64.

| | `Cobalt.dll` | `Project Reboot.dll` |
|---|---|---|
| solution | `Launcher/cobalt/Cobalt.sln` | `Project-Reboot-DLL/Project Reboot.sln` |
| libraries | MinHook, Memcury (vendored `memcury.h`) | MinHook, ImGui (`gui.cpp`, `fontawesome.h`) |
| installed by | **file replacement** over `GFSDK_Aftermath_Lib.x64.dll` | **injection** (`injrs`) |
| build identity | banner stamp is `log.cpp`'s compile time, so two different binaries self-identify identically (`cobalt-stamp-frozen`) | `baseaddress.log` records the load base |

**Identify these by hash, never by their own banner.**

---

## 6. Hidden environment assumptions

The brief asks specifically for these. Each is a real difference between a clean machine and this one.

1. **`%LOCALAPPDATA%` is user-relative.** Logs live in `%LOCALAPPDATA%\FortniteGame\Saved\Logs\` and
   `%LOCALAPPDATA%\ProjectNova\Logs\`. A standard-vs-admin user, or a UAC-virtualised path, relocates
   them — and the launcher's self-check looks in the *build* folder anyway (`selfcheck-wrong-gamelog-path`).
2. **Port 3551 has two possible owners.** In P2P mode `nova-proxy` owns it and the backend runs on
   `NOVA_PORT=3552`; in standalone the backend owns it. A backend that loses the race keeps running
   with no HTTP surface (`backend-eaddrinuse-zombie`).
3. **Port 443 is attempted unconditionally** when certs exist, which needs elevation. The failure is
   caught, so this is silent asymmetry between an elevated and non-elevated run.
4. **`tailscale` must be on `PATH`.** It was not on the coordinator user's PATH during the
   2026-08-15 audit, which blocked verification of the funnel configuration.
5. **`.env` beside `Main backend/`** is read at startup and does **not** override real environment
   variables. Whether `NOVA_REGISTER_SECRET` or `NOVA_TS_API_KEY` is set changes security behaviour
   with no visible difference in the UI.
6. **`start_backend` prefers `dist/` over sources** (`main.rs:156-168`), so a stale build can win over
   edited source.
7. **Nine `_backup-*` directories** sit in the repository root. Whether any lies on the launcher's
   binary-resolution path is **UNKNOWN** — flagged in the 2026-08-15 audit and still unchecked.

---

## 7. Reproducible setup

```bash
# backend
cd "Main backend" && npm install
npm run typecheck && npm test
npm run generate-certs            # optional; enables the HTTPS listener
NOVA_PORT=3599 NOVA_DB_PATH=/tmp/scratch.db npx tsx src/index.ts
```

**Always set `NOVA_DB_PATH` when experimenting.** Without it every local test writes into the one
real database, and "did my change work" and "did I just edit live player accounts" become the same
question.

```bash
# launcher
cd Launcher && npm install && npm run tauri build     # requires Rust + VS 2022 build tools
```

Native DLLs: open each `.sln` in VS 2022 and build x64/Release.
