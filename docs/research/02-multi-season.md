# 02 — Chapter 1 to Chapter 4 from one launcher and one backend: what it takes, per version range

*Researched 2026-11-08. Read-only on all source code. Sources: this repo (backend `Main backend/src`,
Reboot fork `Project-Reboot-DLL/`, Cobalt `Launcher/cobalt/`, launcher `Launcher/src-tauri/src`,
the in-repo LawinServerV3 reference, the local endpoint corpus), the project's own cross-version
docs, and public source of other OGFN projects read through the GitHub API (all URLs are in §9). No
game was run and no build was obtained. Nothing here describes how to get builds; it assumes the user
supplies builds they own.*

Evidence grades follow the repo convention: **CONFIRMED** (read directly in code or a primary
source), **STRONGLY SUPPORTED** (two or more independent sources agree), **INFERRED** (reasoned from
indirect evidence), **UNKNOWN** (needs a binary or a run). Effort: **S** ≈ under a week, **M** ≈ 1–4
weeks, **L** ≈ 1–3 months, for one developer who already knows this codebase.

---

## 1. Summary

Nova is not starting from zero. The backend already has a version layer (`src/version/`) that knows
42 majors, identifies the build per request, and serves the right timeline season, lobby stage,
per-build AES chunk keys and per-era locker. **What blocks other seasons is mostly not the backend.**
In order of how hard they bind:

1. **The two native DLLs are tied to 7.40.** Cobalt redirects through one `curl_easy_setopt` byte
   signature labelled "7.40 (primary target)", and its EOS hook is an empty function. Reboot has
   pattern sets for UE 4.16 up to 22.40, but nothing at all for Chapter 4 (23.x+); it would open the
   wrong map there.
2. **The backend assumes one build at a time in places that matter for more than one player.**
   Matchmaking remembers a single global `lastBuildUniqueId`. The gameserver registry and the host
   election have no build key, so a 7.40 client could be routed to an 11.31 server. Hotfixes are one
   static set for every build.
3. **Real protocol boundaries inside Chapters 2–4:** the MCP revision rule changes at 12.20, parties
   move to the stateful V2 REST service by about 15.00, playlist selection moves to the Discovery
   service in Chapter 3, and Chapter 4 needs game-connection encryption turned off. Chapter 4 also
   needs a gameserver that Nova does not have.
4. **The launcher handles one build.** `BuildItem` is `{id, path, name, coverDataUrl}`. Nothing
   records which version a folder is, and `launch_fn` refuses any build without
   `FortniteClient-Win64-Shipping_EAC.exe`.

**Recommended order** (reasons in §7): foundation work first, then C1 S7–S8 → the rest of C1 S5–S10
→ C1 S3–S4 → C2 up to 14.x → C2 15.x–18.x → C3 S1 → C3 S2–S4 → C1 S1–S2 → C4.

---

## 2. The version map used in this report

Engine versions are what Reboot's own parser assigns (`Project-Reboot-DLL/Project Reboot/patterns.h:100-168`).
Map names come from Reboot's `MapName` selection (`dllmain.cpp:590`) and, for ≥23, from Project Reboot 3.0.

| Range | Majors | UE (Reboot parser) | BR map | Party | MCP revision key | Playlist selection | Grade |
|---|---|---|---|---|---|---|---|
| C1 S1–2 | 1.7.2–2.5 | 4.16 / 4.19 | Athena_Terrain | XMPP V1; Lawin supports parties only from 3.5 | `rvn` | classic | CONFIRMED (code) |
| C1 S3–6 | 3.0–6.31 | 4.20 / 4.21 | Athena_Terrain | XMPP V1 (≥3.5) | `rvn` | classic | CONFIRMED |
| C1 S7–10 | 7.00–10.40 | 4.22 / 4.23 | Athena_Terrain | XMPP V1. 7.40 binary has no `bUsePartySystemV2` | `rvn` | classic | CONFIRMED |
| C2 early | 11.00–12.10 | 4.24 / 4.25 | Apollo_Terrain | V1 kept alive by hotfix | `rvn` | classic | INFERRED (party) |
| C2 mid | 12.20–14.60 | 4.25 / 4.26 | Apollo_Terrain | V1 by hotfix up to 14.50 (Lawin range) | **`commandRevision`** | classic | STRONGLY SUPPORTED (MCP) |
| C2 late | 15.00–18.40 | 4.26 / 4.26.1 | Apollo_Terrain | **V2 REST needed** | `commandRevision` | Discovery V1 present by 18.40 | INFERRED (party boundary) |
| C3 S1 | 19.00–19.40 | 5.0 | Artemis_Terrain | V2 | `commandRevision` | Discovery | CONFIRMED (map, engine) |
| C3 S2–4 | 20.00–22.40 | 5.x | Artemis_Terrain | V2 | `commandRevision` | **Discover tab** (Zero Build) | STRONGLY SUPPORTED |
| C4 | 23.00–27.11 | 5.1+ | **Asteria_Terrain** | V2 | `commandRevision` | Discovery V2 + access token | CONFIRMED (map, UE 5.1); INFERRED (discovery V2) |

The calendar `seasonNumber` is the continuous major (24 = C4 S2), not the season within the chapter.
That is already handled and pinned by a test (`CROSS_VERSION_ARCHITECTURE.md` §4).

---

## 3. What exists today, component by component

### 3.1 Backend (`Main backend/src`) — already version-aware, but in a narrow band

**In place (CONFIRMED, read in code):**
- `version/identify.ts`: per-request `GameVersion {major, minor, chapter, season, changelist, confidence, signals, platform}`, parsed from `Release-X.Y` in the User-Agent and set by `middleware/version-router.ts` on every request.
- `version/builds.ts`: 42 majors → chapter/season. `version/features.ts`: 30 feature rows with evidence grades.
- What actually varies by build today: timeline `seasonNumber` and flags, the lobby stage (`social.routes.ts:483`, `:583`), `enabled_features` (`:379`), keychain (`version/keychain.ts`, 75 builds, 7.10–19.01), the locker era filter (`mcp/profiles/athena.ts:423`), and the cloudstorage settings file name (keyed on major).
- The 7.40 baseline guard is `version/version.test.ts`, `describe('7.40 baseline …')` at line 444. It drives the real handlers with the 7.40 User-Agent.
- EOS-SDK-shaped routes already exist (`services/eos/eos.routes.ts`: `/auth/v1/oauth/token`, `/epic/oauth/v2/token`, `/epic/id/v2/sdk/accounts`, `/sdk/v1/*`, `/v1/epic-settings/...`), as do `/links/api/fn/mnemonic*`, `/region`, `/publickey/v2/publickey`, `/api/v1/fortnite-br/surfaces/motd/target` and `/fortnite/api/game/v2/br-inventory` (`services/compat/compat.routes.ts`).

**Still hardcoded to one build (CONFIRMED):**

| Where | What | Effect on another build |
|---|---|---|
| `mcp/profiles/athena.ts:229`, `:313` | `past_seasons` and `season_num` come from `Config.SEASON_NUMBER` (7) when the profile is seeded, and are never rewritten per request. Lawin and Reload overwrite `season_num` from the request on every operation. | A C2 client is told it is in season 7. Battle pass and XP UI can mismatch. |
| `athena.ts:296` | `version: 'nova_lawin_ch1s7'` | Cosmetic, probably harmless. |
| `athena.ts:423-442` | The era filter drops items but leaves `locker_slots_data` and `favorite_*` pointing at them | An older build can receive a loadout that references items it was not sent. |
| `athena.ts` seed | Only 335 Chapter 1 cosmetics are granted | C2+ players get none of their era's items. |
| `mcp.routes.ts` | No build-dependent revision rule. The features table records that the response revision is derived *from the client's* `rvn` (`mcp.rvn.serverAuthoritative`). | Breaks at 12.20+ (see §4.1). |
| `social.routes.ts:595-598` | Season LTM flags exist only for 7 and 8 | Other seasons get base flags only. |
| `social.routes.ts:477-560` | Content pages: MOTD says "Chapter 1 Season 7/8"; `playlist_info` lists Chapter 1 playlists only; no `shopSections` | Wrong tiles; shop sections in later builds. |
| `cloudstorage.routes.ts:165-205` | One static hotfix set for every build, including `bUsePartySystemV2=false` | Cannot carry per-build keys (§4.6). |
| `matchmaking.routes.ts:937-938` | `lastBuildUniqueId` is one global, overwritten by every ticket | With two builds connected, the session echoes the wrong `buildUniqueId`, and the client discards the session. |
| `matchmaking.routes.ts:280-296`, `:1027-1060` | `resolveGameServer(playlist, region)` and `/nova/api/gameserver/register` have no build field | Cross-build routing. The client connects to a server of another version and fails. |
| `social.routes.ts:220-345` | Party V2 REST routes are stateless stubs: no party store, no XMPP `com.epicgames.social.party.notification.v0.*` messages | A V2-only build can create a solo party and nothing more (§4.2). |
| `identify.ts:125-149` | A UA without a numbered `Release-` falls back to the configured major 7, graded UNKNOWN | 1.x/2.x builds (UA `Release-Cert` / `Release-Next`) are served Season 7 data (§5.1). |

**Possible existing bug to verify before Chapter 2:** Nova serves the lobby stage
`lobbyseason{major}` (`social.routes.ts:535`). Lawin, Reload and Neodyme all serve `season{major}`,
`seasonx` for 10, `Winter19` for 11.31/11.40, and `season{major}00` from 21 onward
(Lawin `structs/functions.js:122-160`; Neodyme `page-service.js:227`). The 7.40 test pins
`lobbyseason7`, but nothing in the repo shows that name was checked against a real document. Three
independent backends agree on the other scheme, which makes it STRONGLY SUPPORTED as the safer choice
for C2+. Measure it on the first non-7.40 run.

### 3.2 Reboot gameserver (`Project-Reboot-DLL/Project Reboot/`)

This is Milxnor's Project Reboot V2 rewrite. Its upstream README claims "S5-S12", "S3 and S4 have
support but haven't been tested much", and "S13-S18 work perfectly fine, but the safezone does not
work" (`Project-Reboot-DLL/README.md`). The code goes further:

- **Version detection is runtime and generic** (CONFIRMED, `patterns.h:102-168`). It reads `GetEngineVersion()` or the `++Fortnite+Release-` string. It derives `Engine_Version`, `Fortnite_Version` and `Fortnite_Season`, and uses the changelist for `Live`/`Next`/`Cert` builds (`CL <= 3775276 ? 416 : 419`).
- **Pattern sets** (CONFIRMED): UE 416, 419 (with a 1.11 special case), 420, 421, 422, 423, 424, 425, 426, 427 (forced for 16.00–18.40), 500 (with a 19.10 special case), then `Fortnite_Season == 20/21/22` blocks and a 22.4 block (`patterns.h:179-645`).
- **`ServerReplicateActorsOffset` table** (`patterns.h:650-669`) covers everything to S22, with comments like "never tested 15.2", "checked on 22.30", and 7.40–8.40 = 0x57.
- **Map selection** (`dllmain.cpp:590`): `Engine_Version < 424 ? Athena_Terrain : (< 500 ? Apollo_Terrain : Artemis_Terrain)`. **For ≥23 this picks Artemis_Terrain.** Project Reboot 3.0 uses `Asteria_Terrain` for `Fortnite_Version >= 23`.
- **Hardcoded RVAs** for 12.41 (`GIsClient`, a hook at `+0x42ACE40`) and 20.40 (`IsGameServerForEvent` at `+0x5CD2B88`) (`dllmain.cpp:351-394`). These are valid only for those exact builds.
- **Season-specific hooks**: `Fortnite_Season >= 17` "sigcrash", `>= 22` "afq", and events code for 5.30–20.40 (`events.cpp`).
- **Nova's own 7.40 assumptions** (CONFIRMED): `Nova::Diag::Init("reboot", "7.40")` (`dllmain.cpp:630`); the quickbar gates `< 7.4` and their comments (`inventory.cpp:257-264`, `processevent.cpp:153-161`); the WinHTTP locker bridge to `127.0.0.1:3551` (`helper.cpp:442`, `:544`); `ApplyCID`/`ApplyBackpack` tuned to 7.40's `CharacterParts` layout; and the ProcessEvent resolution that aborted on 7.40 until 1.8.9 (KNOWN_ISSUES `processevent-signature-misses-on-7.40`).

**Net:** for majors 3–22 the fork has code paths that someone wrote for those builds, and none of
them has been run under Nova. For ≥23 there is nothing. Project Reboot 3.0's own README claims
S3–S15, says "S1-S2 & S16-S19 … might not work perfectly", and keeps S20+ on a separate unstable
branch. Reboot Launcher ships **two** Reboot DLLs and switches at major 20
(`dll_controller.dart`, `_isS20`).

### 3.3 Cobalt (`Launcher/cobalt/Cobalt/`)

- **One required signature** (CONFIRMED, `signatures.h:85-88`, `dllmain.cpp:189-190`): `curl_easy_setopt`, labelled "7.40 (primary target)". The optional `curl_setopt` fallbacks carry "later builds" and "28.00" labels. `PushWidget` patterns labelled 26.00+/28.00+ are kept only as evidence.
- **`InitializeEOSCurlHook()` is empty** (`dllmain.cpp:170-172`), as it is upstream. **Requests from `EOSSDK-Win64-Shipping.dll` are never redirected.** That DLL carries its own HTTP stack.
- **The build label is not detected**: "7.40 (assumed - Cobalt does not yet detect the build)" (`dllmain.cpp:648-650`).
- The host allow-list (`curlhook.h:93-100`) already includes `epicgames.dev`, `on.epicgames.com` and `ol.epicgames.com`. That covers every Fortnite service hostname in the corpus, including `fn-service-discovery-live-public.ogs.live.on.epicgames.com` and `fn-service-habanero-live-public…`. Hostnames are not the problem; the hook target is.
- **Constraint from the project's history:** a full Cobalt rewrite crashed the game twice and the user stopped it (memory note `cobalt-component`). Any multi-build work has to *add* a second strategy behind a build check and leave the 7.40 path byte-identical.

### 3.4 Launcher (`Launcher/`)

- **Single build** (CONFIRMED): `localStorage.buildPath` plus `ProjectMP.builds: BuildItem[]`, where `BuildItem = {id, path, name, coverDataUrl?}` (`src/useLauncher.ts:72`, `:184-214`). No version, CL or engine is recorded.
- **`launch_fn`** (`src-tauri/src/carter.rs:956-1030`) hard-requires `FortniteClient-Win64-Shipping_EAC.exe`, starts it suspended, then starts `FortniteLauncher.exe` and the shipping exe. `dll_replace` (`:555`) installs Cobalt as `Engine\Binaries\ThirdParty\NVIDIA\NVaftermath\Win64\GFSDK_Aftermath_Lib.x64.dll`. That assumes the build ships that DLL slot and that Cobalt can load that early.
- **Arguments** (`build_fortnite_args`, `carter.rs:761-866`) are fixed for 7.40. Its own comments record that retail 7.30/7.40 used `-noeac -fromfl=be` and 8.51+ used `-nobe -fromfl=eac`. `-caldera` was removed as "a no-op … before ~19.00", which is exactly where it starts to matter (§6.1).
- **`patch_local_engine_ini()`** writes `%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\Engine.ini`. **Every build shares that directory.** INFERRED risk: a newer build's `GameUserSettings.ini` or Engine overrides could be read by an older build.
- **`server_launch_spec(path, …)`** (`carter.rs:888`) takes a path, not a build. The backend's host runner and the coordinator (`hostRunner.ts:340`, `host.rs:201`) register servers with no build field.

---

## 4. The protocol changes a private backend has to handle, in version order

| At | Change | What Nova must do | Grade / source |
|---|---|---|---|
| < 3.5 | Banner/homebase operations write to `profile0`, not `common_core` | Branch `SetBattleRoyaleBanner`'s profile | STRONGLY SUPPORTED: Lawin `routes/mcp.js:920`; Reload `mcp.js` (`memory.build < 3.5`) |
| ≤ 2.x | UA carries `Release-Cert` / `Release-Next` / `Release-Live` with no version number | Map the changelist to a version | CONFIRMED: Lawin `structs/functions.js:63-77` (CL thresholds 3724489 / 3790078); Reboot Launcher `game_metadata.dart` (CL → version table) |
| 3.5 – 14.50 | XMPP V1 parties work (via the `bUsePartySystemV2=false` hotfix where the build has both systems) | Existing XMPP server | CONFIRMED that Lawin claims "Parties (builds 3.5 to 14.50)"; INFERRED that the boundary is the V1 removal |
| 12.20 | MCP compares the client's revision to **`commandRevision`**, not `rvn` | `ProfileRevisionCheck = build >= 12.20 ? commandRevision : rvn`, and send a full profile update when they differ | STRONGLY SUPPORTED: identical rule in Lawin (`routes/mcp.js:64` and others) and Reload (`routes/mcp.js`). Reload also uses `>= 19.01` for `UnlockRewardNode` |
| 12.20 | Locker **presets** (loadouts) | Multiple `CosmeticLocker` items; `CopyCosmeticLoadout`, `DeleteCosmeticLoadout`, `SetCosmeticLockerName` (Reload implements all three) | STRONGLY SUPPORTED (SlashGear / Inverse: presets shipped in v12.20; Reload code) |
| ~15.00 | Party V2: REST `/party/api/v1/Fortnite/*` with server-held state, member updates pushed over XMPP as `com.epicgames.social.party.notification.v0.{PARTY_UPDATED, MEMBER_STATE_UPDATED, MEMBER_JOINED, MEMBER_LEFT, MEMBER_NEW_CAPTAIN, PING, INITIAL_INVITE, INVITE_CANCELLED, INITIAL_INTENTION}` | A real party store plus XMPP fan-out; Reload `routes/party.js` is a complete reference | CONFIRMED (Reload code); boundary INFERRED |
| ≤ 18.40 | Discovery V1 `POST /api/v1/discovery/surface/:accountId` exists | Route it | CONFIRMED: endpoint corpus `FN-Discovery-Service/Discovery/V1/Main.md` uses an 18.40 UA in its example |
| 19.x | UE5, the Artemis map, EOS SDK traffic in earnest | Redirect the EOS SDK module (§6); keep the `eos.routes.ts` routes | CONFIRMED (Reboot map code); EOS volume UNKNOWN |
| 19.x+ | `-caldera=<jwt>` handed to the game by the Epic launcher | Pass a static token, as Reboot Launcher does for every build | CONFIRMED (Reboot Launcher `createRebootArgs`; Reload "Caldera Service … used for the startup of newer Fortnite builds"); exact first build UNKNOWN |
| ≥ 19.30 | `DefaultRuntimeOptions.ini`: `bForceBRMode=true`, `bSkipSubgameSelect=true` | Per-build hotfix | CONFIRMED: Neodyme `cloud-storage-manager.js:283-290` |
| 20.00 | Zero Build playlists, reached from the Discover page | Per-era playlist set; discovery surface | STRONGLY SUPPORTED (VGC, Inverse) |
| 23.00 | **Game-connection encryption on**: the server rejects clients without an `EncryptionToken` | Hotfix `[ConsoleVariables] net.AllowEncryption=0` (or implement the token) | STRONGLY SUPPORTED: Neodyme (`season >= 23`); Twin1dev 24.20-Gameserver README; UE source `PendingNetGame.cpp` |
| 23.00 | UE 5.1, the Asteria map, World Partition | New gameserver work (§5.8) | CONFIRMED (Unreal Engine blog; Reboot 3.0 code) |
| C4 | Discovery V2 `POST /api/v2/discovery/surface/:surface` with `X-Epic-Access-Token`, from `GET /fortnite/api/discovery/accessToken/:branch` | Route both (Reload `routes/discovery.js` serves both from a static file) | CONFIRMED (corpus `Discovery/V2/Main.md`, Reload); first build INFERRED |
| 24.00 | UEFN / Creative 2.0 (22 Mar 2023) | Not needed for a BR-only backend beyond the discovery stubs | CONFIRMED (press) |
| 24.40 | Ranked replaces Arena (17 May 2023): Habanero service | Stub `fn-service-habanero` tracks and progress | CONFIRMED (GameSpot, Dexerto); endpoints in corpus `FN-Habanero-Service/` |
| 30.10 | EAC enforced, so DLL injection stops working | **Outside C1–C4** | CONFIRMED: Kronos-CLI README |
| Aug 2024 | Chat moves from XMPP to EOS Connect / STOMP | **Outside C1–C4.** XMPP stays valid through 27.x (Reload, tested on 27.11, still configures `[OnlineSubsystemMcp.Xmpp]`) | CONFIRMED: fnbr.js commit 2024-08-02 |

**Calendar shape:** the `client-events` state Nova already sends (`seasonNumber`,
`seasonTemplateId`, `seasonBegin/End`, store-end dates) matches what Lawin sends to every build up to
25.x (`routes/timeline.js:1117-1160`). Only the **active event flags** vary per season, and Lawin and
Neodyme carry those lists for S3–S32. CONFIRMED.

**Matchmaking:** the ticket → mms websocket → session flow is the same through 27.11. Reload uses the
same `ticketType: "mms-player"` shape and reads `bucketId` as four colon-separated parts. STRONGLY
SUPPORTED (Reload `routes/matchmaking.js`, Lawin `routes/matchmaking.js`). Reload also gates its whole
backend to **one** joinable build with `bEnableOnlyOneVersionJoinable` (Reload `routes/auth.js`).
That is a reminder that serving several builds at once is the uncommon case.

---

## 5. Per range

Every range also needs the foundation work in §6. Each section lists only what is specific to it.

### 5.1 C1 S1–S2 (1.7.2–2.5)

- **Backend:**
  - Teach `identify.ts` the changelist → version map. Today these builds come out as UNKNOWN and get Season 7's timeline. Lawin's thresholds work as a coarse fallback; Reboot Launcher's exact CL table is better.
  - `SetBattleRoyaleBanner` must write to `profile0` below 3.5. `profile0` handling exists only as a stub (`features.ts` `mcp.profile.profile0`).
  - Lobby/timeline flag `LobbyWinterDecor` for S2 (Lawin).
  - `enabled_features: ["store"]` is already handled.
  - Parties: Lawin supports none below 3.5. UNKNOWN.
  - Whether 2017 builds honour `[XMPP] bEnableWebsockets=true` and `[OnlineSubsystemMcp.Xmpp] ServerAddr="ws://…"` is UNKNOWN. If they only speak TCP XMPP, the XMPP server needs a TCP listener.
- **Reboot:** 416/419 pattern sets and changelist-based detection exist. Upstream 3.0 says S1–S2 "might not work perfectly". Erbium lists 1.7.2–3.3 as partial support. Status: untested, risky.
- **Cobalt:** UNKNOWN whether the libcurl signature holds. Reboot Launcher uses one universal redirect DLL (`sinum.dll`) for all builds, so this is solvable.
- **Launcher:** the anti-cheat executable layout of 2017 builds is unrecorded (BattlEye era); `launch_fn` hard-fails without `_EAC.exe`. Whether the Aftermath DLL slot exists is UNKNOWN; fall back to injecting Cobalt.
- **Blockers:** oldest engine, a different UA scheme, and the least-tested gameserver.
- **Effort: L.** Lowest value per unit of work, so it goes late.

### 5.2 C1 S3–S6 (3.0–6.31)

- **Backend:**
  - Per-season event flags (Lawin `timeline.js:22-180`, including per-build ones such as 3.1/3.3/3.4, 4.3/4.4/4.5, 6.20/6.21/6.22).
  - Lobby stages season3–6.
  - Party V1 from 3.5; 3.0–3.4 parties UNKNOWN.
  - Per-era playlists by binscan.
  - The AES archive starts at 7.10, so these builds get no keys. Whether this era's cosmetics are encrypted at all is UNKNOWN.
- **Reboot:** 420 (3.x–4.x) and 421 (5.x–6.x) pattern sets. Events for 5.30, 5.41 and 6.21. The ≤422 `NetDebug` hook is "tested on 7.3" and "5.41". Upstream calls S5–S6 the supported core and S3–S4 under-tested.
- **Cobalt:** UNKNOWN; the same libcurl generation as 7.40 is plausible (INFERRED).
- **Blockers:** none structural.
- **Effort: M** (S5–S6 nearer S; S3–S4 nearer M).

### 5.3 C1 S7–S10 (7.00–10.40)

- **Backend (small):**
  - Event flags for S9/S10 (Lawin `timeline.js:252-320`; Nova has 7 and 8).
  - `seasonx` lobby stage for S10 (Lawin, Neodyme).
  - Per-era playlists (binscan). Keys: 8.51 has 9, 9.41 has 5, 10.40 has none.
  - Party V1, MCP and calendar shapes are the same as 7.40.
- **Reboot:** 422/423 pattern sets. Explicit branches for 7.30, 8.51, 9.40/9.41 and 10.40. The ServerReplicateActors offset table has 7.40–8.40 = 0x57 and the rest of 7–10 = 0x56.
- **Cobalt:** it carries an 8.51 memory-leak signature behind `#if 0`. Reboot Launcher ships a separate memory-leak DLL for "some Fortnite versions", and Starfall auto-patches the leak. 8.51 will probably need it switched on for that build only. The curl signature is untested beyond 7.40, but 8.51 is its best chance (`BUILD_TARGETS.md`).
- **Blockers:** none beyond the foundation.
- **Effort: S–M.**

### 5.4 C2 early (11.00–12.10)

- **Backend:**
  - Chapter ≠ season already handled for the timeline, keys and cloudstorage key.
  - Lobby stage `Winter19` for 11.31/11.40 (Lawin, Reload); S11 event flags (Lawin `timeline.js:323-435`).
  - Per-request `season_num`; per-era cosmetics. Party V1 still forced by hotfix (INFERRED).
  - Content pages: `shopSections` once the build's shop uses sections. The first build that does is UNKNOWN.
- **Reboot:** 424 pattern set, an 11.31-specific replication offset (0x59), `Apollo_Terrain`, 11.30/11.31 events. Covered by the upstream "S5–S12" claim.
- **Cobalt:** UNKNOWN; budget for a new signature.
- **Effort: M.**

### 5.5 C2 mid (12.20–14.60)

- **Backend:** the **12.20 MCP revision switch**. Reload's `PutModularCosmeticLoadout` handler, the one handler that skips the 12.20 check, carries the note "this doesn't work properly on version v12.20 and above". That handler belongs to a later locker and is probably outside C1–C4 (INFERRED), but the note confirms that revision handling which ignores the 12.20 rule breaks. Treat 12.20 as a boundary to test, not a formality. Loadout presets (12.20). 12.41 / 12.61 / 14.60 event content (Lawin/Reload).
- **Reboot:** 425/426 pattern sets. **12.41 uses absolute RVAs** (`dllmain.cpp:351`, `:390`). S13 special cases. Upstream says the S13–S18 safezone does not work, so expect storm/zone work.
- **Effort: M.**

### 5.6 C2 late (15.00–18.40)

- **Backend:**
  - **Party V2 for real**: party store, invites, pings, intentions and the XMPP fan-out listed in §4. Nova's stubs probably allow a solo lobby (Lawin's original backend uses the same kind of stub, `structure/party.js`) but not multiplayer parties.
  - Discovery V1 surface (present by 18.40).
  - Shop sections, battle stars and gold bars (`br-inventory` already routed).
  - Whether EOS SDK traffic appears in this range is UNKNOWN; record `EOSSDK-Win64-Shipping.dll` presence per build (§6.3).
- **Reboot:** 426 / 427 (forced for 16.00–18.40). `sigcrash` hook from S17. Events for 17.30/17.40/17.50/18.40. ServerReplicateActors 0x5F for 15.3–18. Safezone caveat as above.
- **Effort: L** (party V2 is the bulk).

### 5.7 C3 (19.00–22.40)

- **Backend:**
  - Per-build hotfixes, starting with `bForceBRMode` / `bSkipSubgameSelect` at ≥19.30.
  - Discovery surfaces and links mnemonics for playlist selection (Zero Build at 20.00 is reached from Discover). Nova has `links` but no `discovery` routes.
  - The `-caldera` launch argument.
  - EOS endpoints become live traffic (Nova already routes them).
  - The AES archive ends at **19.01**, so 19.10–22.40 get no cosmetic chunk keys.
  - Winterfest content for 19.01 (Lawin, Reload).
- **Reboot:**
  - 19.x: the `Engine_Version == 500` block plus a 19.10 special case. Project Reboot 3.0's comment: "hooking broken on 19.10".
  - 20–22: the S20/S21/S22 and 22.40 blocks; double-precision math from 20.00 (`helper.cpp:13`); replication tweaks for 20–22; the 20.40 hardcoded RVA.
  - Every upstream points at a separate gameserver line from 20: Reboot Launcher switches DLL at major 20, Reboot 3.0 keeps S20+ on an "unstable" branch, and Erbium supports to 19.40 and only partially after that.
- **Cobalt:** UE5 makes it very likely that the curl signature will not hold (INFERRED). Implement the string-anchored resolver plus the EOS SDK hook (§6.2).
- **Blockers:** EOS SDK redirect, a gameserver that is less mature from 20 on, missing AES keys after 19.01.
- **Effort: L.**

### 5.8 C4 (23.00–27.11)

- **Gameserver: the binding blocker.**
  - Nova's fork has no pattern sets for ≥23. It would open `Artemis_Terrain` where Asteria is needed.
  - Its ServerReplicateActors value for ≥21 (0x67) was "checked on 22.30" only.
  - UE 5.1 plus World Partition is new ground for this code.
  - Options: Project Reboot 3.0's S20+ branch (it has `Fortnite_Version >= 23/24` paths and `Asteria_Terrain`), Erbium (partial 20.00–30.00), or Twin1dev's 24.20 gameserver. Any of them is a second gameserver DLL selected per build, as Reboot Launcher does.
- **Backend:**
  - `net.AllowEncryption=0` hotfix for ≥23, or implement `EncryptionToken`.
  - Discovery V2 plus the access-token route; links mnemonics.
  - Habanero stubs for ≥24.40; MOTD target (routed); Winterfest 23.10; per-season content and lobby art.
  - Lobby stage naming (`season{N}00` per Neodyme).
  - No AES keys in the archive.
- **Launcher:** C4 layouts use `FortniteClient-Win64-Shipping_EAC_EOS.exe` (Velocity-OGFN ships an "EAC EOS shim for stripped Ch4+ builds"; FortServer's launcher looks for it "to launch on higher versions"). `launch_fn` must accept it.
- **Cobalt:** the string-anchored resolver plus the EOS hook, as for C3.
- **Anti-cheat:** DLL injection still works below 30.10 (Kronos), so C4 is reachable.
- **Effort: L, the largest range.**

---

## 6. Cross-cutting work, needed before any second build

### 6.1 Launcher: one install, many builds

**Import.** Read the version from `CrashReportClient`'s version resource, which is how Reboot
Launcher does it. Its comment: "on some versions the shipping exe has it as well, but not on all". Or
read the `++Fortnite+Release-` string from `.rdata`, which `tools/sigcheck.mjs` already does. Map
Cert/Next builds through the changelist table. Ask the backend's build registry for chapter and season.

**Per build, store:**

| Field | Why |
|---|---|
| `id`, `path`, `displayName`, `cover` | What exists today |
| `fortniteVersion` (e.g. `11.31`), `major`, `minor`, `changelist`, `engineVersion`, `chapter`, `season` | Selection, host election, gameserver choice |
| `exeSha256`, `exeSize` | Detect a replaced or patched install. The `-skippatchcheck` flow cannot tell otherwise |
| `acLayout`: which of `FortniteLauncher.exe`, `_BE.exe`, `_EAC.exe`, `_EAC_EOS.exe` exist | Drives `launch_fn`; today it hard-requires `_EAC.exe` |
| `hasAftermathSlot` | Whether the `GFSDK_Aftermath_Lib.x64.dll` hijack is possible, or Cobalt must be injected |
| `hasEOSSDK` (`EOSSDK-Win64-Shipping.dll` present) | Turns on Cobalt's EOS-module hook |
| `redirectStrategy` (`curl-sig-7.40` / `processrequest-xref`) | Keeps the 7.40 path untouched |
| `gameserverDll` (`reboot-v2-fork` for <20 or <23, plus a second DLL for later), with its hash | Reboot Launcher-style split |
| `launchArgsProfile` (`-fromfl`/`-noeac`/`-nobe`/`-fltoken`, `-caldera`, extra) | Era-specific; the 7.40 set stays exactly as it is |
| `memoryLeakFix` (e.g. 8.51) | Cobalt or Starfall-style patch, per build |
| `aesKeyCount` (from the backend keychain) | Shown so users know cosmetics may be blank |
| `supportTier` (computed: Supported / Experimental / Unsupported) plus the last Cobalt `SIGNATURE COVERAGE` result and last-run outcome | Honesty in the UI; feeds the doctor |
| `savedConfigSnapshot` (optional) | INFERRED risk: all builds share `%LOCALAPPDATA%\FortniteGame\Saved`. Swap or back up `Saved\Config` per build at launch |

**Also change:**
- `server_launch_spec` and the host runner take a build id. A machine hosts only builds it has.
- Gameserver registration carries `build`.
- The intro bumper and `patch_local_engine_ini` must check whether a build supports what they assume.

### 6.2 Cobalt: add a second strategy without touching the first

- **Detect the build first** (Reboot already does this: `++Fortnite+Release-` / `GetEngineVersion`) and label `Signatures::Report` with it.
- **Builds whose `curl_easy_setopt` signature resolves**: unchanged path.
- **Others: hook `FCurlHttpRequest::ProcessRequest`, found by string reference.** Starfall anchors on `STAT_FCurlHttpRequest_ProcessRequest` or the log string `"%p: request (easy handle:%p) has been added to threaded queue for processing"`, then patches the vtable and rewrites the URL through `SetURL`. This does not depend on a byte pattern, which is why Starfall and Tellurium claim to be universal across UE4/UE5 ("redirect/SSL bypass for UE 4/5 games using native HTTP").
- **Apply the same resolver inside `EOSSDK-Win64-Shipping.dll`** (Starfall `LoadLibraryA("EOSSDK-Win64-Shipping")` and the `EOSProcessRequestHook`). This is what the empty `InitializeEOSCurlHook()` should become.
- This respects the "do not rewrite Cobalt" rule: new code, gated by build, with the 7.40 bytes unchanged.

### 6.3 Backend: version per request, and no cross-build mixing

**How to detect the version, in priority order:**
1. **User-Agent** `Release-X.Y-CL-N` (exists). Add the changelist → version table for `Release-Cert/Next/Live`.
2. **Bind the build to the session at login.** On `POST /account/api/oauth/token`, store `token → GameVersion` and `accountId → lastBuild`. Use that for requests that carry no usable UA: the XMPP websocket (authenticated by token in SASL), the matchmaker websocket, and gameserver-originated calls. Raise a diagnostic when the UA and the token's build disagree.
3. **Matchmaking `bucketId[0]`** (the network changelist / `buildUniqueId`). Make it the **partition key** for tickets, sessions, the gameserver registry, host demand and the coordinator's election. Replace the global `lastBuildUniqueId` with a per-ticket value. Never return a server of a different build.
4. Keep the existing rule that only a CONFIRMED identification may trigger an era filter.

**Behaviour switches** go through `version/features.ts` rows, not `if (major >= n)` at call sites,
per the project's own design (`CROSS_VERSION_ARCHITECTURE.md` §1, §8). New rows from this report:
`mcp.revision.commandRevision@12.20`, `locker.presets@12.20`, `party.v2.required@~15`,
`hotfix.forceBRMode@19.30`, `discovery.v1`, `discovery.v2.accessToken`, `net.encryption@23`,
`habanero@24.40`, `banner.profile0<3.5`, `ua.changelistOnly≤2`.

**Per-build hotfixes:**
- `GET /fortnite/api/cloudstorage/system` must list, and `…/system/:file` must serve, a per-build variant, with hashes matching what is served.
- Keep the set small; the reason is recorded in `cloudstorage.routes.ts:206-220`.
- Generate the variants from the base file plus feature rows (Neodyme's `getSystemFile(fileName, season, build)` is a working pattern).

**XMPP:**
- Keep global and party MUCs from mixing builds (suffix room names with the build or partition the server).
- Add V2 party notifications for V2 builds.

**MCP:**
- Revision rule by build.
- Per-request `season_num`.
- Era-sanitise locker slots and favourites when items are filtered.
- Per-era cosmetic grants from the 23k-record cosmetics corpus that `version/cosmetics.ts` is already generated from.

### 6.4 Measurement before code, per build

This is the project's proven method (`CROSS_VERSION_STATUS.md` "What would actually finish it"):
1. Run `tools/binscan.js` on the build for playlists, `bUsePartySystemV2`, `party/api`, `commandRevision`, `discovery`, `habanero` and `AllowEncryption`.
2. Launch once and read Cobalt's `SIGNATURE COVERAGE`, `GET /nova/api/diagnostics` (MISSING routes), and the escapes Cobalt reports as "Epic host not matched".
3. Add a golden test for that era on the 7.40 template, then branch behaviour.

The 7.40 suite (`version.test.ts:444`) must stay green after every step.

---

## 7. Recommended order

| # | Step | Effort | Why this position |
|---|---|---|---|
| 0 | **Foundation**: launcher build library (§6.1); token-bound version plus build-partitioned matchmaking, registry and coordinator (§6.3); per-build hotfixes; Cobalt build detection and label; `launch_fn` accepting any anti-cheat layout | M | Nothing multiplayer is safe without it. Two builds on one backend today can cross-route and break each other's sessions |
| 1 | **C1 S7–S8** (7.30, 8.51) | S | Same protocol era as 7.40. Reboot has explicit 7.30/8.51 branches and Cobalt has an 8.51 signature, so this is the cheapest test of whether the curl signature holds at all |
| 2 | **C1 S5–S6 and S9–S10** (5.41, 6.21, 9.41, 10.40) | S–M | Upstream Reboot's core range ("S5-S12"). The backend needs only data (event flags, lobby, playlists) |
| 3 | **C1 S3–S4** (3.5+, 4.5) | M | Same backend era. Reboot is "not tested much". Parties only from 3.5 |
| 4 | **C2 up to 14.x** (11.31, then 12.41, 14.60) | M | First chapter ≠ season build, which the existing cross-version layer was built to handle. Then the 12.20 MCP and preset boundary, isolated from the party change |
| 5 | **C2 15.x–18.40** (15.30, 17.50, 18.40) | L | Party V2 becomes mandatory. Doing it after step 4 keeps the two boundaries apart |
| 6 | **C3 S1** (19.01, 19.10) | L | First UE5 and EOS build. Forces the string-anchored Cobalt resolver and the EOS hook. 19.01 is the last build with AES keys in the archive |
| 7 | **C3 S2–S4** (20.40, 22.40) | L | Discovery-driven playlists and Zero Build. Reboot's ≥20 line is a separate, less mature gameserver track |
| 8 | **C1 S1–S2** (1.8–2.5) | L | A different UA scheme and the oldest engine, for little player value. Parallel side track once the foundation exists |
| 9 | **C4** (23.10 → 27.11) | L | Needs a gameserver Nova does not have (Asteria, UE 5.1, World Partition) plus encryption off, Discovery V2 and Habanero. Everything before it de-risks it |

Steps 1–3 can overlap once step 0 lands. Party V2 (step 5) can be developed against the backend in
parallel with steps 1–4, since it is pure TypeScript with Reload's `party.js` as reference.

---

## 8. Top blockers, ranked

1. **Native lock-in.** Cobalt has one 7.40 curl signature and an empty EOS hook. Reboot has nothing for ≥23, has absolute RVAs for 12.41 and 20.40, and has never been run under Nova on any build but 7.40. CONFIRMED.
2. **Single-build backend state.** The global `lastBuildUniqueId`, a gameserver registry and host election with no build key, and one hotfix set. CONFIRMED.
3. **No second client binary to measure against.** This is still the project's stated gate (`CROSS_VERSION_STATUS.md`). Every INFERRED boundary in §4 becomes an evidenced row with one binscan per build.
4. **Party V2** (≈15.00+): stateful REST plus XMPP fan-out. Boundary INFERRED.
5. **EOS SDK traffic not redirected** (C3+, maybe late C2). Its effect on login is UNKNOWN until a run.
6. **C4 gameserver plus game-connection encryption.** STRONGLY SUPPORTED.
7. **AES keys** missing outside 7.10–19.01, so encrypted cosmetics in those builds will not load. CONFIRMED (archive coverage). Not a boot blocker.
8. **Not blockers inside C1–C4**: EAC enforcement (from 30.10) and the move of chat to EOS Connect (Aug 2024). Both are after 27.11. CONFIRMED.

---

## 9. Sources

**This repo:** `CROSS_VERSION_ARCHITECTURE.md`, `CROSS_VERSION_STATUS.md`, `VERSION_COMPATIBILITY.md`,
`BUILD_TARGETS.md`, `KNOWN_ISSUES.md`; `Main backend/src/version/{identify,builds,features}.ts`,
`version/version.test.ts`; `Main backend/src/services/{social/social.routes.ts, mcp/mcp.routes.ts,
mcp/profiles/athena.ts, matchmaking/matchmaking.routes.ts, cloudstorage/cloudstorage.routes.ts,
eos/eos.routes.ts, compat/compat.routes.ts, xmpp/xmpp.server.ts}`;
`Project-Reboot-DLL/Project Reboot/{patterns.h, dllmain.cpp, events.cpp, inventory.cpp, helper.cpp}`,
`Project-Reboot-DLL/README.md`; `Launcher/cobalt/Cobalt/{signatures.h, dllmain.cpp, curlhook.h}`;
`Launcher/src-tauri/src/carter.rs`, `Launcher/src/useLauncher.ts`;
`LawinServerV3-main backend code reference/{structs/functions.js, routes/mcp.js, routes/timeline.js,
routes/auth.js, routes/user.js}`; local endpoint corpus (`FortniteEndpointsDocumentation`:
`CalderaService/`, `FN-Discovery-Service/`, `FN-Habanero-Service/`).

**Gameservers:**
- Project Reboot 3.0 README (S3–S15 supported; S1–S2 and S16–S19 imperfect; S20+ branch): https://github.com/Milxnor/Project-Reboot-3.0
- Reboot 3.0 map selection (`Asteria_Terrain` for ≥23): https://raw.githubusercontent.com/Milxnor/Project-Reboot-3.0/master/Project%20Reboot%203.0/dllmain.cpp
- Erbium (3.4–19.40 full; 1.7.2–3.3 and 20.00–30.00 partial): https://github.com/plooshi/Erbium
- 24.20 gameserver README (`net.AllowEncryption=0`): https://github.com/Twin1dev/24.20-Gameserver

**Backends:**
- LawinServerV2 README ("Parties (builds 3.5 to 14.50)"): https://github.com/Lawin0129/LawinServerV2
- LawinServer party stub: https://github.com/Lawin0129/LawinServer (`structure/party.js`)
- Reload Backend (README: tested on 27.11, Caldera Service): https://github.com/project-reload/reload-backend — `routes/party.js`, `routes/mcp.js` (12.20 / 19.01 / 3.5 rules), `routes/discovery.js`, `routes/matchmaking.js`, `routes/auth.js` (single-version gate), `routes/contentpages.js`, `CloudStorage/DefaultEngine.ini`, `CalderaService/calderaservice.js`
- Neodyme (`net.AllowEncryption=0` at season ≥23; `bForceBRMode` at ≥19.30; lobby stage naming): https://github.com/Aorux01/Neodyme — `src/manager/cloud-storage-manager.js`, `src/service/api/page-service.js`, `src/service/api/timeline-service.js`

**Redirect and launchers:**
- Starfall (ProcessRequest via string reference; EOS SDK module hook): https://github.com/plooshi/Starfall — `Starfall/request.cpp`, `Starfall/dllmain.cpp`, `Starfall/redirection.cpp`
- Tellurium (Starfall's successor): https://github.com/plooshi/Tellurium
- Reboot Launcher (CrashReportClient version read, CL → version table, static `-caldera`, Reboot DLL split at 20, `sinum.dll` default redirect): https://github.com/Auties00/Reboot-Launcher — `common/lib/src/game/game_metadata.dart`, `gui/lib/src/controller/dll_controller.dart`, `gui/dependencies/README.md`
- Kronos-CLI (EAC from 30.10): https://github.com/Helix-Dev-Q/Kronos-CLI
- Velocity-OGFN (EAC EOS shim for Ch4+ builds): https://github.com/forevershy/Velocity-OGFN
- fnbr.js (chat moved from XMPP to EOS Connect, commit 2024-08-02): https://github.com/fnbrjs/fnbr.js

**Release facts:**
- Zero Build, v20.00, 29 Mar 2022: https://inverse.com/gaming/fortnite-zero-build-mode-launch-update-trailer-gameplay · https://videogameschronicle.com/news/fortnite-has-officially-added-the-new-zero-build-mode
- Ranked, v24.40, 17 May 2023, Arena retired: https://www.gamespot.com/articles/fortnite-ranked-modes-for-battle-royale-and-zero-build-coming-in-24-40-patch/1100-6514123/ · https://www.dexerto.com/fortnite/fortnite-update-24-40-patch-notes-2145344/
- Chapter 4 on UE 5.1: https://www.unrealengine.com/en-US/blog/battle-testing-unreal-engine-5-1-s-new-features-on-fortnite-battle-royale-chapter-4
- UEFN / Creative 2.0, 22 Mar 2023: https://techbriefly.com/2023/03/23/how-to-get-fortnite-creative-2-0-map-codes-and-more
- Locker presets in v12.20: https://www.slashgear.com/fortnite-may-finally-get-locker-presets-heres-how-theyll-work-25611207 · https://www.inverse.com/gaming/fortnite-locker-presets-leak-data-miners-discover-in-demand-new-feature
- UE `net.AllowEncryption` behaviour: https://github.com/EpicGames/UnrealEngine (`Engine/Source/Runtime/Engine/Private/PendingNetGame.cpp`; access requires an Epic-linked GitHub account)
