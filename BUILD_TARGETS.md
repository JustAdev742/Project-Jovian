# BUILD_TARGETS

**Which Fortnite builds to get, and in what order.** Written 2026-09-06 from measured coverage, not
from preference — every column below is harvested from the components' own sources or from the AES
archive, so this file can be regenerated rather than argued about.

---

## Read this first: you cannot triage a build from its .exe

The shipping client's code is **encrypted on disk**. 7.40's `.text` section measures a Shannon
entropy of **8.00 — the maximum possible** — across two `.text` sections, which is a protector's
unpacking stub plus its encrypted payload. `.rdata` is plain (4.41), so *string* scans of these files
work perfectly and give a thoroughly false impression that *code* scans should too.

`tools/sigcheck.mjs` reports **0 of 41 signatures present on 7.40** — the build both native
components demonstrably run on. That is the tool being right about a packed file, not the build being
unsupported, and it is why the tool now refuses to emit signature verdicts on a packed binary.

**So: whether a build works is only answerable by running it.** Cobalt is inside the decrypted
process and writes a `SIGNATURE COVERAGE` block on every launch (`Cobalt/signatures.h`). One run of a
new build tells you exactly which hook targets are missing.

What `sigcheck.mjs` *is* still good for: confirming a download is the build you meant, before you
install it.

```bash
node tools/sigcheck.mjs "<path>/FortniteClient-Win64-Shipping.exe"
```

It reports version, changelist, engine, whether the build predates Battle Royale, and whether it is
packed — from the file alone, in about a second.

---

## The coverage that exists today

| build | chapter/season | Reboot branches on it | AES chunk keys | Cobalt curl signature |
|---|---|---|---|---|
| 5.41 | Ch1 S5 | yes | none | untested |
| 7.30 | Ch1 S7 | yes | 6 | untested |
| **7.40** | **Ch1 S7** | **yes** | **2** | **yes — the current target** |
| 8.51 | Ch1 S8 | yes | 9 | untested |
| 9.41 | Ch1 S9 | yes | 5 | untested |
| 10.40 | Ch1 S10 | yes | none | untested |
| 11.31 | Ch2 S1 | yes | 14 | untested |
| 12.41 | Ch2 S2 | yes | 1 | untested |
| 14.60 | Ch2 S4 | yes | 7 | untested |
| 15.30 | Ch2 S5 | yes | 10 | untested |
| 17.50 | Ch2 S7 | yes | 15 | untested |
| 18.40 | Ch2 S8 | yes | 16 | untested |
| 19.01 | Ch3 S1 | — | 5 | untested |
| 20.40 | Ch3 S2 | yes | none | untested |
| 22.40 | Ch3 S4 | yes | none | untested |

**"Reboot branches on it"** means its source contains an explicit `Fortnite_Version == <this>` (or a
range covering it) — i.e. somebody wrote and presumably tested build-specific behaviour for it.
Reboot parses the engine version at runtime; it was never 7.40-only. Its branches span **3.3 to
22.40**, Chapter 1 Season 3 through Chapter 3 Season 4.

**"AES chunk keys"** is what `version/keychain.ts` can serve. The archive covers **7.10 – 19.01**
only; anything outside gets none, which is correct behaviour (nothing rather than another build's
keys) but means encrypted cosmetic chunks will not decrypt.

**"Cobalt curl signature"** is honestly `untested` everywhere but 7.40. Cobalt has three
`curl_setopt` patterns and three `PushWidget` ones with later-build attributions, but exactly **one**
`curl_easy_setopt` pattern — and that is the one the whole redirect depends on. Whether it holds on
any other build is unknown until one is run.

---

## Get these three first

Ranked by how much is already in place, so the earliest run yields the most information.

### 1. `8.51` — Chapter 1 Season 8

The single best next target, and it is not close:

- Reboot has both an explicit `8.51` version branch **and** a signature commented `8.51`
- Cobalt carries an `8.51` memory-leak signature, so somebody has had Cobalt on this build before
- 9 AES chunk keys, so cosmetics decrypt
- Closest build to 7.40 in the list, which gives the single unproven `curl_easy_setopt` signature its
  best chance of holding

If the curl signature survives anywhere, it survives here. If it does **not** hold on 8.51, that is
also worth knowing immediately, because it means every later build needs a new one.

### 2. `11.31` — Chapter 2 Season 1

The first Chapter 2 build, and the one that tests everything the cross-version backend work was
built for — chapter ≠ season, a different lobby, a different keychain.

- Reboot branches on `11.31` explicitly
- 14 AES chunk keys, one of the better-covered builds in the archive

### 3. `18.40` — Chapter 2 Season 8

The top of Reboot's well-covered range and the most AES keys of any candidate (16).

- Reboot branches on `18.40` explicitly
- Furthest from 7.40 while still inside both components' claimed coverage, so it is the strongest
  test of how far the current signatures actually reach

---

## Then, if those go well

`19.01` (Ch3 S1) is the last build the AES archive covers, and the natural stopping point for
cosmetics. Reboot branches on `19.00` and `19.10` but not `19.01` itself, so expect gaps.

`20.40` and `22.40` (Ch3 S2/S4) are inside Reboot's range but outside the AES archive: playable in
principle, no cosmetic chunk keys.

## Chapter 4 and later — not yet

**Reboot has no version branch above `22.40`.** Chapter 4 (23.x+) therefore needs new Reboot work
regardless of what the backend or Cobalt do. Cobalt's `26.00+` and `28.00+` patterns are for
`PushWidget`, which is dead code — they are kept only because they are the sole later-build
attributions in the project, and a run that reports which of them matches is real evidence.

Do not start here.

---

## What to do with a build once you have it

1. `node tools/sigcheck.mjs "<exe>"` — confirm it is the build you wanted.
2. Launch it once through the launcher.
3. Read the `SIGNATURE COVERAGE` block in the Cobalt log. Anything `MISSING` and `[required]` needs a
   pattern for that build, added to `Launcher/cobalt/Cobalt/signatures.h`.
4. For the backend side, re-run the scans in `tools/README.md` against the new client — that is what
   converts `UNKNOWN` rows in `VERSION_COMPATIBILITY.md` into evidenced ones. About twenty minutes
   per question, and the method is proven.
5. Re-run the 7.40 golden test. If it moved, the change is wrong.
