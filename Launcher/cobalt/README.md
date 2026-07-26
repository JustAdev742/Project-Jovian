# Cobalt

The redirect shim Project Nova loads into the Fortnite client. It is vendored here, inside the
launcher repo, so it is versioned and auditable alongside the code that ships it.

## What it does, exactly

Two things, and nothing else:

1. **Rewrites Epic service URLs to the local Nova backend.** It hooks libcurl's `curl_easy_setopt`
   and, when the game sets `CURLOPT_URL` to an Epic online-services host, replaces the host with
   `http://127.0.0.1:3551`. Every other host is passed through untouched.
2. **Turns off TLS peer verification for those requests** (`CURLOPT_SSL_VERIFYPEER` → 0), because
   the local backend serves a self-signed certificate.

It also swallows two popups the game raises once it notices it is not talking to Epic
(`UnsafeEnvironmentPopup`, `RequestExitWithStatus`). That is cosmetic; the game is playable without it.

### Why it has to be a loaded module rather than a launch flag

There is no command-line route to either behaviour on a Shipping build:

- `-DisableSSLCertificatePinning` is inside `#if !UE_BUILD_SHIPPING` and is compiled out.
- `-ini:` overrides are gated on `ALLOW_INI_OVERRIDE_FROM_COMMANDLINE = (UE_SERVER || !UE_BUILD_SHIPPING)`,
  so `n.VerifyPeer` cannot be set that way either.
- `-NOSSLPINNING`, which gets passed around online, is not a real Unreal switch at all.

## What it does *not* do

No obfuscated or encrypted strings. No packing. No self-modifying code. No manual PE mapping or
reflective loading. No anti-debug, no anti-VM, no attempt to detect or evade security software. It
does not touch any process other than the one it is loaded into, does not persist anything, does not
auto-start, does not phone home, and makes no network connection except to `127.0.0.1:3551`.

Everything it does is written to the log (below) as it happens.

## Where the logs go

Both of these, always — never a console window:

- **The launcher's Logs tab**, tagged `cobalt`. Lines are batched and POSTed to the backend's
  `/nova/api/logs/ingest`, which is the same ring buffer the launcher already polls.
- **`%LOCALAPPDATA%\ProjectNova\Logs\cobalt.log`**, so there is a durable record even when the
  backend is not running.

The launcher also shows a live status line (`active — redirecting to …`, or the reason it failed).

Earlier versions called `AllocConsole()` and printed to a second console window. That window was
easy to close by accident, which killed the game with it, and nothing was ever recorded.

Set `COBALT_VERBOSE` in `Cobalt/settings.h` to log every redirected request. It is off by default
because the curl hook is a hot path.

## Building

```powershell
.\build.ps1            # -> cobalt\x64\Release\Cobalt.dll
.\build.ps1 -Deploy    # also copies it next to the launcher exe
```

Needs Visual Studio with "Desktop development with C++". No NuGet restore and no network access:
MinHook is vendored in `vendor/MinHook`.

## Notes for anyone reviewing this for safety

A few deliberate choices, since a DLL that gets copied into a game folder reasonably attracts
scrutiny:

- **Hooking is MinHook only** — ordinary trampoline patching. The previous version additionally used
  Memcury's VEH hooks, which install a vectored exception handler over `PAGE_GUARD` pages and
  allocate `PAGE_EXECUTE_READWRITE` memory. Both are standard anti-malware heuristics, and neither
  was necessary.
- **The binary carries full version metadata** (company, product, description, and a comment
  explaining its purpose). It is deployed under another product's filename
  (`GFSDK_Aftermath_Lib.x64.dll`, the slot the game loads from), which without honest metadata looks
  like masquerading.
- **The log file lives under `%LOCALAPPDATA%`**, not in the game directory — writing into a game
  install at runtime is both a heuristic trigger and often not permitted.
- **`DllMain` only calls `DisableThreadLibraryCalls` and starts one thread.** All real work happens
  off the loader lock.

It is not code-signed. Signing needs a certificate that only the project owner can hold; without one
a SmartScreen prompt on first run is expected.

## Credits and licence

Cobalt by [Milxnor](https://github.com/Milxnor/Cobalt) · Memcury by
[kem0x](https://github.com/kem0x/Memcury) · curl hook signatures from Neonite++. See `LICENSE`.

Not affiliated with, endorsed by, or connected to Epic Games.
