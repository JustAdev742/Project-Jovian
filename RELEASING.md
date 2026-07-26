# Releasing Project Nova

The launcher ships as a single NSIS installer that carries everything a player needs, and updates
itself from GitHub Releases. This is the whole process.

---

## Where updates come from

Already configured — `Launcher/src-tauri/tauri.conf.json`:

```json
"endpoints": ["https://github.com/JustAdev742/Project-Jovian/releases/latest/download/latest.json"]
```

The launcher checks that on startup. If no release exists yet it finds nothing and carries on
quietly; it does not error.

## ⚠ Guard the signing key

The updater keypair lives **outside the project on purpose**, so it can never be committed:

```
C:\Users\Admin\.nova-updater\nova-updater.key       <- PRIVATE. Never share, never commit.
C:\Users\Admin\.nova-updater\nova-updater.key.pub   <- public half, already in tauri.conf.json
```

**Back that private key up somewhere safe.** If you lose it you cannot sign updates any more, and
every existing install will refuse them — the only way out is telling everyone to reinstall by hand.
The public key baked into the app is what makes that refusal happen, and that is the point: nobody
who does not hold your private key can push code to your players.

---

## Cutting a release

### 1. Bump the version

`Launcher/src-tauri/tauri.conf.json` → `package.version`. The updater compares this against the
version in `latest.json`, so **it must go up** or clients will not take the update.

### 2. Refresh the bundled payload

The installer ships prebuilt binaries. If you changed any of them, restage before building:

```bash
cd "Main backend" && npx tsc                      # backend -> dist/
```

Then copy the current artefacts into `Launcher/src-tauri/resources/`:

| Goes to | From |
|---|---|
| `resources/Project Reboot.dll` | `backends/_extracted/Project-Reboot-main/x64/Release/Project Reboot.dll` |
| `resources/Cobalt.dll` | wherever you built Cobalt |
| `resources/Backend-Coordinator/dist` | `Main backend/dist` |
| `resources/nova-proxy/` | `nova-proxy/` (proxy.js + node_modules) |
| `resources/node/node.exe` | your installed Node |

`Backend-Coordinator/node_modules` is a **production-only** install:

```bash
cd Launcher/src-tauri/resources/Backend-Coordinator && npm ci --omit=dev
```

> **Never ship `data/`, `certs/`, `.env` or `*.log`.** `data/nova.db` is a live account database —
> it once made it into a build because a test run created it inside the staging folder. Check with:
> ```bash
> find Launcher/src-tauri/resources -maxdepth 3 \( -name data -o -name "*.db" -o -name .env \)
> ```

### 3. Build (signed)

The private key must be in the environment or the updater artefacts come out unsigned and clients
reject them:

```bash
cd Launcher
export TAURI_PRIVATE_KEY="C:/Users/Admin/.nova-updater/nova-updater.key"
export TAURI_KEY_PASSWORD=""
npx tauri build --features custom-protocol
```

Out come three files in `Launcher/src-tauri/target/release/bundle/nsis/`:

| File | Purpose |
|---|---|
| `Project Launcher_<ver>_x64-setup.exe` | what a **new** player downloads |
| `Project Launcher_<ver>_x64-setup.nsis.zip` | what **existing** installs download |
| `...nsis.zip.sig` | the signature proving it came from you |

### 4. Write `latest.json`

```json
{
  "version": "1.0.1",
  "notes": "What changed in this release.",
  "pub_date": "2026-07-26T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<paste the ENTIRE contents of the .sig file>",
      "url": "https://github.com/JustAdev742/Project-Jovian/releases/download/v1.0.1/Project.Launcher_1.0.1_x64-setup.nsis.zip"
    }
  }
}
```

`signature` is the **file contents**, not the path. `version` must match `package.version` exactly.

### 5. Publish

Create a GitHub release tagged `v<version>` and attach:

- `Project Launcher_<ver>_x64-setup.exe`
- `Project Launcher_<ver>_x64-setup.nsis.zip`
- `latest.json`

The endpoint uses `/releases/latest/`, so marking the release **latest** is what actually ships it.
A draft or pre-release will not be picked up.

### 6. Check it

On a machine running the previous version, open the launcher. It checks on startup and offers the
update in a dialog. If nothing happens, in order: is the release marked latest, does `version`
exceed the installed one, does `signature` match that exact zip.

---

## What ends up on a player's machine

```
Project Launcher.exe
resources/
  Project Reboot.dll        game-server DLL, injected when this PC hosts
  Cobalt.dll                redirects the game to the local proxy
  node/node.exe             bundled runtime — no prerequisites for the player
  nova-proxy/               local proxy: game -> coordinator
  Backend-Coordinator/      host agent (compiled JS, production deps only)
```

The launcher looks for each of these beside the exe **and** under `resources/`, so the same build
works installed or run from a dev tree.

**A player needs nothing except a Fortnite 7.40 build.** Node is bundled; the backend ships compiled
so no TypeScript toolchain is needed (that alone saved 34 MB).

---

## Notes

- **NSIS only, no MSI.** WiX cannot handle the bundled `node_modules` (file count and path depth) and
  fails in `light.exe`. NSIS is also the target the Tauri updater uses on Windows, so nothing is lost.
- **Installer ≈ 33 MB** from a ~136 MB payload.
- The updater replaces the whole app, so every update is a full download.
