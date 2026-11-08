# 03 — Game modes on 7.40 (2026-11-08)

Which Fortnite 7.40 game modes Nova can run, and what each one still needs, across the game server
(our Project Reboot fork), the backend (matchmaking, calendar, cloudstorage hotfix) and the launcher.

**Method.** This is read-only research; no game was run. The evidence comes from:

- the 7.40 pak index and the playlist assets inside it;
- the client and headless-server logs from today's sessions;
- `cobalt.log` (31 hosted matches);
- the shipped `DefaultGame.ini` baked into the pak;
- the Reboot fork, backend and launcher source;
- upstream Project Reboot 2.0 and 3.0;
- web sources for the S7 LTM history.

Grades follow the repo convention:

- **CONFIRMED**: seen in an artefact from this build.
- **STRONGLY SUPPORTED**: an artefact plus code reading, not yet seen working end to end.
- **INFERRED**: reasoning from code or design, no artefact.
- **UNVERIFIED**: a web claim or an untested assumption.

Effort sizes are **S** (under a day), **M** (1–3 days), **L** (more than 3 days or open research).
All of them assume a 7.40 build to test on.

---

## TL;DR

1. **Nova runs one mode today: Solo with one player.** All 31 hosted matches in `cobalt.log` logged
   `Setting playlist to: Playlist_DefaultSolo` (CONFIRMED). The playlist is a compile-time default in
   `definitions.h:132`, and the only runtime way to change it was Reboot's ImGui host menu, which Nova
   disabled (`dllmain.cpp:601`). The launcher hard-codes `PLAYLIST = "Playlist_DefaultSolo"`
   (`Launcher/src/useLauncher.ts:27`), and hosts register as serving `*`. So choosing Duos, 50v50 or
   Playground in the client puts the player on the same Solo server, and the server tells the client
   it is playing Solo.
2. **With two or more players, Solo is probably broken already: everyone lands on team 3.**
   - **Log evidence:** today's server log shows native `PickTeam` placing both controllers on team 3,
     in a Solo playlist whose `MaxTeamSize` is 1: `PickTeam for [JustADev], preferred: [0], actual: [3]`,
     then the same line for `JustADev*`, then `Team count is now [1]` (CONFIRMED).
   - **Code:** Nova has no PickTeam hook, and its own `Teams::AssignTeam` is commented out
     (`processevent.cpp:1909`).
   - **Consequence:** teammates cannot damage each other, so two "Solo" players cannot fight. The match
     ends only because the end check counts players, not teams (`processevent.cpp:987`). This finding is
     STRONGLY SUPPORTED; it needs a two-client test to confirm.
3. **The 7.40 build contains 124 playlists.** The pak index count equals the client's
   `Adding Playlist` count. They cover:
   - every S7 LTM, plus Driftin', Catch!, Love Shot, Sword Fight, NFL Rumble and Party at Pleasant Park;
   - Creative and both Playgrounds;
   - the 8.00-era Creative "Play Only" and Team Battle playlists;
   - an unreleased Gun Game.

   The full property table is in Appendix A. `VERSION_COMPATIBILITY.md` §"7.40 playlists — CONFIRMED"
   lists 16 names as the complete set. That is wrong: those are string literals from the executable,
   and two of them (`Playlist_FiftyFifty`, `Playlist_Deimos_SoloShow`) are not playlists in this build.
4. **LTMs are driven by data, not code.** Each playlist names gameplay modifiers, and each modifier
   names Blueprint mutator actors (`RespawnMutator`, `DiscoMutator`, `Mutator_Barrier`, …). The game
   registers these natively once the playlist is set. The server-side gaps are generic:
   - choosing the playlist;
   - team assignment;
   - team-aware match end;
   - respawn;
   - re-applying modifiers to every pawn;
   - two buses for large-team modes;
   - `MinPlayers`.

   Only Creative, AI modes (Ice Storm, Team Terror) and goal-score modes (Team Rumble, Disco, Food
   Fight, Score Royale) need mode-specific work.
5. **Recommended order:**
   1. the shared playlist pipeline plus a PickTeam hook (fixes multi-player Solo);
   2. Duos, Squads and Trios;
   3. loot-only LTMs and Playground;
   4. 50v50-type large-team modes;
   5. private matches;
   6. the respawn family, starting with Team Rumble;
   7. Creative last.

---

## Summary table

"In build?" means a playlist asset exists in the 7.40 paks **and** the client logs `Adding Playlist`
for it (CONFIRMED for every row). "Menu" means the build's own baked `FrontEndPlaylistData` shows the
mode with no hotfix.

| Mode (playlist) | In build? | Reboot fork today | Backend today | Missing | Effort |
|---|---|---|---|---|---|
| **Solo** (`Playlist_DefaultSolo`) | yes, in menu | Runs; the only playlist Nova has ever hosted. Native PickTeam puts everyone on team 3, so 2+ players are allies. | Routes it; bucket `…:playlist_defaultsolo` | PickTeam hook that spreads players (MaxSquadSize 1) | **S** |
| **Duos** (`Playlist_DefaultDuo`) | yes, in menu | Never set. Team code is dead; the end check is PlayersLeft ≤ 1, not teams. | Parses the playlist, but every host serves `*` and runs Solo. `partyPlayerIds` is dropped. | Playlist pipeline (P1), party-aware PickTeam (P2), TeamsLeft end (P3) | **M** |
| **Squads** (`Playlist_DefaultSquad`) | yes, in menu | as Duos | as Duos; client sends `player.option.fillTeam=true` | as Duos, plus fill vs no-fill | **S** after Duos |
| **Trios** (`Playlist_Trios`) | yes, not in menu (LTM from 31 Jan 2019) | as Duos | as Duos | as Duos, plus a FrontEndPlaylistData hotfix (P7) | **S** after Duos |
| **Playground** (`Playlist_Playground` 4p, `Playlist_Playground16` 16p) | yes, in menu | The `bIsPlayground` paths exist (infinite mats/ammo, no match end, skydive respawn, redeploy) but the flag is compile-time false. `Athena_Playground` is not streamed. | as Duos | P1; derive the flag from the playlist; stream AdditionalLevels (P5); re-apply modifiers on respawn (P8) | **S–M** |
| **Creative** (`Playlist_PlaygroundV2`) | yes, in menu | The version gate *passes* on 7.40, but `bIsCreative` is never set. Map travel uses the hub sub-level as the map. No portal or plot assignment, no island save. | Creative profile is a stub; island links echo the code | Reboot 3.0's Athena_Terrain + streaming + portal/plot flow; island persistence | **L** |
| Creative Team Battle / Play Only (`Creative_TDM_v1`, `Creative_PlayOnly`) | yes; TDM is in menu | none | none | the Creative infrastructure plus curated islands (an 8.00 feature that shipped dormant) | **L** (skip) |
| **50v50 family**: 50v50, Soaring 50s, HE 50s, Solid Gold 50s, Close Encounters 50s, Teams of 20, Teams of 33, Final Fight 12/20/50 | yes; 50v50 in menu | No large-team spreading, one bus (`AirCraftBehavior` not applied), MinPlayers 24–60 not overridden | as Duos | P1–P3, round-robin teams (`bIsLargeTeamGame`), P6 two buses, P9 MinPlayers | **M** (S after Squads) |
| **Team Rumble** (`Playlist_Respawn_24`), NFL Rumble (`Playlist_Omaha`) | yes; live in 7.40 (storm change) | The respawn hook is behind `if (false)` and gated on Playground. The death handler drops loot, decrements PlayersLeft and ends the match at ≤ 1. No goal score. | as Duos | P1–P3, P6, P9, a real respawn path (P4), and the MutatorControlledGoalScore win (100 eliminations) | **L** |
| **Disco Domination** (`Disco_32`, `_Alt`) | yes | as Team Rumble | as Duos | as Team Rumble, plus DiscoMutator capture behaviour verified | **L** |
| **Food Fight** (`Barrier`, `_12`, `_16`) | yes | as Team Rumble | as Duos | as Team Rumble, plus Mutator_Barrier and custom character parts | **L** |
| **Party at Pleasant Park** (`Music_*`) | yes (Showtime, 2 Feb 2019) | as Team Rumble | as Duos | as Team Rumble, plus the concert event | **L** (skip) |
| **Score Royale** (`Score_*`) | yes | Loot OK; win is FirstToGoalScore (coins) | as Duos | P1, plus a goal-score win | **M** |
| **Loot/settings LTMs** (solo/duo/squad each): Solid Gold, High Explosives, Fly Explosives, Sniper Shootout, Unvaulted (`Classic_*`, `Unvaulted_*`), Ground Game, Steady Storm, Blitz, Sword Fight, Catch! (`Toss_*`), Wild West, Siphon (`Vamp_*`), Close Encounters, Slide, Barebones (`Hard_*`), Sneaky Silencers, One Shot (`Low_*`), Love Shot, Infinite Blades, Final Five (`Playlist_Fortnite`) | yes | Loot already comes from the playlist's LootTierData/LootPackages. Modifier effects reach only the warmup pawn, not the bus-jump pawn. | as Duos | P1, P7, P8, plus P2/P3 for team variants; Sneaky needs P9 (MinPlayers 80) | **S** each after P1 |
| **Driftin'** (`Hover`, `_48`, `_64`) | yes | as 50v50 | as Duos | as 50v50, plus hover mutators | **M** |
| **Ice Storm** (`Deimos_*_Winter`), **Team Terror** (`Deimos_50`) | yes | No AI support (ai.cpp is a 25-line stub); `Deimos_Gameplay` level not streamed | as Duos | P5, AI spawning (`Mutator_AISupport`), fiend rifts | **L** |
| Gun Game (`Gungame_Solo`, `_Reverse`) | yes, unreleased | — | — | `Gungame_Solo`'s modifier asset is missing from the build (the server logs `Couldn't find file for package …GgAbilityModifier_Alt`) | skip |
| Tournaments (`Showdown_*`, `ShowdownAlt_*` incl. Trios) | yes (Pop-Up Cup / Share the Love playlists) | as Solo/Duos; MinPlayers 88–90 | events service absent | P9 for casual play; real scoring needs the events service | **S** casual / **L** scored |
| **Private/custom matches** | Client: `bCustomKeyEnabled=true` (baked), sends `player.option.customKey` | n/a | Ignores the key, so a keyed player joins the public server | key-scoped sessions + host election + host picks playlist | **M** |

P1–P9 are the shared work items described in [Shared work](#shared-work-what-unlocks-everything).

---

## Evidence: what is in the 7.40 build

### The playlist set — CONFIRMED

- **Pak index.** `tools/paklist.mjs` over the 15 primary-key paks of
  `Downloads\7.40-CL-5046157\Fortnite\FortniteGame\Content\Paks` finds **124** `Playlist_*.uasset`
  files. Five `pakchunk1000+` paks use secondary keys and were skipped.
- **Client log.** The client log (`FortniteGame.log`, build `++Fortnite+Release-7.40-CL-5046157`)
  prints **124** `FortPlaylistManager::IntializePlaylists() Adding Playlist: …` lines, matching the
  pak count. The headless-server log (`FortniteGame_2.log`) prints the same set.
- **Names vs files.** The bucket/playlist **name** (the `PlaylistName` property, which matchmaking
  and the menu use) is not always the asset file name. Reboot finds the object by path, so this
  matters:

| PlaylistName (bucket id) | asset |
|---|---|
| `Playlist_Deimos_50` | `/Game/Athena/Playlists/Deimos/Playlist_Deimos_50v50` |
| `Playlist_Hover`, `_48`, `_64` | `/Game/Athena/Playlists/50v50/Hover/Playlist_50v50_Hover[_48/_64]` |
| `Playlist_Vamp_Duo` / `_Squad` | `…/Vamp/Playlist_Vamp_Duos` / `_Squads` |
| `Playlist_WW_Duos` / `_Squads` | `…/WW/Playlist_WW_Duo` / `_Squad` |
| `Playlist_Close_Squad` | `…/Shotguns/Playlist_Close_Squads` |
| `Playlist_Blitz_Squad` | `…/Blitz/Playlist_Blitz_Squads` |
| `Playlist_Snipers` | `…/Snipers/Playlist_Snipers_Squads` |
| `Playlist_Gungame_Solo` / `_Reverse` | `…/gg/Playlist_Gg_Solo_Alt` / `Playlist_Gg_Reverse` |

The client sends the name **lower-cased** in the bucket: `4774386:0:NAE:playlist_defaultsolo`
(client log, `UFortMatchmakingV2::StartMatchmaking`).

### Playlist properties — CONFIRMED (parsed from the cooked assets)

A scratch extractor (AES-256-ECB, zlib blocks, then UE 4.22 unversioned tagged-property parse) read
every playlist export. The decisive fields:

| playlist | players (min) | teams × size | win condition | respawn | bus | mutators (via modifiers) |
|---|---|---|---|---|---|---|
| DefaultSolo / Duo / Squad | 100 | 100×1 / 100×2 / 100×4 | (default) | — | default | ResourceCap only |
| Trios | 100 | 100×3 | (default) | — | default | — |
| Playground | **4** (1) | 4×4, team switching | LastManStandingIncludingAllies | InfiniteRespawnExceptStorm | default | Playground user-knob mutators (health, gravity, fall damage, time of day, respawn location, …), `CreativeMutator_POIOverride`; extra level `Athena_Playground` |
| Playground16 | 16 (1) | 16×16 | same | same | default | same |
| PlaygroundV2 (Creative) | 16 (1), join-in-progress | 16×16 | LastManStandingIncludingAllies | InfiniteRespawnExceptStorm | **skip aircraft, skip warmup** | `CreativeMutator_SpawnStarterIsland`, `Mutator_AISupport`; levels `Athena_Playground`, `PG_Island_GroupMaster`, `PG_CreativeHub_03`; `bEnableCreativeMode` |
| Respawn_24 (Team Rumble) | 40 (**24**) | 2×20, large team | **MutatorControlledGoalScore** | via `RespawnMutator` (RespawnTime/RespawnHeight set) | **OpposingAirCraftForEachTeam** | `RespawnMutator`, `GenericDontDropInventoryMutator`, `GenericItemsToDropOnDeathMutator`, big-team glider; DBNO `NotWhenRespawning`; storm stops at phase 3 |
| 50v50 | 100 (24) | 2×50, large team | (default) | — | OpposingAirCraftForEachTeam | big-team glider |
| Disco_32 | 64 (24) | 2×32 | MutatorControlledGoalScore, Domination UI | via mutator | two buses | `DiscoMutator` + don't-drop mutators |
| Barrier (Food Fight) | 48 (16) | 2×24 | MutatorControlled | via mutator | two buses | `Mutator_Barrier` + don't-drop mutators |
| Score_* | 100 | 100×n | FirstToGoalScore (+ ScoringData) | — | default | `AthenaMutator_Score`, coin spawn list |
| Close_* | 100 | 100×n | — | — | default | `Mutator_InventoryOverride_Close` |
| Low_* / Love_* (One/Love Shot) | 100 | 100×n | — | — | default | gameplay effects + `Mutator_Low`, `Mutator_AllowADS`; DBNO off |
| Deimos_*_Winter (Ice Storm) | 100 | 100×n | — / TimedLastMenStanding (CN) | — | default | `Mutator_AISupport` + Deimos missions/rift/difficulty; level `Deimos_Gameplay` |

The full 124-row table is Appendix A.

### What the client's menu shows — CONFIRMED

The shipped `FortniteGame/Config/DefaultGame.ini` (extracted from pakchunk0) has, under
`[/Script/FortniteGame.FortGameInstance]`:

```
!FrontEndPlaylistData=ClearArray
+FrontEndPlaylistData=(PlaylistName=Playlist_DefaultDuo,  …bEnabled=true, bIsDefaultPlaylist=true…)
+FrontEndPlaylistData=(PlaylistName=Playlist_DefaultSquad, …)
+FrontEndPlaylistData=(PlaylistName=Playlist_DefaultSolo,  …)
+FrontEndPlaylistData=(PlaylistName=Playlist_50v50,        …bIsDefaultPlaylist=true…)
+FrontEndPlaylistData=(PlaylistName=Playlist_Playground,   …bDisplayAsLimitedTime=true…)
+FrontEndPlaylistData=(PlaylistName=Playlist_PlaygroundV2, …bDisplayAsNew=true…)
+FrontEndPlaylistData=(PlaylistName=Playlist_Creative_TDM_v1, …)
```

Nova's cloudstorage hotfix (`Main backend/data/cloudstorage/DefaultGame.ini:21`) has the same
section but sets only `bBattleRoyaleMatchmakingEnabled`. So players see exactly those seven tiles
today, and **every one except Solo silently plays Solo**. The hotfix mechanism is how
Lawin/Reload-style backends turn LTMs on (`backends/_extracted/LawinServer-main/CloudStorage/DefaultGame.ini:18-24`).

The client log line `PLAYLIST: Serving ALL available playlists given to client from MCP!` shows no
MCP-side filtering.

**The timeline's S7 LTM flags do not turn playlists on (INFERRED).**
`social.routes.ts:595` adds `EventFlag.LTM_14DaysOfFortnite`, `EventFlag.LTM_WinterDeimos` and
similar flags, and its comment claims they "light up the LTM tiles". None of these strings exists in
the 7.40 exe or its config INIs. The INI notes say `bForcePlaylistOff` is "never calendar", which
implies the calendar *can* carry playlist access, but nothing shows Nova's flags doing so. Treat the
comment as unproven. **Use the hotfix.**

### Private-match plumbing in the client — CONFIRMED (binary + config), behaviour UNVERIFIED

- **Config:** `[/Script/FortniteGame.FortMatchmakingV2] bCustomKeyEnabled=true` in the baked ini.
- **Binary strings:** `player.option.customKey` (UTF-16 ×2), `SetCustomMatchmakingKey`,
  `IsCustomMatchmakingKeyEnabled`, `InvalidCustomMatchKey`, `CustomMatchKeyNotSupported`.

The key travels on the ticket request. Web sources say the key does not select a playlist; the
playlist is still the bucket's (see Sources). Hosting rights were granted by Epic per account.

### S7 LTM history (web) — UNVERIFIED except where the build confirms it

Per fandom update pages (read through the wiki API by a sub-agent; the pages now return HTTP 402 to
direct fetches) and press coverage:

- **v7.00 (6 Dec 2018):** Creative for Battle Pass owners. It opened to everyone on 13 Dec (v7.01).
- **v7.01:** Close Encounters returned.
- **v7.10 (18 Dec):** "14 Days of Fortnite", one or two LTMs a day, 19 Dec – 2 Jan:
  - Teams of 33, Unvaulted, Siphon;
  - Team Terror, Barebones, Slide;
  - Disco Domination, Sniper Shootout;
  - Solid Gold, Team Rumble, Score Royale;
  - Food Fight, Ground Game, Sneaky Silencers;
  - Wild West, Close Encounters, Steady Storm;
  - High Explosives, One Shot.
- **v7.20 (15 Jan 2019):** One Shot; Ice Storm on 19 Jan; Sniper Shootout on 22 Jan.
- **v7.30 (29 Jan):** Trios on 31 Jan; NFL Rumble (about 1–3 Feb); Marshmello "Showtime" on 2 Feb;
  Wild West Duos on 5 Feb.
- **v7.40 (14 Feb):**
  - Team Rumble storm change; Catch! (confirmed by the patch-note summary at fortnitenews.com);
  - Pop-Up Cup settings applied to the default playlists;
  - Share the Love tournaments (14–24 Feb) and the Trios One Day Cup (17 Feb);
  - Sword Fight (about 15 Feb); Driftin' (19 Feb, pulled 20 Feb).

All of those playlists are present in this build (CONFIRMED by the pak index), including Driftin'
and Catch!. So CL-5046157 contains the late-February content whatever its date.

**Not in 7.40 (absent from the pak index):** Floor Is Lava (v8.20), Air Royale (April 2019), Arena
as a mode (v8.20; the `ShowdownAlt_*` assets exist but are tournament playlists here), Heavy Metal,
Battle Lab (v11.31), High Stakes / Getaway (v5.x / S8), Infinity Gauntlet (v4.x).

The sub-agent bracketed this with two real client logs, 7.10 (88 playlists) and 8.00 (121), from
EZFNDEV/FortLogReader. 7.40's 124 is consistent with that.

---

## Cross-cutting findings in the Reboot fork

All paths are under `Project-Reboot-DLL/Project Reboot/`.

### 1. The playlist is fixed at Solo

- **Hard-coded default.** `definitions.h:132` initialises `Defines::Playlist` from `bIsCreative`
  and `bIsPlayground`, both `inline … = false` (`:22`, `:24`). Static initialisation therefore always
  yields `Playlist_DefaultSolo`.
- **No runtime switch.** Upstream Reboot 2.0 changes the playlist from its ImGui pregame menu
  (`gui.h:1243-1276`: a "Playlist" text box and a "Playground" checkbox; there was never a Creative
  checkbox). Nova commented out `CreateThread(0, 0, GuiThread…)` (`dllmain.cpp:601`) to remove the
  cheat menu, and that also removed every runtime mode switch. Upstream still has the call
  (github.com/Milxnor/Project-Reboot, `Project Reboot/dllmain.cpp`).
- **How it is applied.** `ReadyToStartMatch` (`processevent.cpp:556-625`) finds the playlist with
  `FindObjectSlow` (substring match over GObjects; all 124 are resident after
  `IntializePlaylists`). It writes it into `CurrentPlaylistInfo.BasePlaylist`, bumps the replication
  key and fires `OnRep_CurrentPlaylistInfo`. The server log then shows
  `Registering Playlist GameplayModifier (ResourceCapModifier_DefaultSolos) in AFortGameStateAthena::UpdatePlaylistDependentData()`,
  so **native modifier and mutator registration runs off this** (CONFIRMED for Solo).
- **Compared with Reboot 3.0:** Nova does not set `OverridePlaylist`, does not stream
  `AdditionalLevels`, does not copy `AirCraftBehavior`, and forces `GameSession.MaxPlayers = 100`
  (`:638`).

### 2. Team assignment is native, and native puts everyone on one team

- **No team code runs.** `Teams::AssignTeam` (`teams.cpp`) is only called from a commented-out block
  in `ServerLoadingScreenDropped` (`processevent.cpp:1909`), and there is no PickTeam hook. It would
  also be the wrong place: native `PlacePlayerOnTeam` has already run at login. Re-assigning later
  leaves the player in team 3's `TeamMembers`. It also starts at index 4 (`team.h:7`) while 7.40's
  first team is 3.
- **Server log, `FortniteGame_2.log`, today (CONFIRMED):**
  ```
  LogFortTeams: PickTeam for [JustADev], preferred: [0], actual: [3]
  LogFortTeams: PickTeam for [JustADev*], preferred: [0], actual: [3]
  LogFort: … added to alive players list (Team [0]).  Player count is now [1].  Team count is now [1].
  ```
  `preferred: [0]` means no matchmaking reservation supplied a team. Nova patches the reservation
  check away (`dllmain.cpp:512`, `jg → je`), and the backend sends no team data. With no preference,
  native PickTeam reused team 3 even though `MaxTeamSize` is 1.
- **Fix route.** Reboot 3.0 replaces PickTeam entirely: `Athena_PickTeamHook`
  ([FortGameModeAthena.cpp#L1058](https://github.com/Milxnor/Project-Reboot-3.0/blob/98f74cea/Project%20Reboot%203.0/FortGameModeAthena.cpp#L1058)),
  found through the string `PickTeam for [%s] used beacon value [%d]`
  ([finder.h#L1613](https://github.com/Milxnor/Project-Reboot-3.0/blob/98f74cea/Project%20Reboot%203.0/finder.h#L1613)).
  That string **is present in the 7.40 exe** (UTF-16 ×1), next to the `preferred: [%d], actual: [%d]`
  string the log shows. It fills teams to `MaxSquadSize` in join order, or round-robins across
  `MaxTeamCount` when `bIsLargeTeamGame`. It ignores parties.

### 3. The match ends on players, not teams

`processevent.cpp:987` ends the match when `PlayersLeft <= 1`. The `TeamsLeft` check sits commented
out on the line above it.

The TeamsLeft bookkeeping (`:891-940`) depends on `PlayerTeam.TeamMembers` and `bMarkedAlive`. That
is only meaningful once teams are real. In Duos it would keep the last two teammates fighting a storm
they cannot win. In 50v50 the match would only end when one player remained.

### 4. The respawn path is dead code

- **Hook never installed.** `ServerClientIsReadyToRespawn` is implemented (`processevent.cpp:1999`),
  but its `AddHook` sits inside `if (false)` (`dllmain.cpp:679`). The handler also refuses to work
  unless `bIsPlayground || bIsCreative` (`:2003`).
- **What the death handler does instead.** Respawn happens only in the death handler, and only for
  `bIsPlayground`: `SpawnPawn` at the death location, then `TeleportToSkyDive(15000)`
  (`processevent.cpp:1273, 1325`). The same `else` branch also fires for a **non-Playground death
  with no pawn**, which respawns a logged-out player at the origin. That is a latent bug.
- **What the handler always does:** removes the player from the alive count, decrements PlayersLeft
  and drops the inventory. Respawn modes need none of that.
- **Templates:** MoonGS 7.30 respawns server-side, the same way, then calls
  `RespawnPlayerAfterDeath` and the cheat manager's `RespawnPlayer`
  (`MoonGS (7.30)/Old-MoonGS-main/FortniteGame/Abilities/PlayerManager.h:214-240`). Reboot 3.0
  instead gates the drop and alive-removal on `IsRespawningAllowed` and leaves the respawn itself to
  the game ([FortPlayerController.cpp#L1470](https://github.com/Milxnor/Project-Reboot-3.0/blob/98f74cea/Project%20Reboot%203.0/FortPlayerController.cpp#L1470)).
  Whether 7.40's own code completes a respawn unaided is **UNKNOWN**.

### 5. Modifier effects reach the warmup pawn only

`ServerReadyToStartMatch` applies each playlist modifier's `PersistentGameplayEffects` and
`PersistentAbilitySets` to the first pawn (`processevent.cpp:328-…`). `ServerAttemptAircraftJump`
then **spawns a new pawn** (`:1423`) and re-grants only `GAS_DefaultPlayer`. Every effect-based LTM
loses its rules at the bus jump:

- One Shot and Love Shot effects;
- Slide and Infinite Blades ability sets;
- Driftin' and Disco ability sets.

The same applies to respawned pawns. Reboot 3.0 applies modifiers on **every** spawn
(`ApplyModifiersToActor`, `GameModeBase.cpp:157`).

`bWipeInventoryOnAircraft = true` also clears anything a mutator handed out during warmup.

### 6. Loot, storm and bus

- **Loot: already per-playlist (STRONGLY SUPPORTED).** `Looting::Initialize` runs in
  `ReadyToStartMatch` *after* the playlist is set. It reads the playlist's `LootTierData` and
  `LootPackages` (`loot.cpp:115, 318`) and falls back to the default tables. So Solid Gold, Unvaulted,
  Close Encounters, Snipers and High Explosives need no loot code. The init-once guard is harmless
  because dedicated mode terminates and relaunches per match.
- **Storm: native.** It comes from the playlist's `GameData` composite table and `LastSafeZoneIndex`.
  `zone.cpp` only acts when `bIsLateGame`, which is false, so nothing overrides it. Team Rumble's
  storm stops at phase 3 (LSZ3), natively.
- **Bus: always one.** `AirCraftBehavior` (`OpposingAirCraftForEachTeam` on 22 of the 28 large-team playlists)
  is never copied to the game state. Reboot 3.0 copies it
  ([FortGameModeAthena.cpp#L645](https://github.com/Milxnor/Project-Reboot-3.0/blob/98f74cea/Project%20Reboot%203.0/FortGameModeAthena.cpp#L645)).
- **`MinPlayers`.** The playlist value is 24 for Team Rumble and the 50v50 family, 60 for Teams of
  20, 80 for Sneaky Silencers and 88–90 for tournaments. The override that would set it to 1 is
  commented out (`processevent.cpp:652`). Nova cancels native `ReadyToStartMatch` and pins the warmup
  timer, so this may not block a start. That is **UNVERIFIED** for playlists with `MinPlayers > 1`.
  Solo has none.

### 7. Creative: why the "doesn't have creative" message exists

The message in `dllmain.cpp:584` is the `else` of `if (Fortnite_Season >= 7 && Engine_Version < 424)`
(`:548`). It means "this build predates Creative (before S7), or it is UE 4.24+ (C2S1+), where Creative
moved to `Creative_NoApollo_Terrain`, which Reboot 2.0 doesn't handle". **7.40 passes the gate:**
`cobalt.log` shows `Fortnite_Season: 7` and `Engine Version 4.22.0`. **The message never prints on
Nova.** It cannot print at all, because the branch only runs when `bIsCreative` is true, and nothing
sets it.

If the flag is enabled by hand, Nova's fork does the following:

- **Map:** travels to the playlist's **last** `AdditionalLevel`, `PG_CreativeHub_03`, *as the
  persistent map* (`dllmain.cpp:556-578`, identical upstream).
- **Starting items and portal:** grants `WID_CreativeTool` and loads `BGA_IslandPortal`
  (`processevent.cpp:271, 678`).
- **Spawns:** picks `FortPlayerStartCreative` starts (`helper.cpp:1770`).
- **Item hook:** accepts `ServerGiveCreativeItem` (`processevent.cpp:1855`, hooked at `dllmain.cpp:705`).

It has **no portal/plot ownership, no island loading and no minigame handling.**

Reboot 3.0's 7.40-eligible path is different (gated on `Engine_Version >= 422 && < 424`,
[gui.h#L1410](https://github.com/Milxnor/Project-Reboot-3.0/blob/98f74cea/Project%20Reboot%203.0/gui.h#L1410)):

- opens `Athena_Terrain`;
- streams all of the playlist's `AdditionalLevels` ([#L533](https://github.com/Milxnor/Project-Reboot-3.0/blob/98f74cea/Project%20Reboot%203.0/FortGameModeAthena.cpp#L533));
- for each joining player, claims a free portal from `CreativePortalManager.AvailablePortals`, links
  the player's plot and loads `PID_Playset_60x60_Composed` ([#L1586](https://github.com/Milxnor/Project-Reboot-3.0/blob/98f74cea/Project%20Reboot%203.0/FortGameModeAthena.cpp#L1586)).

It does not save islands either.

---

## Cross-cutting findings in the backend and launcher

- **Bucket parsing works.** `matchmaking.routes.ts:933-935` splits `bucketId`, takes the region from
  part 2 and the playlist from part 3. The client sends a lower-cased name, so `NUMERIC_PLAYLISTS`
  (`:881`) never matters for 7.40. Its `Playlist_Fill_Squads` doesn't exist in this build.
- **Routing ignores the playlist in practice.** `resolveGameServer` does match playlists
  case-insensitively. But launchers register with the coordinator as `playlist: "*"`
  (`Launcher/src-tauri/src/host.rs:205, 233`). The local agent registers the launcher's constant
  (`hostRunner.ts:203` ← `useLauncher.ts:742`). Every ticket therefore lands on the one
  Solo-configured server.
- **No party awareness.** The ticket payload hard-codes `partyPlayerIds: [accountId]` and a random
  `player.option.partyId` (`:977-979`). The client's own `partyPlayerIds` query parameter is ignored.
  Party V1 runs over XMPP on this build, and the backend relays it. Whether party members are carried
  into the leader's session on 7.40 is **UNKNOWN**: no two-client party session has been logged.
  Today it barely matters, since everyone is on one server and one team.
- **The host doesn't know which playlist is wanted.** The MMS websocket records demand with no
  playlist (`xmpp.server.ts:700`, `matchmakingStarted()`). `should-i-host` is called with the
  launcher's constant. So there is no channel telling the elected host *which* playlist to run.
  There is, however, a ready-made way to hand the gameserver a value: `hostRunner` spawns the
  headless client with `spec.env` (`hostRunner.ts:261-267`), and an injected DLL inherits that
  environment.
- **The calendar marks LTM flags, which don't enable playlists** (see above).
- **The content page is decoration only.** `playlistinformation` (`social.routes.ts:539`) lists five
  playlists. It supplies tile art and text and enables nothing.
- **Session attributes echo the requested playlist.** `PLAYLISTNAME_s` (`:1543`) returns whatever the
  player asked for, so it can disagree with what the server runs. That is harmless today, but should
  agree once playlists are real.
- **Creative backend is stubbed.** The `creative` MCP profile is a stub (`QueryProfile.ts`), island
  codes echo (`compat.routes.ts:79-104`), and Creative MCP operations fall to empty success
  (KNOWN_ISSUES). That is enough to enter the mode, not enough to own or save an island.

---

## Shared work (what unlocks everything)

| # | Item | Where | Effort |
|---|---|---|---|
| P1 | **Playlist pipeline.** The ticket handler remembers the requested playlist per waiter. Host election becomes per playlist and returns it. The launcher/agent passes it to the gameserver (`NOVA_PLAYLIST` in `spec.env`, or a command-line option). Reboot reads it before `ReadyToStartMatch` and maps the name to the asset path (table in Appendix A; 9 names differ). Register the server under that playlist, not `*`. | backend matchmaking + xmpp MMS, `hostRunner.ts`, `useLauncher.ts`, `definitions.h`, `processevent.cpp:556` | M |
| P2 | **PickTeam hook.** Port Reboot 3.0's `Athena_PickTeamHook`, starting at team 3, MaxSquadSize fill, round-robin for `bIsLargeTeamGame`. Then make it **party-aware**: the backend keeps `partyPlayerIds` from the leader's ticket and exposes account → party; Reboot looks it up when PickTeam runs (it already has a WinHTTP bridge to the agent for the locker). | `processevent.cpp`/new hook, backend | M |
| P3 | **Team-aware match end.** End on `TeamsLeft <= 1` for team playlists. Notify the whole winning team. Set `Place` per team. | `processevent.cpp:891-1040` | S |
| P4 | **Respawn.** Gate on the playlist (`RespawnType`, or the presence of `FortAthenaMutator_Respawn`). Skip the drop, alive-removal and PlayersLeft decrement. Either enable `ServerClientIsReadyToRespawn` (remove the `if (false)` and the Playground gate) or respawn server-side like MoonGS, then re-apply abilities and modifiers. | `dllmain.cpp:679`, `processevent.cpp:1273-1335, 1999-2022` | M |
| P5 | Stream the playlist's `AdditionalLevels` for every playlist, not only Creative (`Athena_Playground`, `Deimos_Gameplay`, …). | `processevent.cpp` ReadyToStartMatch | S |
| P6 | Copy `AirCraftBehavior` (two buses) and honour `bSkipAircraft`/`bSkipWarmup`. | same | S |
| P7 | **FrontEndPlaylistData hotfix** in `data/cloudstorage/DefaultGame.ini` under `[/Script/FortniteGame.FortGameInstance]`, listing exactly the playlists the servers can run. Ideally generated from a server-side "supported modes" list so the menu never offers a mode that silently plays Solo. | backend | S |
| P8 | Apply playlist modifiers on **every** pawn spawn (bus jump, respawn), not only the warmup pawn. Revisit `bWipeInventoryOnAircraft` for mutator-granted items. | `processevent.cpp:328, 1421-1423` | S |
| P9 | Set `MinPlayers` to 1, or verify that warmup proceeds without it. Set `GameSession.MaxPlayers` from the playlist (it is 4 for Playground). | `processevent.cpp:638, 652` | S |

---

## Per mode

### Solo — `Playlist_DefaultSolo`

- **Build:** yes; in the menu by default; bucket `playlist_defaultsolo`.
- **Reboot:** the only playlist ever hosted (31/31 matches in `cobalt.log`). One player works end to
  end: the memory and release notes record looting, vehicles, storm death, Victory Royale and the
  restart. **Two or more players:** native PickTeam puts all of them on team 3 (log above), so they
  are allies. The match still ends on PlayersLeft, which is why it "works".
- **Backend:** fine.
- **Missing:** P2 without party logic (MaxSquadSize 1 means one per team). Effort **S**. Do this first:
  it fixes the mode Nova already ships.

### Duos / Squads / Trios — `Playlist_DefaultDuo`, `Playlist_DefaultSquad`, `Playlist_Trios`

- **Build:** all three yes. Duo and Squad are in the menu; Trios ran as an LTM from 31 Jan 2019 and
  needs P7.
- **Reboot:** nothing team-related runs. The end condition is wrong for teams (P3). DBNO and revive
  are native, with revive in `interaction.cpp:316`; unverified in multiplayer.
- **Backend:** routes to the Solo server; the party is dropped.
- **Missing:** P1 + P2 (party-aware) + P3 + P7. Squad fill: the client sends
  `player.option.fillTeam=true`; P2 should fill partial parties up to MaxSquadSize when it is true and
  leave them alone when false. Effort **M** for the first, **S** for each after.

### Playground — `Playlist_Playground` (4 players), `Playlist_Playground16`

- **Build:** both yes; Playground is in the menu as limited-time. S7 kept the old Playground next to
  Creative. The v7.10 and v7.30 patch notes changed it (UNVERIFIED web), and v8.00 rebuilt it on
  Creative islands (`Creative_PlayOnly`).
- **Reboot:** the most complete mode after Solo, but unreachable. These exist:
  - infinite materials and ammo (`build.cpp:159`, `inventory.cpp:1205`);
  - no PlayersLeft decrement and no match end (`:893`, `:987`);
  - skydive respawn at the death spot (`:1325`);
  - glider redeploy (`:680`).

  It still needs:
  - **Flag from the playlist:** `bIsPlayground` must be derived at runtime from the chosen playlist,
    because `Defines::Playlist` reads the flag only at static init.
  - **AdditionalLevels:** `Athena_Playground` is never streamed (P5). It probably carries the lobby
    island and dock that `ServerTeleportToPlaygroundLobbyIsland`/`IslandDock` (both in the exe)
    target. INFERRED.
  - **Modifiers on respawned pawns** (P8). The user-knob mutators (gravity, health, fall damage, time
    of day, respawn location) are Blueprint actors registered natively; whether their UI works is
    UNVERIFIED.
  - **Session size:** `GameSession.MaxPlayers` is forced to 100; the playlist says 4 or 16.
- **Teams:** native team 3 for everyone is actually acceptable here, since the mode is "your party
  alone" with team switching allowed.
- **Backend:** P1, P7.
- **Effort:** **S–M** after P1. This is the closest non-Solo mode.

### Creative — `Playlist_PlaygroundV2`

- **Build:** yes; in the menu, marked "new". It needs `bEnableCreativeMode`, skips warmup and the
  bus, and allows join-in-progress. Levels: `Athena_Playground`, `PG_Island_GroupMaster`,
  `PG_CreativeHub_03`.
- **Reboot:** see §7 above. The version gate is not the blocker; the work is:
  - **Map and flag:** `bIsCreative` set from the playlist; travel to `Athena_Terrain` and stream the
    three levels (Reboot 3.0's approach) instead of opening the hub as the map.
  - **Islands:** per-player portal/plot assignment from `CreativePortalManager`, playset load, and
    the portal teleport hooks.
  - **Respawn:** `InfiniteRespawnExceptStorm` (P4).
  - **AI:** `Mutator_AISupport` is in the modifier list (AI-placed devices; can be left inert).
- **Backend:** an island-persistence design. The plots live in the `creative` MCP profile; today
  that is a stub, and the related operations return empty success. Without it, islands reset every
  session.
- **Effort:** **L.** Do it last. Upstream 3.0 covers server-side island loading only.

### Large-team modes — 50v50, Soaring 50s, HE 50s, Solid Gold 50s, Close Encounters 50s, Teams of 20, Teams of 33, Final Fight

- **Build:** all yes. 50v50 is in the menu as a default playlist.
- **Reboot:** needs P2 round-robin (`bIsLargeTeamGame`, `MaxTeamCount` 2, 3, 5 or 8), P3, P6 (two
  buses) and P9 (MinPlayers 24–60). Final Fight uses `TimedTeamFinalFight` and storm phase 3: after a
  timer the storm stops and the team with most survivors wins. Whether the game handles that once
  teams are right is UNVERIFIED.
- **Backend:** P1, P7. Parties stay together within a side (P2).
- **Effort:** **M**, or **S** once Squads works.

### Team Rumble — `Playlist_Respawn_24` (and NFL Rumble `Playlist_Omaha`)

- **Build:** yes. It was live in 7.40, and the 7.40 notes changed its storm.
- **Rules (from the asset):**
  - 40 players, 2 × 20, `MinPlayers` 24, two buses;
  - `RespawnTime`/`RespawnHeight` set, DBNO off while respawning, storm stops at phase 3;
  - `WinConditionType = MutatorControlledGoalScore`; the UI text says the first team to 100
    eliminations wins.
- **Mutators:** `RespawnMutator`, `GenericDontDropInventoryMutator`, `GenericItemsToDropOnDeathMutator`.
- **Reboot today:** nothing works for it. Respawn is dead code (`if (false)`) and keyed on
  Playground. The death handler drops all loot and ends the match at one player left.
- **Needs:** P1–P4, P6, P8, P9, and a goal-score win. Count team eliminations (`TeamKillScore`) and
  end at the target.
  - Reboot 3.0 never implemented score wins: `FWinConditionScoreData` is declared, never used.
  - The `RespawnMutator` Blueprint may drive the goal itself through `FortAthenaMutator_Respawn`,
    which is in the exe. UNKNOWN until observed.
- **Effort:** **L**. That is mostly the cost of discovering how much the mutator does natively. NFL
  Rumble adds `Mutator_Omaha`.

### Disco Domination, Food Fight, Party at Pleasant Park

These are the same respawn and goal-score base as Team Rumble, plus one mode-specific mutator each:

- `DiscoMutator`: capture dance floors.
- `Mutator_Barrier`: the Food Fight barrier and its heist-style objectives, plus custom character
  parts.
- `MusicMutator`: Pleasant Park plus the concert.

Reboot 3.0's Disco and Barrier hooks only log and pass through, so the Blueprints are expected to run
natively. **L** each after Team Rumble. Skip Pleasant Park unless the event is wanted.

### Score Royale — `Playlist_Score_*`

- **Rules:** `FirstToGoalScore` with `ScoringData`; coins are spawned from `SpawnActorInfoList`;
  storm stops at phase 5.
- **Needs:** P1, plus spawning the `SpawnActorInfoList` actors if the game doesn't (UNVERIFIED), plus
  the goal-score end. **M**.

### Loot/settings LTMs (solo/duo/squad variants each)

Solid Gold, High Explosives, Fly Explosives, Sniper Shootout, Unvaulted (`Classic_*` and
`Unvaulted_*`), Ground Game, Steady Storm, Blitz, Sword Fight, Catch!, Wild West, Siphon, Slide,
Barebones, Sneaky Silencers, Close Encounters, One Shot, Love Shot, Infinite Blades, Final Five.

- **Loot:** these change loot tables (already honoured), storm GameData (native), or gameplay
  effects through modifiers (needs P8).
- **Starting loadouts:** a few use inventory-override mutators: Close Encounters, Infinite Blades,
  Slide. Reboot 3.0 hands these out itself (`AddInventoryOverrideTeamLoadouts`), which suggests the
  game does not under a Reboot server (INFERRED). Port that if loadouts are missing.
- **Siphon:** the `Vamp_*` playlists carry no modifier. How 7.40 siphon is driven is UNKNOWN (Reboot
  3.0 fakes it with a GUI value).
- **Sneaky Silencers:** `MinPlayers` 80 (P9).
- **Effort:** **S** each after P1, P7, P8; team variants also need P2/P3.

### Driftin' — `Playlist_Hover*`

Large-team mode (2×24/32/40) with hover-board mutators. **M** after 50v50.

### Ice Storm and Team Terror — `Playlist_Deimos_*`

They need the `Deimos_Gameplay` level (P5) and AI fiends spawned by `Mutator_AISupport`, rifts and
missions. Nova has no AI support: `ai.cpp` is a 25-line stub, and its only hook is commented out
(`dllmain.cpp:772`). **L**.

### Gun Game — `Playlist_Gungame_*`

An unreleased test mode. `Gungame_Solo` references `GgAbilityModifier_Alt`, which the build does not
contain; both logs print `Couldn't find file for package …`. **Skip.**

### Tournament playlists — `Showdown*`, `ShowdownAlt*` (incl. Trios)

The Pop-Up Cup and Share the Love playlists. They can be played casually as normal playlists with
P9 (MinPlayers 88–90). Real scoring and placement needs the events service, which is absent.
**S** casual, **L** scored.

### Private/custom matches

- **Client:** custom keys are enabled in the baked config, and the key goes on the ticket as
  `player.option.customKey`.
- **Backend:** ignores the key, so everyone with a key joins the public server.
- **Needs:**
  - read `player.option.customKey`;
  - key sessions and host election on `(key, playlist)`;
  - let the first keyed player's launcher host with the playlist they picked (P1);
  - never route keyless players there.

  An optional extra is a launcher field to set the key and playlist.
- **Effort:** **M**, after P1.

---

## Upstream comparison

| Capability | Nova fork (Reboot 2.0) | Upstream Reboot 2.0 (github.com/Milxnor/Project-Reboot) | Reboot 3.0 @ `98f74cea` (github.com/Milxnor/Project-Reboot-3.0) |
|---|---|---|---|
| Choose playlist at runtime | none (GUI removed) | ImGui text box, Playground checkbox | ImGui text box, Creative checkbox (UE 4.22–4.23), event playlists |
| Apply playlist | BasePlaylist + OnRep | same | Base **and** Override, key bump, `SetCurrentPlaylistName`, streams AdditionalLevels |
| Team assignment | native (all on team 3) | `AssignTeam` exists, unused | `Athena_PickTeamHook`: fill to MaxSquadSize / round-robin large teams; no parties |
| Two buses | no | no | copies `AirCraftBehavior` |
| Respawn | Playground-only skydive in death handler; client hook disabled | same | `IsRespawningAllowed` gate; leaves the respawn to the game below UE 4.24 |
| Score/goal win | no | no | no (struct declared, unused) |
| Modifiers | warmup pawn only | same | every spawn; `InventoryOverride` loadouts; GiveItemsAtGamePhaseStep |
| Creative | hub-as-map, no portals | same | Athena_Terrain + streaming + portal/plot + playset |
| Lategame | code present, off | GUI | GUI (zone forcing on 7.40) |

Reboot 3.0 line references were checked against the local copy
(`backends/Fortnite-GS-Archive-release3/Project Reboot V3/Project-Reboot-3.0-latest`, which matches
upstream commit `98f74cea`, 2024-11-18). Live upstream master is about 119 commits ahead. The commits
inspected (the compare view was truncated) touch none of these features for 7.x.

**Porting cost.** Reboot 3.0 is a different codebase with its own SDK wrappers (`AFortGameModeAthena`,
`TArray`, `FindObject<UClass>`). Port the *logic*, not files: PickTeam, the AircraftBehavior copy,
AdditionalLevels streaming and the respawn gating are each under 150 lines.

---

## Recommended order

1. **P2 (non-party) + P7 trimmed to Solo** (**S**). This makes multi-player Solo real and stops the
   menu offering modes that silently play Solo. Verify with two clients:
   `PickTeam … actual: [3]` then `[4]`, and the two players can damage each other.
2. **P1 + P3 + P2 party-aware → Duos, Squads, Trios** (**M**). This is the pipeline everything else
   rides on.
3. **P5 + P8 + P9 → Playground and the loot/settings LTMs** (**S** each). Rotate a few per week
   through P7.
4. **P6 + large-team PickTeam → 50v50 family and Driftin'** (**S–M**).
5. **Private matches** (**M**), once playlists are real.
6. **P4 + goal score → Team Rumble**, then Disco Domination and Food Fight (**L**).
7. **Creative** (**L**). Ice Storm and Team Terror (AI) only if someone wants them.

## Verification still needed (none of this was run)

- **Two clients on one server today:** do they share team 3 and fail to damage each other? This
  confirms finding 2.
- **A party of two queuing Duos:** does the leader's ticket carry both `partyPlayerIds`, and does the
  member follow into the session?
- **Warmup with `MinPlayers = 24`:** does Team Rumble or 50v50 start under Nova's warmup hold without
  P9?
- **Mutator spawning:** after switching to `Playlist_Respawn_24`, do `RespawnMutator` actors exist
  (GetAllActorsOfClass on `FortAthenaMutator`), and does the goal score end the match on its own?

## Reproducing the evidence

```bash
# playlist assets in the paks (ALWAYS set OUT_DIR: paklist.mjs writes paklist-matches.txt into cwd)
OUT_DIR=<scratch> node tools/paklist.mjs "<7.40>/FortniteGame/Content/Paks" F2A0859F249BC9A511B3A8766420C6E943004CF0EAEE5B7CFFDB8F10953E994F "Playlist_[^/]*\.uasset$"
# playlists the client registered
tr -d '\000' < "%LOCALAPPDATA%/FortniteGame/Saved/Logs/FortniteGame.log" | grep "Adding Playlist"
# native team picks on the headless server
tr -d '\000' < "%LOCALAPPDATA%/FortniteGame/Saved/Logs/FortniteGame_2.log" | grep LogFortTeams
# every hosted playlist
grep -a "Setting playlist to" "%LOCALAPPDATA%/ProjectNova/Logs/cobalt.log" | sort | uniq -c
# binary symbols
node tools/binscan.js "<exe>" count "used beacon value" "player.option.customKey" "FortAthenaMutator_Respawn"
```

The property table came from a scratch extractor that decrypts and inflates pak entries, then parses
UE 4.22 unversioned tagged properties. It is not committed; the repo's `paklist.mjs` reads indexes
only. The extractor was at `%TEMP%\claude\…\scratchpad\gm\playlistprops.mjs` for this session.

## Sources

- **Local:**
  - the 7.40 paks (CL-5046157) and the baked `FortniteGame/Config/DefaultGame.ini`;
  - `FortniteGame.log` and `FortniteGame_2.log` (2026-11-08) and `cobalt.log`;
  - the Nova repo at `0db14bf`;
  - `backends/Fortnite-GS-Archive-release3` (Reboot 3.0, MoonGS 7.30);
  - `backends/_extracted/LawinServer-main` and `Reload-Backend-main` cloudstorage.
- **Upstream:**
  - https://github.com/Milxnor/Project-Reboot (2.0; `Project Reboot/dllmain.cpp` creative gate + GuiThread);
  - https://github.com/Milxnor/Project-Reboot-3.0/tree/98f74cea, with files cited inline.
- **LTM history:**
  - https://fortnitenews.com/patch-notes-for-fortnite-v7-40-share-the-love-infantry-gun-and-more/
    (fetched: 14 Feb 2019, Catch!, Team Rumble storm, Share the Love, Trios cup, Pop-Up Cup settings);
  - https://fortnite.fandom.com/wiki/Season_7
  - https://fortnite.fandom.com/wiki/14_Days_of_Fortnite
  - https://fortnite.fandom.com/wiki/Content_Update_v7.40
  - https://fortnite.fandom.com/wiki/Share_the_Love
  - https://fortnite.fandom.com/wiki/Season_7_Overtime_Challenges
  - https://fortnite.fandom.com/wiki/Custom_Matchmaking

  The fandom pages were read by a sub-agent and return HTTP 402 to direct fetches now.
- **Press:**
  - https://www.dexerto.com/fortnite/fortnites-newest-ltm-is-one-players-have-been-asking-for-a-long-time-320521 (Trios)
  - https://www.cbssports.com/nfl/news/super-bowl-2019-fortnite-to-offer-special-rams-patriots-uniforms-nfl-rumble-game-mode (NFL Rumble)
  - https://www.slashgear.com/fortnites-overpowered-infinity-blade-returns-for-new-ltm-18566115 (Sword Fight)
  - https://comicbook.com/gaming/news/fortnite-driftin-ltm-disabled/ (Driftin')
- **Other playlist corpora:**
  - client logs at https://github.com/EZFNDEV/FortLogReader (7.10 and 8.00 builds);
  - https://github.com/projectnovafn/NovaServices.Matchmaker (an unrelated "Nova"; later-build
    playlist dumps);
  - https://github.com/Project-Reload/Reload-Backend/blob/main/routes/matchmaking.js (bucketId and
    customKey handling in a community backend).

---

## Appendix A — every playlist in the 7.40 build (parsed from the cooked assets)

The asset column gives the folder when the asset name equals the PlaylistName. It gives the full
path when they differ, because Reboot needs that path. Blank cells mean the property is at its class
default. "players (min)" shows `MaxPlayers` with `MinPlayers` in brackets.

| PlaylistName (bucket id) | UI name | asset | players (min) | teams × size | squad | large | win condition | respawn | bus | modifiers | extra levels |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Playlist_33 | Teams of 33 (Squads) | `/Game/Athena/Playlists/33/` | 99 | 3 × 33 | 4 | yes |  |  | OpposingAirCraftForEachTeam | Modifier33, BigTeamGliderModifier |  |
| Playlist_50v50 | 50 V 50 (Squads) | `/Game/Athena/Playlists/50v50/` | 100 (24) | 2 × 50 | 4 | yes |  |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier |  |
| Playlist_50v50HE | High Explosive 50's (Squads) | `/Game/Athena/Playlists/50v50/50v50HE/` | 100 (24) | 2 × 50 | 4 | yes |  |  | OpposingAirCraftForEachTeam | ResourceCapModifier, BigTeamGliderModifier |  |
| Playlist_50v50SAU | Solid Gold 50s (Squads) | `/Game/Athena/Playlists/50v50/50v50SAU/` | 100 (24) | 2 × 50 | 4 | yes |  |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier |  |
| Playlist_5x20 | Teams of 20 (Squads) | `/Game/Athena/Playlists/5x20/` | 100 (60) | 5 × 20 | 4 | yes |  |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier |  |
| Playlist_Barrier | Food Fight (Squads) | `/Game/Athena/Playlists/Barrier/` | 48 (16) | 2 × 24 | 4 | yes | MutatorControlled |  | OpposingAirCraftForEachTeam | BarrierModifierDefinition, BigTeamGliderModifier |  |
| Playlist_Barrier_12 | Food Fight (Squads) | `/Game/Athena/Playlists/Barrier/` | 24 (18) | 2 × 12 | 4 | yes | MutatorControlled |  | OpposingAirCraftForEachTeam | BarrierModifierDefinition, BigTeamGliderModifier |  |
| Playlist_Barrier_16 | Food Fight (Squads) | `/Game/Athena/Playlists/Barrier/` | 32 (24) | 2 × 16 | 4 | yes | MutatorControlled |  | OpposingAirCraftForEachTeam | BarrierModifierDefinition, BigTeamGliderModifier |  |
| Playlist_Blades_Duos | Infinite Blades (Duos) | `/Game/Athena/Playlists/Blades/` | 100 | 100 × 2 | 2 |  |  |  |  | Blades_Modifiers |  |
| Playlist_Blades_Solo | Infinite Blades (Solo) | `/Game/Athena/Playlists/Blades/` | 100 | 100 × 1 | 1 |  |  |  |  | Blades_Modifiers |  |
| Playlist_Blades_Squads | Infinite Blades (Squads) | `/Game/Athena/Playlists/Blades/` | 100 | 100 × 4 | 4 |  |  |  |  | Blades_Modifiers |  |
| Playlist_Blitz_Duos | Blitz! (Duos) | `/Game/Athena/Playlists/Blitz/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Blitz_Solo | Blitz! (Solo) | `/Game/Athena/Playlists/Blitz/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Blitz_Squad | Blitz! (Squads) | `/Game/Athena/Playlists/Blitz/Playlist_Blitz_Squads` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Classic_Duos | Unvaulted (Duos) | `/Game/Athena/Playlists/Classic/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Classic_Solo | Unvaulted (Solo) | `/Game/Athena/Playlists/Classic/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Classic_Squads | Unvaulted (Squads) | `/Game/Athena/Playlists/Classic/` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Close_50 | Close Encounters 50's (Squads) | `/Game/Athena/Playlists/50v50/50v50CE/` | 100 (24) | 2 × 50 | 4 | yes |  |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier |  |
| Playlist_Close_Duos | Close Encounters (Duos) | `/Game/Athena/Playlists/Shotguns/` | 100 | 100 × 2 | 2 |  |  |  |  | Close_Modifiers |  |
| Playlist_Close_Solo | Close Encounters (Solo) | `/Game/Athena/Playlists/Shotguns/` | 100 | 100 × 1 | 1 |  |  |  |  | Close_Modifiers |  |
| Playlist_Close_Squad | Close Encounters (Squads) | `/Game/Athena/Playlists/Shotguns/Playlist_Close_Squads` | 100 | 100 × 4 | 4 |  |  |  |  | Close_Modifiers |  |
| Playlist_Creative_PlayOnly | Creative Playgrounds | `/Game/Athena/Playlists/Creative/Creative_PlayOnlyPlaylists/` | 16 (1) | 2 × 8 | 4 | yes | TimedTeamFinalFight | InfiniteRespawnExceptStorm | none | ResourceCapModifier, Creative_UserKnobsModifier, CreativeModifiers | Athena_Playground, PG_Island_GroupMaster_CuratedOnly, PG_CreativeHub_PlayOnly_03 |
| Playlist_Creative_TDM_v1 | Creative Team Battle | `/Game/Athena/Playlists/Creative/Creative_PlayOnlyPlaylists/` | 16 (1) | 2 × 8 | 4 | yes | TimedTeamFinalFight | InfiniteRespawnExceptStorm | none | ResourceCapModifier, Creative_UserKnobsModifier, CreativeSpawnDirectToIslandModifiers | Athena_Playground, PG_Island_GroupMaster_DirectMatch |
| Playlist_DefaultDuo | Duos | `/Game/Athena/Playlists/` | 100 | 100 × 2 | 2 |  |  |  |  | ResourceCapModifier_DefaultDuos |  |
| Playlist_DefaultSolo | Solo | `/Game/Athena/Playlists/` | 100 | 100 × 1 | 1 |  |  |  |  | ResourceCapModifier_DefaultSolos |  |
| Playlist_DefaultSquad | Squads | `/Game/Athena/Playlists/` | 100 | 100 × 4 | 4 |  |  |  |  | ResourceCapModifier_DefaultSquads |  |
| Playlist_Deimos_50 | Team Terror (Squads) | `/Game/Athena/Playlists/Deimos/Playlist_Deimos_50v50` | 64 (24) | 2 × 32 | 4 | yes |  |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier, GameplayMod_DeimosAI, GameplayMod_DeimosMissions, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficulty50v50 | Deimos_Gameplay |
| Playlist_Deimos_Duo_Winter | Ice Storm (Duos) | `/Game/Athena/Playlists/Deimos/` | 100 | 100 × 2 | 2 |  |  |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultyDuo | Deimos_Gameplay |
| Playlist_Deimos_Duo_WinterCN | Ice Storm (Duos) | `/Game/Athena/Playlists/Deimos/` | 100 | 100 × 2 | 2 |  | TimedLastMenStanding |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultyDuo | Deimos_Gameplay |
| Playlist_Deimos_Duo_WinterShow | Ice Storm (Duos) | `/Game/Athena/Playlists/Deimos/` | 100 (80) | 100 × 2 | 2 |  |  |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultyDuo, ResourceCapModifier_DefaultDuos | Deimos_Gameplay |
| Playlist_Deimos_Solo_Winter | Ice Storm (Solo) | `/Game/Athena/Playlists/Deimos/` | 100 | 100 × 1 | 1 |  |  |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultySolo | Deimos_Gameplay |
| Playlist_Deimos_Solo_WinterCN | Ice Storm (Solo) | `/Game/Athena/Playlists/Deimos/` | 100 | 100 × 1 | 1 |  | TimedLastMenStanding |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultySolo | Deimos_Gameplay |
| Playlist_Deimos_Solo_WinterShow | Ice Storm (Solo) | `/Game/Athena/Playlists/Deimos/` | 100 (80) | 100 × 1 | 1 |  |  |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultySolo, ResourceCapModifier_DefaultSolos | Deimos_Gameplay |
| Playlist_Deimos_Squad_Winter | Ice Storm (Squads) | `/Game/Athena/Playlists/Deimos/` | 100 | 100 × 4 | 4 |  |  |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultySquad | Deimos_Gameplay |
| Playlist_Deimos_Squad_WinterCN | Ice Storm (Squads) | `/Game/Athena/Playlists/Deimos/` | 100 | 100 × 4 | 4 |  | TimedLastMenStanding |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultySquad | Deimos_Gameplay |
| Playlist_Deimos_Squad_WinterShow | Ice Storm (Squads) | `/Game/Athena/Playlists/Deimos/` | 100 (80) | 100 × 4 | 4 |  |  |  |  | GameplayMod_DeimosAI, GameplayMod_DeimosMissions_W, GameplayMod_DeimosRiftDrop, GameplayMod_DeimosDifficultySquad, ResourceCapModifier_DefaultSquads | Deimos_Gameplay |
| Playlist_Disco_32 | Disco Domination (Squads) | `/Game/Athena/Playlists/50v50/Disco/` | 64 (24) | 2 × 32 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | DiscoGameModifier, BigTeamGliderModifier |  |
| Playlist_Disco_32_Alt | Disco Domination (Squads) | `/Game/Athena/Playlists/50v50/Disco/` | 64 (24) | 2 × 32 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | DiscoGameModifierNoA, BigTeamGliderModifier |  |
| Playlist_Final_12 | Final Fight (8 Teams of 12) | `/Game/Athena/Playlists/Final/` | 96 (24) | 8 × 12 | 4 | yes | TimedTeamFinalFight |  |  | BigTeamGliderModifier |  |
| Playlist_Final_20 | Final Fight (5 Teams of 20) | `/Game/Athena/Playlists/Final/` | 100 (60) | 5 × 20 | 4 | yes | TimedTeamFinalFight |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier |  |
| Playlist_Final_50 | Final Fight (2 Teams of 50) | `/Game/Athena/Playlists/Final/` | 100 (24) | 2 × 50 | 4 | yes | TimedTeamFinalFight |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier |  |
| Playlist_FlyExplosives_Duos | Fly Explosives (Duos) | `/Game/Athena/Playlists/HighExplosives/` | 100 | 100 × 2 | 2 |  |  |  |  | ResourceCapModifier |  |
| Playlist_FlyExplosives_Solo | Fly Explosives (Solo) | `/Game/Athena/Playlists/HighExplosives/` | 100 | 100 × 1 | 1 |  |  |  |  | ResourceCapModifier |  |
| Playlist_FlyExplosives_Squads | Fly Explosives (Squads) | `/Game/Athena/Playlists/HighExplosives/` | 100 | 100 × 4 | 4 |  |  |  |  | ResourceCapModifier |  |
| Playlist_Fortnite | Final Five (Solo) | `/Game/Athena/Playlists/Fortnite/` | 100 | 100 × 1 | 1 |  | TimedLastMenStanding |  |  |  |  |
| Playlist_Fortnite_B_Duos | Duos | `/Game/Athena/Playlists/Fortnite/` | 100 | 100 × 2 | 2 |  | TimedLastMenStanding |  |  |  |  |
| Playlist_Fortnite_B_Solo | Solo | `/Game/Athena/Playlists/Fortnite/` | 100 | 100 × 1 | 1 |  | TimedLastMenStanding |  |  |  |  |
| Playlist_Fortnite_B_Squads | Squads | `/Game/Athena/Playlists/Fortnite/` | 100 | 100 × 4 | 4 |  | TimedLastMenStanding |  |  |  |  |
| Playlist_Ground_Duos | Ground Game (Duos) | `/Game/Athena/Playlists/Ground/` | 100 | 100 × 2 | 2 |  |  |  |  | ResourceCapModifier |  |
| Playlist_Ground_Solo | Ground Game (Solo) | `/Game/Athena/Playlists/Ground/` | 100 | 100 × 1 | 1 |  |  |  |  | ResourceCapModifier |  |
| Playlist_Ground_Squads | Ground Game (Squads) | `/Game/Athena/Playlists/Ground/` | 100 | 100 × 4 | 4 |  |  |  |  | ResourceCapModifier |  |
| Playlist_Gungame_Reverse | Gun Game (Solo) | `/Game/Athena/Playlists/gg/Playlist_Gg_Reverse` | 20 | 20 × 1 | 1 |  | MutatorControlledGoalScore |  | FlyTowardFirstCircleCenter | GgAbilityModifier_Reverse |  |
| Playlist_Gungame_Solo | Gun Game (Solo) | `/Game/Athena/Playlists/gg/Playlist_Gg_Solo_Alt` | 20 | 20 × 1 | 1 |  | MutatorControlledGoalScore |  | FlyTowardFirstCircleCenter | GgAbilityModifier_Alt |  |
| Playlist_Hard_Duos | Barebones (Duos) | `/Game/Athena/Playlists/Hard/` | 100 | 100 × 2 | 2 |  |  |  |  | HArdModifierDefinition |  |
| Playlist_Hard_Solo | Barebones (Solo) | `/Game/Athena/Playlists/Hard/` | 100 | 100 × 1 | 1 |  |  |  |  | HArdModifierDefinition |  |
| Playlist_Hard_Squads | Barebones (Squads) | `/Game/Athena/Playlists/Hard/` | 100 | 100 × 4 | 4 |  |  |  |  | HArdModifierDefinition |  |
| Playlist_HighExplosives_Duos | High Explosives (Duos) | `/Game/Athena/Playlists/HighExplosives/` | 100 | 100 × 2 | 2 |  |  |  |  | ResourceCapModifier |  |
| Playlist_HighExplosives_Solo | High Explosives (Solo) | `/Game/Athena/Playlists/HighExplosives/` | 100 | 100 × 1 | 1 |  |  |  |  | ResourceCapModifier |  |
| Playlist_HighExplosives_Squads | High Explosives (Squads) | `/Game/Athena/Playlists/HighExplosives/` | 100 | 100 × 4 | 4 |  |  |  |  | ResourceCapModifier |  |
| Playlist_Hover | Driftin' (Squads) | `/Game/Athena/Playlists/50v50/Hover/Playlist_50v50_Hover` | 80 (24) | 2 × 40 | 4 | yes |  |  |  | Hover_Modifiers |  |
| Playlist_Hover_48 | Driftin' 20's (Squads) | `/Game/Athena/Playlists/50v50/Hover/Playlist_50v50_Hover_48` | 48 (24) | 2 × 24 | 4 | yes |  |  |  | Hover_Modifiers |  |
| Playlist_Hover_64 | Driftin' (Squads) | `/Game/Athena/Playlists/50v50/Hover/Playlist_50v50_Hover_64` | 64 (24) | 2 × 32 | 4 | yes |  |  |  | Hover_Modifiers |  |
| Playlist_Love_Duos | Love Shot (Duos) | `/Game/Athena/Playlists/Low/Love/` | 100 | 100 × 2 | 2 |  |  |  |  | ModifierDefinition_Love |  |
| Playlist_Love_Solo | Love Shot (Solo) | `/Game/Athena/Playlists/Low/Love/` | 100 | 100 × 1 | 1 |  |  |  |  | ModifierDefinition_Love |  |
| Playlist_Love_Squads | Love Shot (Squads) | `/Game/Athena/Playlists/Low/Love/` | 100 | 100 × 4 | 4 |  |  |  |  | ModifierDefinition_Love |  |
| Playlist_Low_Duos | One Shot (Duos) | `/Game/Athena/Playlists/Low/` | 100 | 100 × 2 | 2 |  |  |  |  | ModifierDefinition_Low |  |
| Playlist_Low_Solo | One Shot (Solo) | `/Game/Athena/Playlists/Low/` | 100 | 100 × 1 | 1 |  |  |  |  | ModifierDefinition_Low |  |
| Playlist_Low_Squads | One Shot (Squads) | `/Game/Athena/Playlists/Low/` | 100 | 100 × 4 | 4 |  |  |  |  | ModifierDefinition_Low |  |
| Playlist_Music_High | Party at Pleasant Park (Squads) | `/Game/Athena/Playlists/Music/` | 64 (30) | 2 × 32 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | MusicGameplayModifier, BigTeamGliderModifier |  |
| Playlist_Music_Higher | Party at Pleasant Park (Squads) | `/Game/Athena/Playlists/Music/` | 80 (40) | 2 × 40 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | MusicGameplayModifier, BigTeamGliderModifier |  |
| Playlist_Music_Highest | Party at Pleasant Park (Squads) | `/Game/Athena/Playlists/Music/` | 100 (50) | 2 × 50 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | MusicGameplayModifier, BigTeamGliderModifier |  |
| Playlist_Music_Low | Party at Pleasant Park (Squads) | `/Game/Athena/Playlists/Music/` | 48 (32) | 2 × 24 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | MusicGameplayModifier, BigTeamGliderModifier |  |
| Playlist_Music_Med | Party at Pleasant Park (Squads) | `/Game/Athena/Playlists/Music/` | 56 (28) | 2 × 28 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | MusicGameplayModifier, BigTeamGliderModifier |  |
| Playlist_Omaha | NFL Rumble (Squads) | `/Game/Athena/Playlists/Omaha/` | 40 (24) | 2 × 20 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | RespawnGameplayModifier, BigTeamGliderModifier, OmahaModifierDefinition |  |
| Playlist_Playground | Playground (Squads) | `/Game/Athena/Playlists/Playground/` | 4 (1) | 4 × 4 | 4 |  | LastManStandingIncludingAllies | InfiniteRespawnExceptStorm |  | ResourceCapModifier, UserKnobsModifier, PlaygroundModifiers, BigTeamGliderModifier | Athena_Playground |
| Playlist_Playground16 | Playground (Squads) | `/Game/Athena/Playlists/Playground/` | 16 (1) | 16 × 16 | 4 |  | LastManStandingIncludingAllies | InfiniteRespawnExceptStorm |  | ResourceCapModifier, UserKnobsModifier, PlaygroundModifiers | Athena_Playground |
| Playlist_PlaygroundV2 | Creative | `/Game/Athena/Playlists/Creative/` | 16 (1) | 16 × 16 | 4 |  | LastManStandingIncludingAllies | InfiniteRespawnExceptStorm | none | ResourceCapModifier, Creative_UserKnobsModifier, CreativeModifiers, GameplayMod_DeimosAI, CreativeSpawnModifier | Athena_Playground, PG_Island_GroupMaster, PG_CreativeHub_03 |
| Playlist_Respawn_24 | Team Rumble (Squads) | `/Game/Athena/Playlists/Respawn/` | 40 (24) | 2 × 20 | 4 | yes | MutatorControlledGoalScore |  | OpposingAirCraftForEachTeam | RespawnGameplayModifier, BigTeamGliderModifier |  |
| Playlist_Score_Duos | Score Royale (Duos) | `/Game/Athena/Playlists/Score/` | 100 | 100 × 2 | 2 |  | FirstToGoalScore |  |  | ScoreGameplayModifier |  |
| Playlist_Score_Solo | Score Royale (Solo) | `/Game/Athena/Playlists/Score/` | 100 | 100 × 1 | 1 |  | FirstToGoalScore |  |  | ScoreGameplayModifier |  |
| Playlist_Score_Squads | Score Royale (Squads) | `/Game/Athena/Playlists/Score/` | 100 | 100 × 4 | 4 |  | FirstToGoalScore |  |  | ScoreGameplayModifier |  |
| Playlist_Showdown_Duos | Tournament (Duos) | `/Game/Athena/Playlists/Showdown/` | 100 (90) | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Showdown_Solo | Tournament (Solo) | `/Game/Athena/Playlists/Showdown/` | 100 (90) | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Showdown_Squads | Tournament (Squads) | `/Game/Athena/Playlists/Showdown/` | 100 (88) | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Showdown_Trios | Tournament (Squads) | `/Game/Athena/Playlists/Showdown/` | 99 (90) | 99 × 3 | 3 |  |  |  |  |  |  |
| Playlist_ShowdownAlt_Duos | Tournament (Duos) | `/Game/Athena/Playlists/Showdown/` | 100 (90) | 100 × 2 | 2 |  |  |  |  | ResourceCapModifier_DefaultDuos, ShowdownAbilityModifier, None |  |
| Playlist_ShowdownAlt_Solo | Tournament (Solo) | `/Game/Athena/Playlists/Showdown/` | 100 (90) | 100 × 1 | 1 |  |  |  |  | ResourceCapModifier_DefaultSolos, ShowdownAbilityModifier, None |  |
| Playlist_ShowdownAlt_Squads | Tournament (Squads) | `/Game/Athena/Playlists/Showdown/` | 100 (88) | 100 × 4 | 4 |  |  |  |  | ResourceCapModifier_DefaultSquads, ShowdownAbilityModifier, None |  |
| Playlist_ShowdownAlt_Trios | Tournament (Squads) | `/Game/Athena/Playlists/Showdown/` | 99 (90) | 99 × 3 | 3 |  |  |  |  | ResourceCapModifier_DefaultSquads, ShowdownAbilityModifier, None |  |
| Playlist_Slide_Duos | Slide (Duos) | `/Game/Athena/Playlists/Slide/` | 100 | 100 × 2 | 2 |  |  |  |  | Slide_Modifiers |  |
| Playlist_Slide_Solo | Slide (Solo) | `/Game/Athena/Playlists/Slide/` | 100 | 100 × 1 | 1 |  |  |  |  | Slide_Modifiers |  |
| Playlist_Slide_Squads | Slide (Squads) | `/Game/Athena/Playlists/Slide/` | 100 | 100 × 4 | 4 |  |  |  |  | Slide_Modifiers |  |
| Playlist_Sneaky_Duos | Sneaky Silencers (Duos) | `/Game/Athena/Playlists/Sneaky/` | 100 (80) | 100 × 2 | 2 |  |  |  |  | Sneaky_GameModifier |  |
| Playlist_Sneaky_Solo | Sneaky Silencers (Solo) | `/Game/Athena/Playlists/Sneaky/` | 100 (80) | 100 × 1 | 1 |  |  |  |  | Sneaky_GameModifier |  |
| Playlist_Sneaky_Squads | Sneaky Silencers (Squads) | `/Game/Athena/Playlists/Sneaky/` | 100 (80) | 100 × 4 | 4 |  |  |  |  | Sneaky_GameModifier |  |
| Playlist_Snipers | Sniper Shootout (Squads) | `/Game/Athena/Playlists/Snipers/Playlist_Snipers_Squads` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Snipers_Duos | Sniper Shootout (Duos) | `/Game/Athena/Playlists/Snipers/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Snipers_Solo | Sniper Shootout (Solo) | `/Game/Athena/Playlists/Snipers/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Soaring_50s | Soaring 50's (Squads) | `/Game/Athena/Playlists/50v50/Soaring/` | 100 (24) | 2 × 50 | 4 | yes |  |  | OpposingAirCraftForEachTeam | BigTeamGliderModifier |  |
| Playlist_Soaring_Duos | Soaring Duos | `/Game/Athena/Playlists/Soaring/` | 100 | 100 × 2 | 2 |  |  |  |  | RedeployGlider_Modifier |  |
| Playlist_Soaring_Solo | Soaring Solos | `/Game/Athena/Playlists/Soaring/` | 100 | 100 × 1 | 1 |  |  |  |  | RedeployGlider_Modifier |  |
| Playlist_Soaring_Squads | Soaring Squads | `/Game/Athena/Playlists/Soaring/` | 100 | 100 × 4 | 4 |  |  |  |  | RedeployGlider_Modifier |  |
| Playlist_SolidGold_Duos | Solid Gold (Duos) | `/Game/Athena/Playlists/SolidGold/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_SolidGold_Solo | Solid Gold (Solo) | `/Game/Athena/Playlists/SolidGold/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_SolidGold_Squads | Solid Gold (Squads) | `/Game/Athena/Playlists/SolidGold/` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Steady_Duos | Steady Storm (Duos) | `/Game/Athena/Playlists/SteadyStorm/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Steady_Solo | Steady Storm (Solo) | `/Game/Athena/Playlists/SteadyStorm/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Steady_Squads | Steady Storm (Squads) | `/Game/Athena/Playlists/SteadyStorm/` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Sword_Duos | Sword Fight (Duos) | `/Game/Athena/Playlists/Sword/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Sword_Solo | Sword Fight (Solo) | `/Game/Athena/Playlists/Sword/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Sword_Squads | Sword Fight (Squads) | `/Game/Athena/Playlists/Sword/` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Toss_Duos | Catch! (Duos) | `/Game/Athena/Playlists/Toss/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Toss_Solo | Catch! (Solo) | `/Game/Athena/Playlists/Toss/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Toss_Squads | Catch! (Squads) | `/Game/Athena/Playlists/Toss/` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Trios | Trios | `/Game/Athena/Playlists/Trios/` | 100 | 100 × 3 | 3 |  |  |  |  |  |  |
| Playlist_Unvaulted_Duos | Unvaulted (Duos) | `/Game/Athena/Playlists/Unvaulted/` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Unvaulted_Solo | Unvaulted (Solo) | `/Game/Athena/Playlists/Unvaulted/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Unvaulted_Squads | Unvaulted (Squads) | `/Game/Athena/Playlists/Unvaulted/` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_Vamp_Duo | Siphon (Duos) | `/Game/Athena/Playlists/Vamp/Playlist_Vamp_Duos` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_Vamp_Solo | Siphon (Solo) | `/Game/Athena/Playlists/Vamp/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_Vamp_Squad | Siphon (Squads) | `/Game/Athena/Playlists/Vamp/Playlist_Vamp_Squads` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
| Playlist_WW_Duos | Wild West (Duos) | `/Game/Athena/Playlists/WW/Playlist_WW_Duo` | 100 | 100 × 2 | 2 |  |  |  |  |  |  |
| Playlist_WW_Solo | Wild West (Solo) | `/Game/Athena/Playlists/WW/` | 100 | 100 × 1 | 1 |  |  |  |  |  |  |
| Playlist_WW_Squads | Wild West (Squads) | `/Game/Athena/Playlists/WW/Playlist_WW_Squad` | 100 | 100 × 4 | 4 |  |  |  |  |  |  |
