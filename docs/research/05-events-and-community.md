# 05 — Live events and the community layer (2026-11-08)

Covers three questions: which historical live events Nova could show, which in-game surfaces the
backend can drive on 7.40, and how to build admin-run events, announcements and community votes.

Evidence grades follow the root docs: **CONFIRMED** (read or measured directly), **STRONGLY
SUPPORTED** (several independent signals), **INFERRED** (reasoned from evidence, not observed),
**SPECULATIVE**, **UNKNOWN**. Nothing here was played. Nothing in the source tree was changed.

## TL;DR

1. **Nova cannot trigger any live event today, on any build.** The Reboot fork's `events.cpp`
   matches upstream `Milxnor/Project-Reboot`. It has no 7.40 branch. `Defines::bIsGoingToPlayMainEvent`
   is hard-coded `false`, and the only caller of `Events::StartEvent()` is the ImGui host menu, which
   Nova turned off (`dllmain.cpp:601`, `// CreateThread(0, 0, GuiThread, …)`). CONFIRMED.
2. **None of the well-known events can run on 7.40. Their blueprints are not in the build.** Checking
   the 7.40 pak index directly: `BP_GeodeScripting` (rocket, 4.5), `Level_CUBE`, `BP_Butterfly` (6.21),
   `BP_MooneyScripting` (Ice King, 7.20), `BP_FestivusManager` (Marshmello, 7.30), `BP_NewYearTimer` and
   `BP_SnowScripting` (8.51) are all missing. Each event needs its own build. STRONGLY SUPPORTED: 15
   main-key paks were read. Five dynamic-key chunks could not be read, and those hold cosmetics.
3. **7.40 does ship one event of its own that no public project has implemented: the Season 8
   lead-up.** In February 2019, earthquakes opened cracks across the map about every 12 hours.
   `BP_S8LeadupEvents`, `BP_Cracken_City/Effect`, `BP_SplineMesh_Cracks`, `Athena_Cracken.umap` and
   `GCN_Athena_Event_S8Leadup1` are in the paks. Also present are `BP_SnowSetup` (season 7 snow
   cover) and `BP_CalendarProps*` (props switched on and off by the calendar). What drives them is
   UNKNOWN until the assets are inspected.
4. **7.40 has a full tournament UI.** It includes `UFortTournamentManager`, Showdown tiles with
   schedule states (`FutureScheduled`, `LiveParticipating`, …), posters, pins and scoring rules. The
   client calls `GET /api/v1/events/Fortnite/download/{acct}` **37 times a session**. Admin-scheduled
   events can therefore appear inside the game, not only in the launcher. Arena and Hype are not in
   7.40 (CONFIRMED: "Arena" appears only as spectator-camera symbols).
5. **Nova's in-game news is probably invisible on 7.40.** Nova sends `battleroyalenews.news.motds[]`.
   The 7.40 binary contains neither `motds` nor `Motds`; it reads `messages`. STRONGLY SUPPORTED;
   check with one screenshot.
6. **The modes the client offers are set by the `FrontEndPlaylistData` hotfix, not by timeline flags.**
   The comment in `social.routes.ts` saying the season 7 flags "light up" LTM tiles is unsupported.
   Also, whatever mode a player picks, **Reboot always hosts `Playlist_DefaultSolo`** (no code sets
   `Defines::Playlist` except the disabled GUI). So a vote winner can only become playable after a
   change across the backend, host agent and Reboot.
7. **Recommended design.** A coordinator-only `community` module in `nova.db`. Admin CRUD sits behind
   the existing `adminOk` gate. A 15-second scheduler moves events and votes through their states and
   applies a vote winner as a time-boxed **rotation override**. A single `rotationAt(now)` function
   then feeds the hotfix, content pages, timeline, events service, matchmaking, host election and a new
   Reboot `match-config` fetch. Votes allow one ballot per account (primary key). **Eligibility is a
   snapshot of accounts with real play history taken when the vote opens**, because registration is
   unthrottled, unverified, and arrives from a single IP through Funnel.

---

## 0. Method and evidence

| Source | What it settled |
|---|---|
| `Project-Reboot-DLL/Project Reboot/{events,calendar,processevent,dllmain,definitions,gui}.*` | what Nova's game server can do and what it actually does |
| `tools/paklist.mjs` on the 7.40 paks, with the 7.40 key from VERSION_COMPATIBILITY.md (index only, payload never read) | whether each event's assets exist in 7.40. Output kept in scratchpad, not the repo |
| `tools/binscan.js` on the 7.40 `FortniteClient-Win64-Shipping.exe`, with positive controls (`QueryProfile`, `tournament_info`) and a negative control (`bUsePartySystemV2`) | which JSON keys and UPROPERTYs the client knows |
| Forge 10.40 SDK dump (`backends/Fortnite-GS-Archive-release3/Forge (10.40)/…/SDK`) | struct layouts for names that exist in 7.40 (`FPlaylistFrontEndSettings`, `FShowdownTournamentEntry`, `UFortRuntimeOptions::bEnableShowdown`, `AFortGameState::Client_RefreshEventCalendar`). **The layout is 10.40; for 7.40 only the names are confirmed** |
| upstream `Milxnor/Project-Reboot-3.0` (`events.h`, `gui.h`, `calendar.h`, `FortGameModeAthena.cpp`), `plooshi/Erbium` (local copy `backends/_extracted/Erbium-main`) | how public OGFN servers trigger events |
| FortniteEndpointsDocumentation (local zip): `EventsService/Events/Data/Download.md`, `FN-Service/Game/Calendar.md` | modern response shapes for the events service and timeline |
| `Main backend/src/services/**`, `Launcher/src{,-tauri/src}` | what Nova serves and sends today |

**Binary-scan rules followed (tools/README.md).** A UTF-16 snake_case key such as `tournament_info`
is a JSON key the client parses by name, and its absence is conclusive. PascalCase hits such as
`ActiveEvents` are UPROPERTY names that UE's JSON converter matches case-insensitively, so
camelCase absence means nothing for those. No path containing a slash was treated as absent.

---

## Part A — Historical live events

### A.0 How these events are built

Every event from 4.5 to 14.60 has the same shape. The four Reboot and Erbium tables agree, and
the parameter types match what retail-era code would do.

1. A **loader** actor streams the event sublevel in, using `Load<Codename>Level(bool)` or `LoadMap`.
   Examples: `BP_Jerky_Loader`, `BP_Butterfly.LoadButterflySublevel`, `BP_SnowScripting.LoadSnowLevel`.
2. A **scripting** actor in that sublevel receives its Blueprint `OnReady_<GUID>(GameState, Playlist,
   FGameplayTagContainer)` callbacks. Those are the playlist-ready delegates the game would fire.
3. `startevent(float SecondsSinceEventBegan)`, `FinalSequence`, `LaunchSequence` or a similar function
   plays the server-side sequence. The sequence replicates to clients.
4. From 17.30 on, events use the **SpecialEventScript** framework instead:
   `SpecialEventScript.StartEventAtIndex`, plus `SpecialEventScriptMeshActor.MeshRootStartEvent` and
   `OnRep_RootStartTime`. Erbium also toggles `MeshNetworkSubsystem.NodeType` around the start call.

**How retail triggered them: STRONGLY SUPPORTED that the calendar drove them; the per-event flag names
are UNKNOWN.** Every `startevent` takes `SecondsSinceEventBegan`, which only makes sense if a clock
outside the actor decides when the event began. The 7.40 binary contains the calendar-watch machinery
such a clock needs:

- `UFortAsyncAction_CalendarEventWatcher` and `WatchCalendarEvent(context=%s, event=%s)`
- `IsEventFlagActive`, `OnActiveEventFlagsChanged` and `RequiredEventFlag`
- `bCalendarAllowsSpawning` and `GetCalendarEventInformation(%s)`
- `FortCalendarEventInventoryTransform` (grants items and quests per event)
- `Client_RefreshEventCalendar`, an `AFortGameState` RPC in 10.40 that makes clients refetch the timeline

So the scripting actors watched timeline events and started at `activeSince`. Late joiners played
from the elapsed offset. The exact flag each event watched is written inside its blueprint and can
only be recovered by reading the asset (§A.5).

**How public OGFN servers trigger them: CONFIRMED from source. None of them use the calendar.**

| Project | Load | OnReady | Start | Playlist |
|---|---|---|---|---|
| **Project Reboot (old)**: Nova's fork is this code, identical `HasEvent` list `{18.40, 17.50, 17.30, 14.60, 12.41, 6.21}` | `Events::LoadEvent()` runs automatically in `ReadyToStartMatch` when `bIsGoingToPlayMainEvent` (`processevent.cpp:668`) | inside `StartEvent` | **ImGui "Start Event" button** (`gui.h:776`) | `GetEventPlaylistName()`, also set from the GUI (`gui.h:1263`) |
| **Project Reboot 3.0** (`events.h`): a table of `{EventDisplayName, LoaderClass, LoaderFunction, OnReadyFunctions, StartEventFunctions, ScriptingClass, PlaylistName, Version, RequiredPlaylist}` | automatic in `Athena_ReadyToStartMatchHook` when `Globals::bGoingToPlayEvent`, once per restart | `CallOnReadys()` automatic after a successful load | **manual "Start <event>" button** (`gui.h`). The host ticks "Play Event" before starting | `GetPlaylistToUse()` swaps in the event playlist (skipped for 12.61) |
| **Erbium** (`Erbium/Public/Events.h`, `Private/Events.cpp`) | automatic when the hosted playlist carries the tag **`Athena.Playlist.SpecialEvent`** (`FortGameMode.cpp:~572`) | in `StartEvent` | GUI button **or the in-match chat command `startevent`** (`FortPlayerControllerAthena.cpp:~2173`). For 8.51 a 3-minute timer then unvaults the DrumGun | the playlist itself |

Two of these ideas carry over to Nova: Erbium's "the playlist decides" auto-load, and its in-match
admin command. The real gap is a **backend-driven start**, because Nova has neither a GUI nor an
admin in the match (§A.4).

### A.1 What Nova's fork does today

- `Defines::bIsGoingToPlayMainEvent = false` (`definitions.h:25`). Nothing assigns it.
- `Defines::Playlist` defaults to `Playlist_DefaultSolo` (`definitions.h:132`). The only assignments
  are in `gui.h:1263/1272`, which is unreachable. CONFIRMED.
- `Events::LoadEvent()` is called only behind the flag (`processevent.cpp:668`). `StartEvent()`,
  `StartNewYears()` and `Unvault()` are called only from `gui.h`. CONFIRMED.
- `Calendar::FixLocations()` runs every match (`processevent.cpp:666`). For season 7 it shows the
  Polar Peak foundation `LF_Athena_POI_25x36`, Tilted's `ShopsNew` and The Block (`SLAB_2`). This is
  the only calendar-style world state Nova applies.
- **Hazards if `StartEvent` is ever wired back up.** `bbparms` dereferences `*Helper::GetPlaylist()`
  unguarded (`events.cpp:240`). The 5.30, 5.41, 17.30, 17.50, 18.40 and 20.40 branches call
  `FindObject(...)->ProcessEvent` with no null check. `StartEvent` calls `LoadEvent()` again, which
  streams the sublevel twice. `static bool bFirst = bHasBeenLoaded` is evaluated once per process.
  This is the same class of fault behind three past crashes (memory: reboot-dll, "0-offset reads the
  vtable"). Guard all of it first.

### A.2 Event by event

"In 7.40 paks" comes from the pak index. ABSENT means not found in the 15 readable paks
(STRONGLY SUPPORTED). PRESENT is CONFIRMED.

| Event (date) | Build used by OGFN tables | Driver (assets → functions) | Who implements it | In 7.40 paks | Feasibility |
|---|---|---|---|---|---|
| **Blast Off: rocket launch** (30 Jun 2018) | **4.5** | `/Game/Athena/Maps/Test/Events/BP_GeodeScripting` → `LaunchSequence` | Reboot 3.0 ("Rocket"), Erbium. **Not in Nova's fork** | `BP_GeodeScripting` ABSENT (Geode FX meshes only) | 7.40: **not feasible**. Own build: **needs a build Nova does not target** + Reboot work (no 4.5 entry in the fork, no trigger) |
| **Cube spawn / crack closure** (Aug 2018) | **5.30** | `BP_Athena_Event_Components.Final` + `CUBE_C.Final` on `Level_CUBE:CUBE_2`. LoadEvent hides the crack via `CrackOpacity`/`Corruption` | Nova fork (code, not in `HasEvent`), Reboot 3.0, Erbium | `CUBE`, `Cube_Dest_Scripting`, `BP_Athena_Event_Components` PRESENT; **`Level_CUBE` ABSENT** | 7.40: not feasible (class without its placed actor or map state; spawning it by hand is SPECULATIVE). Own build: needs build + Reboot work |
| **Cube into Loot Lake** (Sep 2018) | **5.41** | `CUBE_C.ImpactLake` (fork) / `PlayFinalSink` (Reboot 3.0, commented out) | Nova fork | as above | same |
| **Butterfly** (27 Oct 2018) | **6.21** | `BP_Butterfly.LoadButterflySublevel(1)` → `ButterflySequence` | Nova fork (**in `HasEvent`**), Reboot 3.0, Erbium | ABSENT | 7.40: not feasible. Own build: needs build + trigger |
| **Ice Storm / Ice King** (Jan 2019) | **7.20** | `BP_MooneyLoader.LoadMap` (Reboot 3.0 special-cases 7.20: `LoadMooneyMap=true` + `OnRep_LoadMooneyMap`) → `BP_MooneyScripting.OnReady_9968…` → `BeginIceKingEvent` | Reboot 3.0, Erbium. **Not in Nova's fork** | `BP_MooneyLoader` + `P_Screen_Freeze_IceStorm` PRESENT; **`BP_MooneyScripting` ABSENT** | 7.40: not feasible (only the loader shell is left). Own build: **needs a build**, the closest to Nova's target (same season), plus a fork entry and trigger |
| **Marshmello concert** (2 Feb 2019) | **7.30** | `BP_FestivusManager.OnReady_EE76…` → `PlayConcert` (fork) / `ServerPlayFestivus` (Reboot 3.0, Erbium). `FixLocations` shows `PleasentParkFestivus` on 7.30 | Nova fork (7.30 branch), Reboot 3.0, Erbium | `BP_FestivusManager` ABSENT (emote anims, FX and `GE_FestivusAudioSetup` only) | 7.40: not feasible. Own build: needs build + trigger |
| **New Year 2019** (31 Dec 2018) | **7.10** | `Athena_NYE_Celebration:BP_NewYearTimer.startNYE` | Nova fork (`StartNewYears`), Reboot 3.0 (`Calendar::StartNYE`) | ABSENT | 7.40: not feasible |
| **Season 7 snow cover** (Dec 2018–Feb 2019) | 7.10 / 7.30 in Reboot 3.0 | `BP_SnowSetup.SetSnow(float)` | Reboot 3.0 `Calendar::SetSnow` | `BP_SnowSetup` **PRESENT** | 7.40: **needs Reboot work**. INFERRED: the function name comes from 7.10/7.30 code and is unverified on 7.40 |
| **Season 8 lead-up: earthquakes and cracks** (Feb 2019) | **7.40** | `S8Leadup/BP_S8LeadupEvents`, `BP_Cracken_City`, `BP_Cracken_Effect`, `BP_SplineMesh_Cracks`, `S8LeadupCurve`, `Athena_Cracken.umap`, `GCN_Athena_Event_S8Leadup1`, `B_s8Leadup1_CameraShake_01`, `Athena/Events/Earthquake/*` FX | **no public implementation found** | **PRESENT** | 7.40: **needs Reboot work and measurement first**. The only historical event native to Nova's build |
| **The Unvaulting** (spring 2019) | **8.51** | `BP_SnowScripting.LoadSnowLevel`, four `OnReady_*`, `FinalSequence`. The vote result goes through `UnvaultedItemName` + `OnRep` + `PillarsConcluded(FName)` (fork) or `SetUnvaultItemName` (Reboot 3.0, Erbium) | Nova fork (code + `Events::Unvault`), Reboot 3.0, Erbium | ABSENT | Own build: needs build + trigger. **A natural fit for votes:** a Nova vote picks the `FName` passed to `Unvault()` |
| **The Showdown: monster vs mech** (20 Jul 2019) | **9.40 / 9.41** | `BP_CattusDoggus_Scripting.LoadCattusLevel` → `OnReady_C11C…` → `startevent` | all three | ABSENT | own build |
| **The End** (13 Oct 2019) | **10.40** | `BP_NightNight_Scripting.LoadNightNightLevel` → `OnReady_D084…` → `startevent`. The client is left in the black-hole state | Nova fork (code, not in `HasEvent`), Reboot 3.0, Erbium; Forge is a dedicated 10.40 server | ABSENT | own build |
| **Galileo: Star Wars** (14 Dec 2019) | **11.30** | `BP_GalileoLoader.LoadMap`, `BP_Galileo_Script` OnReadys + `startevent` | Nova fork only | ABSENT | own build |
| **Astronomical** (23–25 Apr 2020) | **12.41** | `BP_Jerky_Loader` / `BP_Jerky_Scripting` OnReadys + `startevent`. Playlist `Playlist_Music_High` | all three; in the fork's `HasEvent` | ABSENT | own build (Chapter 2: also needs the backend's Chapter 2 surface → report 02) |
| **The Device** (15 Jun 2020) | **12.61** | `BP_Fritter_Loader` / `BP_Fritter_Script` OnReadys, `CallStartEventOnScripting`. Playlist `Playlist_Fritter_High`; Reboot 3.0 skips the playlist swap here | all three | ABSENT | own build |
| **Galactus: Devourer of Worlds** (1 Dec 2020) | **14.60** | `BP_Junior_Loader.LoadJuniorLevel`, `BP_Event_Master_Scripting.OnReady_872E…`, `BP_Junior_Scripting.startevent`. The warmup is kept (`processevent.cpp:452`) | all three; in `HasEvent` | ABSENT | own build |
| Rift Tour / Operation Sky Fire / The End C2 | **17.30 / 17.50 / 18.40** | SpecialEventScript `StartEventAtIndex`, mesh actor start | all three | n/a | own build |
| **The Collision** (4 Jun 2022) | **20.40** (UE5) | `BP_Armadillo_SpecialEventScript`; the fork drives `BP_Armadillo_PreEventManager.OnReady/startevent` + a fixed spawn location (`events.cpp` `GetSpawnLocation`); Erbium uses `StartEventAtIndex` + `MeshRootStartEvent` | Nova fork (not in `HasEvent`), Erbium. Not in Reboot 3.0 | n/a | **needs a build Nova does not target + heavy Reboot work** (UE5 path barely exercised) |
| (Erbium only) Fracture, plus a 27.11 event codenamed "Durian" | 22.40 / 27.11 | SpecialEventScript | Erbium | n/a | out of scope |

**Nothing above "works with Reboot as is".** Even on the right build, Nova's fork has no way to start
an event (§A.1). "Own build" costs, per report 02 and the 00 audit: the build on disk, Cobalt
signatures for it (7.40-only today), a test pass of Reboot's existing per-engine patterns
(`patterns.h` carries 4.16–5.0 patterns from upstream, untested here), and the backend's era surface.

### A.3 What 7.40 itself can offer

| Item | Evidence | What it would take |
|---|---|---|
| **Season 8 lead-up cracks** | assets PRESENT (above). Press at the time: cracks every ~12 hours in the last week of season 7 ([PCGamesN](https://www.pcgamesn.com/fortnite/fortnite-earthquakes), [Dexerto](https://www.dexerto.com/fortnite/every-fortnite-earthquake-crack-so-far-366636), [FortniteNews on the 7.40 "Cracken" files](https://fortnitenews.com/fortnite-season-7-cracken-event)) | (1) read `BP_S8LeadupEvents` with UAssetAPI (in the corpus zips) for its functions, phase variables and any calendar event names. (2) If it watches the calendar, it may run with **timeline flags alone**, because the game server's own timeline comes from the coordinator (see below). (3) Otherwise drive it from Reboot with a `phase` directive |
| **Calendar props** (`BP_CalendarProps`, `_Progressive`, `CalendarPropData`, `CalendarPropSelectionData`) | PRESENT. `bCalendarAllowsSpawning` in the binary | Find which flags they key on (asset read), then add those flags to the timeline. Possibly **zero native work** |
| **Snow level** | `BP_SnowSetup` PRESENT | Reboot: `FindObject` the setup actor, call `SetSnow(value)` on the game thread at match start |
| **LTM playlists** | the paks contain **124 playlist assets**: `Playlist_Love_*` (Share the Love, 7.40), `Unvaulted_*`, `WW_*` (Wild West), `Blitz_*`, `SolidGold_*`, `Snipers_*`, `HighExplosives_*`, `Close_*`, `Barrier*`, `Disco_32`, `50v50*`, `Soaring_*`, `Respawn_24`, `Deimos_*_Winter*`, `Showdown*`/`ShowdownAlt*` incl. Trios, `Music_High/Higher/Highest/Low/Med`, `Playground*`, `Creative_*` … | Part B §3. **Correction for VERSION_COMPATIBILITY §"7.40 playlists — CONFIRMED":** its 16 names are the playlist names *compiled into the exe*. The asset set is 124 |
| **The Block** | `BP_SlabScripting`, `BP_BlockSign`, `Block/7_40/Block_25x25_ColossalCompound.umap` PRESENT | Already shown by `FixLocations` (`SLAB_2`) |

**The game server sees the same timeline the players do.** INFERRED, strong. The headless server is
the same exe with Cobalt installed by file replacement. It logs in with `-AUTH_LOGIN` (`carter.rs:764`)
and boots to the frontend before Reboot is injected. Its timeline call goes through Cobalt to
`127.0.0.1:3551`, then through nova-proxy to the coordinator (ARCHITECTURE §1). Any server-side
blueprint that asks `IsEventFlagActive` therefore gets the coordinator's answer. To verify: look for
the host's `/fortnite/api/calendar/v1/timeline` call in `/nova/api/diagnostics` or `cobalt.log`
before injection.

### A.4 What "needs Reboot work" means: one backend-driven trigger

The same design serves 7.40 world events and future builds' historical events:

1. **`GET /nova/api/gameserver/match-config?port=7777`**, returned as plain `key=value` text. The DLL
   has no JSON parser on this path, the same as `/nova/api/locker/loadout`:
   ```
   playlist=/Game/Athena/Playlists/Blitz/Playlist_Blitz_Solo
   event=s8leadup
   event_phase=3
   event_start_unix=1762620000
   snow=0.0
   ```
2. Reboot reads it **once per process** in the first `ReadyToStartMatch`, before
   `FindObjectSlow(cpyplaylist)` (`processevent.cpp:561`). Use the existing `NovaBackendGet`
   (`helper.cpp:428`, 1–2 s timeouts). A dedicated server exits with `TerminateProcess` at match end
   and the launcher re-hosts, so every match fetches fresh config. If the fetch fails, keep today's
   behaviour (Solo, no event).
3. **Live events start at a wall-clock time.** A worker thread polls the endpoint during warmup and
   sets an atomic flag. `Server::Hooks::TickFlush` (game thread) runs Load, OnReady and Start, passing
   `SecondsSinceEventBegan = now - event_start_unix`, the retail semantics. Never call `ProcessEvent`
   from the polling thread; off-thread `SwitchLevel` is already a known smell in this codebase.
4. Reuse what the fork already has: the event playlist, `bGoIntoWarmup=false` for events
   (`processevent.cpp:452`), the spawn override (`processevent.cpp:207`) and god mode on spawn. Add
   null guards everywhere (§A.1). Replace the per-version `if` chain with a Reboot 3.0-style table so
   that a new build means adding a row, not a branch.

### A.5 Open measurements

| Question | Settled by |
|---|---|
| Which calendar event or flag each event blueprint watches (`BP_S8LeadupEvents`, `BP_CalendarProps*`, and on other builds the `*_Scripting` actors) | extract the `.uasset` from the pak (main key) and dump its name map and functions with UAssetAPI (`Full documentation/…/UAssetAPI-master.zip`) |
| Does `BP_SnowSetup.SetSnow` exist on 7.40? | Reboot log line: `FindObject<UFunction>(…SetSnow)` non-null |
| Are non-default playlist assets loaded in the server process at `ReadyToStartMatch`? `FindObjectSlow` only finds loaded objects | log `FindObjectSlow("Playlist_Blitz_Solo")` once. If null, add the `StaticLoadObject` fallback (already in `structs.h`) |

---

## Part B — What the 7.40 client lets a backend drive

### B.1 Surfaces, today vs what 7.40 reads

| Surface | Endpoint (calls per session) | Nova today | What 7.40 knows (binscan) | Grade | Gap |
|---|---|---|---|---|---|
| **Calendar / timeline** | `GET /fortnite/api/calendar/v1/timeline` (64) | `social.routes.ts:575`. Channels `standalone-store`, `client-matchmaking` (`region.<R>.eventFlagsForceBinaryEqual`), `client-events` with `activeEvents` = `EventFlag.Season{N}`, `EventFlag.LobbySeason{N}` + 5 season-7 flags, all `activeSince 2019-02-28`, `activeUntil 9999`. `cacheExpire 9999`, `cacheIntervalMins 15` | `ActiveEvents`, `EventType`, `ActiveUntil`, `ActiveSince`, `ValidFrom`, `States`, `SeasonNumber`, `EventNamedWeights`, `ActiveStorefronts`, **`EventFlagsForcedOff`** (not `…ForceBinaryEqual`), `client-matchmaking`, `featured-islands`. **No `community-votes`, `Candidates` hit is unrelated, no `ElectionEnds`/`NumWinners`** | CONFIRMED names | Flags have no schedule. No future `states[]`. `eventFlagsForceBinaryEqual` is unknown to 7.40, which is harmless. **No in-game voting channel exists on 7.40** |
| **Hotfix: playlist visibility** | `GET /fortnite/api/cloudstorage/system` (107) + `…/DefaultGame.ini` (64) | `data/cloudstorage/DefaultGame.ini` has `[/Script/FortniteGame.FortGameInstance] bBattleRoyaleMatchmakingEnabled=true` and **no `FrontEndPlaylistData`**. Hash computed from file content | `FrontEndPlaylistData`, `PlaylistFrontEndSettings`, `PlaylistAccess`, `PlaylistAccessOverride`, `AccessOverrides`, `bEnabled`, `bIsDefaultPlaylist`, `bVisibleWhenDisabled`, `bDisplayAsLimitedTime`, `DisplayPriority`, `CategoryIndex`, `AdvertiseType`, `bForcePlaylistOff` all PRESENT. **`bDisplayAsNew` ABSENT** (later builds). In 10.40 the owner is `UFortGameInstance::FrontEndPlaylistData` (Config) | names CONFIRMED; owner and section INFERRED from 10.40 | **This is the lever for "featured mode"**. Neither 10.40 `UFortPlaylist` nor `UFortPlaylistAthena` has an event-flag gate, and 7.40 has no `GatingEventFlag`/`bRequiresEventFlag` |
| **Hotfix: tournament UI** | `…/DefaultRuntimeOptions.ini` (48) | `bEnableGlobalChat`, gifting flags | `bEnableShowdown`, `ShowdownTournamentCacheExpirationHours`, `MinimumAccountLevelForTournamentPlay`, `bEnableTournamentMatchCaps`, `TournamentDisabledFrontendNavigationTabs` PRESENT (10.40: `UFortRuntimeOptions`) | names CONFIRMED | Set `bEnableShowdown=true`, `MinimumAccountLevelForTournamentPlay=0` |
| **Content: BR news / login MOTD** | `GET /content/api/pages/fortnite-game` (85) | `battleroyalenews.news.motds[{entryType, image, tileImage, tabTitleOverride, title, body, …}]` (`social.routes.ts:491-498`) | `battleroyalenews`, `news`, **`messages`**, `messagetype`, `spotlight`, `image`, `hidden`, `title`/`body`. **`motds`/`Motds`, `tileImage`, `entryType`, `tabTitleOverride` ABSENT**. `UFortUIStateWidget_Login::HandleReadCMSDataComplete Showing MOTD` | STRONGLY SUPPORTED | **Send `news.messages[]`.** Today's MOTD almost certainly never renders |
| **Content: emergency notice** | same | `emergencynotice.news.messages: []` | `emergencynotice`, `messages`. `emergencynoticeoverride` ABSENT | CONFIRMED names | Shape is right; it is always empty |
| **Content: login message** | same | `loginmessage.loginmessage.message{title, body}` | `loginmessage` | names CONFIRMED | usable as-is |
| **Content: playlist tiles** | same | `playlistinformation.playlist_info.playlists[{image:'', playlist_name, hidden:false}]` for Solo/Duo/Squad/ShowdownAlt Solo+Duos; header text empty | `playlistinformation`, `playlist_info`, `playlist_name`, `image`, `hidden`, `description`, `display_name`, `special_border`, `violator`, `frontend_matchmaking_header_style`, `frontend_matchmaking_header_text`. `display_subname`, `is_tile_hidden` ABSENT | names CONFIRMED; which widget reads each is INFERRED | Add art, description and violator for featured modes. `frontend_matchmaking_header_text` is a free in-game banner on the matchmaking screen |
| **Content: tournament posters** | same | `tournamentinformation.tournament_info.tournaments: []` | every `FShowdownTournamentEntry` key: `tournament_display_id`, `title_line_1/2`, `schedule_info`, `poster_front_image`, `poster_back_image`, `flavor_description`, `details_description`, `short_format_title`, `long_format_title`, `pin_score_requirement`, `pin_earned_text`, `primary_color`, `background_text_color`, `playlist_tile_image`, `loading_screen_image` | CONFIRMED (keys); layout from 10.40 | Fill from admin events |
| **Content: lobby background** | same | `dynamicbackgrounds…lobbyseason{N}` | **`dynamicbackgrounds`, `DynamicBackgrounds`, `lobbyseason` ABSENT** | CONFIRMED absent | 7.40 does not read it. The stage likely comes from `EventFlag.LobbySeason7` (INFERRED). Harmless; the code comment crediting it with fixing a blank lobby deserves a second look |
| **Events service (tournaments)** | `GET /api/v1/events/Fortnite/download/{acct}?region&platform&teamAccountIds` (37); leaderboards; window history | `social.routes.ts:421` → `{player:{accountId, tokens:[], …}, events:[], templates:[]}`. Leaderboard → `{entries:[], maxSize:1000}`. **History route not registered** | `UFortTournamentManager`, `FOnlineTournamentServiceMcp`, `/events/'GameId/download/'AccountId?region=…`, `/events/'GameId/'EventId/'EventWindowId/history`, `eventWindows`, `eventWindowId`, `eventId`, `beginTime`, `endTime`, `displayDataId`, `scoringRules`, `tokens`, `regions`; `EFortShowdownEventState::{FutureScheduled, FutureNext, FutureTBD, LiveParticipating, LiveNotParticipating, Completed*, Cancelled}`; `EFortMatchmakingTileStyle::Showdown`; `HandleXmppReceived Refresh message received!` | names CONFIRMED; full schema INFERRED from the modern doc; **whether 7.40 renders a Nova-built event is UNKNOWN** | **Main in-game surface for scheduled events** (B.3.1) |
| **Matchmaking** | `GET /fortnite/api/game/v2/matchmakingservice/ticket/player/{acct}` (35) | `bucketId` split on `:`. `[0]` build, `[2]` region, `[3]` playlist (numeric map `2/10/9/11/50`). Routed to any server registered `'*'` | `[UFortMatchmakingV2::ParseMatchmakingInfoString] Did not have the full 6 params for %s, no TournamentId or EventWindowId` | CONFIRMED | Tournament tickets carry `eventId`/`windowId` in the 6-part form, which is not parsed. **The chosen playlist is never hosted** (below) |
| **XMPP** | WebSocket | MUC rooms + `sendXmppMessage()` (`xmpp.server.ts:781`) | `bEnableShowdownXmppNotify`, `FOnlineTournamentServiceMcp::OnXmppMessageReceived` | names CONFIRMED; message types UNKNOWN | Possible later push: "tournament refresh". A global-chat announcement is UNKNOWN to render in the 7.40 BR lobby |
| **In-match push** | Reboot | — | `Client_RefreshEventCalendar` (`AFortGameState` RPC in 10.40) | INFERRED | Reboot can make every connected client refetch the timeline the moment an event starts |

**Images.** The client fetches content-page image URLs over its own HTTP stack. Cobalt rewrites only
`*.ol.epicgames.com`, `*.akamaized.net`, `epicgames.dev`, `on.epicgames.com`, … to `127.0.0.1:3551`
(`Launcher/cobalt/Cobalt/curlhook.h:93-104`), and the rewrite keeps the **path** and drops the host.
So serve in-game art as `https://nova-media.ol.epicgames.com/nova/api/community/media/<id>.png`.
Cobalt sends it to the backend, nova-proxy forwards it to the coordinator, and no third-party TLS from
a 2019 OpenSSL is involved. INFERRED: it assumes image downloads go through the hooked
`curl_easy_setopt` like every service call does. The launcher's `news.json` uses `i.ibb.co`, which
is fine for WebView2 and a gamble in-game.

**Mode choice never reaches the game server today (CONFIRMED).** The client's playlist reaches the
ticket (`matchmaking.routes.ts:935`). Hosts always register `"playlist": "*"` (`host.rs:205`), the
launcher asks to host for `PLAYLIST = "Playlist_DefaultSolo"` (`useLauncher.ts:27`), and Reboot hosts
`Defines::Playlist` = DefaultSolo. **A player who picks Duos or an LTM plays Solo.** Non-solo modes
also need team assignment, which is still commented out (`processevent.cpp:~1909`, report 03).

### B.2 Response shapes Nova serves today (abridged)

```jsonc
// GET /fortnite/api/calendar/v1/timeline  (social.routes.ts:575)
{ "channels": {
    "standalone-store":   { "states":[{ "validFrom":"2019-01-01T00:00:00.000Z", "activeEvents":[], "state":{…} }], "cacheExpire":"9999-…" },
    "client-matchmaking": { "states":[{ "validFrom":…, "activeEvents":[], "state":{ "region":{ "NAE":{ "eventFlagsForceBinaryEqual":"", "allowedPlatforms":"Windows" }, … } } }], … },
    "client-events":      { "states":[{ "validFrom":…, "activeEvents":[{ "eventType":"EventFlag.Season7", "activeUntil":"9999-…", "activeSince":"2019-02-28T14:00:00Z" }, …],
                                         "state":{ "seasonNumber":7, "seasonTemplateId":"AthenaSeason:athenaseason7", "seasonBegin":…, "seasonEnd":"9999-…", … } }], … } },
  "eventsTimeOffsetHrs":0, "cacheIntervalMins":15, "currentTime":"<now>" }

// GET /content/api/pages/fortnite-game  (social.routes.ts:481)
{ "battleroyalenews":{ "news":{ "_type":"Battle Royale News", "motds":[ { "title":"Welcome to Project Nova", … } ] } },   // 7.40 reads news.messages
  "emergencynotice":{ "news":{ "_type":"CommonUI Simple Message Base", "messages":[] } },
  "loginmessage":{ "loginmessage":{ "message":{ "title":"Project Nova", "body":"Welcome." } } },
  "tournamentinformation":{ "tournament_info":{ "tournaments":[] } },
  "playlistinformation":{ "frontend_matchmaking_header_style":"None", "frontend_matchmaking_header_text":"",
                          "playlist_info":{ "playlists":[ { "image":"", "playlist_name":"Playlist_DefaultSolo", "hidden":false }, … ] } },
  … }

// GET /api/v1/events/Fortnite/download/:accountId  (social.routes.ts:421)
{ "player":{ "accountId":"…", "tokens":[], "teamId":null, "pendingPayouts":[], "pendingPenalties":{}, "persistentScores":{} },
  "events":[], "templates":[] }

// GET /nova/api/news  (nova.routes.ts:146) → { "news":[{ id, title, date, desc, img }] }  from data/news.json; the launcher defines getNews() but no screen uses it
```

### B.3 What has to change

#### B.3.1 Admin-scheduled events showing up in the game

1. **Timeline.** For each live community event, emit its era-correct flags with the real `activeSince`
   and `activeUntil`. Emit a second, future entry in `client-events.states[]` with `validFrom` set to
   the next boundary, so a client that cached the response flips on time without refetching.
   INFERRED from the `states[]` + `validFrom` design. Set `cacheExpire` to the next boundary, capped at
   now + 15 min. **A made-up flag does nothing:** only flags that some blueprint in the build reads
   (§A.5) change the world.
2. **Showdown tile, the in-game "Events" entry.**
   - **Hotfix:** `DefaultRuntimeOptions.ini` → `bEnableShowdown=true`, `MinimumAccountLevelForTournamentPlay=0`.
   - **Events download:** return one `events[]` entry per scheduled community event. Fields:
     `gameId:"Fortnite"`, `eventId`, `regions`, `platforms:["Windows"]`, `displayDataId`, `beginTime`,
     `endTime`, and `eventWindows:[{eventWindowId, eventTemplateId, countdownBeginTime, beginTime,
     endTime, round:0, visibility:"public", requireAllTokens:[], requireAnyTokens:[], …}]`. Return
     `templates:[{eventTemplateId, playlistId, matchCap, scoringRules:[…]}]`.
   - **Content page:** add `tournamentinformation.tournament_info.tournaments[{tournament_display_id:
     <displayDataId>, title_line_1, title_line_2, schedule_info, poster_front_image, playlist_tile_image,
     flavor_description, details_description, short_format_title, long_format_title, colours…}]`.
   - **Matchmaking:** parse the 6-part bucket, keep `eventId:windowId` on the session, and route by the
     template's playlist.
   - **Leaderboards:** serve them from `match_participants`, which is host-reported and untrusted
     (anticheat Rule C), so present scores as informational only.
   - **Settle by experiment:** whether 7.40 renders a tile for a Nova-built event, and which fields it
     rejects, is UNKNOWN. Serve one event and one malformed control, then compare.
3. **The world itself:** the Reboot `match-config` directive (§A.4).

#### B.3.2 An announcement appearing in-game

| Where the player sees it | Field | Change |
|---|---|---|
| Login MOTD and news screen | `battleroyalenews.news.messages[{ _type:"CommonUI Simple Message Base", title, body, image, hidden:false, messagetype:"normal", spotlight }]` | **Fix the key** (`motds` → `messages`). Can keep `motds` alongside for later builds via the version router |
| Lobby banner (urgent) | `emergencynotice.news.messages[{ _type, title, body, hidden:false }]` | fill from the active announcement with `surface='ingame_emergency'` |
| Login popup text | `loginmessage.loginmessage.message{title, body}` | fill from `surface='ingame_login'` |
| Matchmaking screen header | `playlistinformation.frontend_matchmaking_header_text` (+ `_style`) | short event line, e.g. "Community pick: Blitz, until Sunday" |
| Tournament poster | `tournamentinformation` | event art |

7.40 polls the content page about 85 times a session, so a new announcement appears within the poll
interval with no push. CONFIRMED that the client polls often; the exact interval is UNKNOWN.

**Settle with one session and a control:** serve `news.messages` with text A and `news.motds` with
text B, screenshot the login MOTD, and only A should render.

#### B.3.3 A vote winner becoming the featured mode in the client's mode select

Everything below has to change together. Doing only the first two gives a tile that leads to a Solo
match.

1. **Hotfix, the client side** (INFERRED: struct names confirmed in 7.40, owner and section from 10.40,
   UE `!`/`+` array syntax). Generate the `FrontEndPlaylistData` block of `DefaultGame.ini` from
   `rotationAt(now)`, merged into the existing `[/Script/FortniteGame.FortGameInstance]` section:
   ```ini
   [/Script/FortniteGame.FortGameInstance]
   bBattleRoyaleMatchmakingEnabled=true
   !FrontEndPlaylistData=ClearArray
   +FrontEndPlaylistData=(PlaylistName=Playlist_DefaultSolo, PlaylistAccess=(bEnabled=True, bIsDefaultPlaylist=True,  bVisibleWhenDisabled=False, bDisplayAsLimitedTime=False, DisplayPriority=0,  CategoryIndex=0))
   +FrontEndPlaylistData=(PlaylistName=Playlist_Blitz_Solo,   PlaylistAccess=(bEnabled=True, bIsDefaultPlaylist=False, bVisibleWhenDisabled=False, bDisplayAsLimitedTime=True,  DisplayPriority=10, CategoryIndex=1))
   ```
   `getCloudstorageFiles()` and the file route must hash and serve the **composed** content
   (`cloudstorage.routes.ts:239`), or the client keeps its cached copy. The client re-lists hotfixes
   107 times a session (CONFIRMED). Whether it re-applies `FrontEndPlaylistData` mid-session or only at
   next login is UNKNOWN; test it. Note that `ClearArray` removes the shipped defaults, so the generator
   must list every mode Nova wants shown.
2. **Content page:** a `playlistinformation.playlists[]` entry for the winner with `image` (Cobalt-routed
   URL), `description`, `display_name`, `violator` (e.g. "COMMUNITY PICK"; Nova's own wording, not Epic
   art) and `special_border`.
3. **Matchmaking:** keep routing by playlist (already done). Record demand per playlist (already
   `matchmakingStarted(playlist, region)`).
4. **Host election and the agent:** the agent's `should-i-serve` verdict must carry *which* playlist to
   host. `host.rs` registers that playlist instead of `"*"`, and `useLauncher.ts` stops hard-coding
   DefaultSolo. With `'*'` hosts and one featured mode, a simpler first step also works: the coordinator
   tells every host which single non-default playlist is current.
5. **Reboot:** fetch `playlist=` from `match-config` (§A.4) before `FindObjectSlow`. Validate that it
   starts with `/Game/Athena/Playlists/` and resolves; fall back to DefaultSolo. Add the
   `StaticLoadObject` fallback (§A.5). Rebuild, then `node tools/stage-cobalt.mjs reboot --check`.
6. **Allowlist:** a vote may only offer playlists that have been verified in a played Reboot match.
   Duos and Squads need team assignment (report 03). Respawn, Disco and Barrier need mode logic Reboot
   may not have. Keep the list in config (`COMMUNITY_PLAYABLE_PLAYLISTS`) with the short-name → asset
   path map, e.g. `Playlist_Blitz_Solo` → `/Game/Athena/Playlists/Blitz/Playlist_Blitz_Solo` (paths
   from the pak index).
7. Optional: `client-matchmaking.state.region.<R>.EventFlagsForcedOff: ["Playlist_X"]` turns a
   playlist off per region without a hotfix. INFERRED from Calendar.md, where playlist names appear in
   `eventFlagsForcedOff`.

---

## Part C — The community layer

### C.1 Where it lives

- **Coordinator only.** The host agent runs the same backend binary with `NOVA_COORDINATOR` set, and
  game traffic already reaches the coordinator through nova-proxy. Gate the scheduler and all write
  routes on `NOVA_COMMUNITY_AUTHORITY=1`, which only the coordinator sets. Standalone/LAN mode
  (`NOVA_COORDINATOR` unset) sets it implicitly so a single-PC install still works.
- **Storage:** `nova.db` (better-sqlite3, WAL), next to `accounts`. Add an exported `rawDb()` accessor
  in `database.ts` and use prepared statements and `db.transaction()` directly in a new
  `services/community/community.store.ts`, the way `doctor.store.ts` does. The 78 sites of the sql.js
  shim are not needed here.
- **Modules:** `services/community/{community.store, rotation, scheduler, projections, admin.routes,
  player.routes, dashboard}.ts`. `projections.ts` is the only place that knows the game's shapes
  (hotfix, content page, timeline, events download, match-config).
- **Deploy notes from memory:** content-diff the coordinator after deploy (nova-coordinator-deploy),
  restage the host payload (`tools/stage-backend.mjs`), and restage Reboot. The "built here, loaded
  from there" bug has bitten three components already.

### C.2 Data model

```sql
-- Admin-defined events. Times are ISO-8601 UTC TEXT, like the rest of nova.db.
CREATE TABLE IF NOT EXISTS community_events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',                 -- plain text; launcher renders, never as HTML
  kind TEXT NOT NULL CHECK (kind IN ('ltm','tournament','world','live_event','social')),
  status TEXT NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','scheduled','live','ended','archived','cancelled')),
  starts_at TEXT, ends_at TEXT,
  featured_playlists TEXT NOT NULL DEFAULT '[]', -- JSON, each must be in COMMUNITY_PLAYABLE_PLAYLISTS
  timeline_flags TEXT NOT NULL DEFAULT '[]',     -- JSON EventFlag.* active during the window
  gameserver_directives TEXT NOT NULL DEFAULT '{}', -- JSON → match-config (event, event_phase, snow…)
  showdown TEXT,                                 -- JSON tournament display + template, NULL = no in-game tile
  image_media_id TEXT, tile_media_id TEXT,
  build_scope TEXT NOT NULL DEFAULT '7.40',      -- which builds see it (cross-version)
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT,
  rev INTEGER NOT NULL DEFAULT 1,                -- optimistic concurrency for PATCH
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_cev_window ON community_events(status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS community_announcements (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES community_events(id),
  surfaces TEXT NOT NULL DEFAULT '["launcher"]', -- launcher | ingame_news | ingame_emergency | ingame_login | mm_header
  title TEXT NOT NULL, body TEXT NOT NULL, media_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT NOT NULL, ends_at TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS community_media (    -- art served at /nova/api/community/media/:id
  id TEXT PRIMARY KEY, mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  bytes BLOB NOT NULL, width INTEGER, height INTEGER, sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Participation is SERVER-OBSERVED (an authenticated matchmaking ticket for a featured playlist inside
-- the window), plus an optional RSVP from the launcher. Never taken from host-reported results.
CREATE TABLE IF NOT EXISTS event_participation (
  event_id TEXT NOT NULL REFERENCES community_events(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  rsvp_at TEXT, first_ticket_at TEXT, last_ticket_at TEXT, tickets INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, account_id)
);

CREATE TABLE IF NOT EXISTS community_votes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('feature_playlist','activate_event','unvault_item','generic')),
  status TEXT NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','scheduled','open','closed','needs_decision','applied','cancelled')),
  opens_at TEXT NOT NULL, closes_at TEXT NOT NULL,
  eligibility TEXT NOT NULL DEFAULT '{"minAccountAgeDays":7,"minPlayDays":2,"minTickets":3}',
  results_visibility TEXT NOT NULL DEFAULT 'after_close' CHECK (results_visibility IN ('live','after_close')),
  apply_action TEXT NOT NULL DEFAULT '{}',       -- {"durationHours":168,"slot":"ltm"} etc.
  apply_delay_minutes INTEGER NOT NULL DEFAULT 60, -- review window before auto-apply
  tie_break TEXT NOT NULL DEFAULT 'admin' CHECK (tie_break IN ('admin','first_listed')),
  winner_option_id TEXT, closed_at TEXT, applied_at TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), rev INTEGER NOT NULL DEFAULT 1,
  CHECK (closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS vote_options (
  id TEXT PRIMARY KEY, vote_id TEXT NOT NULL REFERENCES community_votes(id),
  label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', media_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',            -- {"playlist":"Playlist_Blitz_Solo"} | {"eventId":"…"} | {"item":"DrumGun"}
  sort INTEGER NOT NULL DEFAULT 0
);

-- Frozen when the vote OPENS. Accounts created or activated after that cannot vote.
CREATE TABLE IF NOT EXISTS vote_electorate (
  vote_id TEXT NOT NULL REFERENCES community_votes(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT NOT NULL,                          -- e.g. "age=41d playDays=9 tickets=57"
  PRIMARY KEY (vote_id, account_id)
);

-- One ballot per account: the primary key IS the rule. Changing your mind overwrites; it never adds.
CREATE TABLE IF NOT EXISTS vote_ballots (
  vote_id TEXT NOT NULL REFERENCES community_votes(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  option_id TEXT NOT NULL REFERENCES vote_options(id),
  weight REAL NOT NULL DEFAULT 1,
  voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT,
  cast_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (vote_id, account_id)
);

-- What is featured, and why. The single input to rotationAt(now).
CREATE TABLE IF NOT EXISTS rotation_overrides (
  id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, slot TEXT NOT NULL DEFAULT 'ltm',
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  source TEXT NOT NULL,                          -- vote:<id> | event:<id> | admin
  display TEXT NOT NULL DEFAULT '{}',            -- violator, description, media id, priority
  created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT
);

-- Anti-abuse signal recorded at ticket issuance (requireAuth'd), one row per account per UTC day.
CREATE TABLE IF NOT EXISTS play_days (
  account_id TEXT NOT NULL, day TEXT NOT NULL, tickets INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL, before_json TEXT, after_json TEXT, at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`community_revision` is an integer kept in `global_config` and bumped on every committed change. It
is the ETag for the feed and the cache key for the generated hotfix and content page.

### C.3 Admin API

All routes use `adminOk(request)` (`diagnostics.routes.ts`), which fails closed when
`NOVA_AC_ADMIN_SECRET` is unset and accepts the HttpOnly `SameSite=Strict` cookie or `x-nova-admin`.
Writes require `content-type: application/json` (CSRF belt-and-braces on top of SameSite). PATCHes
carry `rev`, and a mismatch returns 409. Every write lands in `admin_audit`. There is a single shared
secret, so `actor` is self-asserted via an optional `x-nova-admin-name`. Named admin keys
(`NOVA_ADMIN_KEYS=name:secret,…`) would make it real; that is a small change to `adminOk`.

| Method + path | Body / result |
|---|---|
| `GET /nova/api/admin/community` | server-rendered dashboard, same no-CDN approach as `/nova/api/dashboard`. **Add the path to the login `next` allowlist regex** (`diagnostics.routes.ts`, `/^\/nova\/api\/(dashboard\|doctor\/…)$/`) |
| `GET  /nova/api/admin/community/events?status=` | list |
| `POST /nova/api/admin/community/events` | create a draft `{slug, title, summary, body, kind, featuredPlaylists, timelineFlags, gameserverDirectives, showdown, buildScope}`. Validates playlists against the allowlist and flags against a per-build known list |
| `PATCH /nova/api/admin/community/events/:id` | `{rev, …fields}` |
| `POST /nova/api/admin/community/events/:id/schedule` | `{startsAt, endsAt}` → `scheduled`. Refuses overlap with another event featuring the same slot unless `force` |
| `POST …/events/:id/{start-now,end-now,cancel,archive}` | manual transitions (archive = read-only, kept for history) |
| `GET  …/events/:id/participation` | `{rsvps, players, tickets, byDay[]}` |
| `POST /nova/api/admin/community/announcements` / `PATCH …/:id` / `DELETE …/:id` (soft) | `{surfaces[], title, body, mediaId, priority, startsAt, endsAt, eventId?}` |
| `POST /nova/api/admin/community/media` | image upload (PNG/JPEG/WebP, ≤ 2 MB, dimensions checked) → `{id, url}` |
| `GET/POST/PATCH /nova/api/admin/community/votes[/:id]` | `{title, description, kind, opensAt, closesAt, eligibility, resultsVisibility, applyAction, applyDelayMinutes, tieBreak, options:[{label, description, mediaId, payload}]}` |
| `POST …/votes/:id/{open-now,close-now,apply,cancel,decide}` | `decide {optionId}` resolves `needs_decision`. `apply` skips the delay |
| `GET  …/votes/:id/results` | full tally including voided ballots and audit flags (§C.8) |
| `POST …/votes/:id/ballots/:accountId/void` | `{reason}`, before apply only |
| `GET/POST/DELETE /nova/api/admin/community/rotation` | inspect `rotationAt(now)`, add or revoke a manual override |
| `GET /nova/api/admin/community/preview?build=7.40` | the exact hotfix, content page, timeline, events download and match-config the game would receive **now** (or `?at=`). This is the operator's check before a change goes live |

### C.4 Player and game API

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /nova/api/community/feed` | optional bearer (`requireAuth` semantics if present) | `{revision, now, live[], upcoming[], recent[], announcements[], votes[{…, myBallot?, results?}], rotation:{featured[]}}`. ETag = revision |
| `GET /nova/api/community/events/:slug` | none | detail + public participation count |
| `POST /nova/api/community/events/:id/rsvp` | bearer | toggle |
| `GET /nova/api/community/votes/:id` | optional bearer | options; results only if `live` or closed; `eligible` + reason for the caller |
| `POST /nova/api/community/votes/:id/ballot` | **bearer** | `{optionId}` → `{ok, changed}`. 403 `not-eligible` with reason; 409 `closed` |
| `GET /nova/api/community/since?rev=N` | none | long-poll / poll fallback (the `diagnostics/since` pattern), because SSE is known to be buffered on some tunnel routes |
| `GET /nova/api/community/media/:id` | none | art. `Cache-Control: public, max-age=86400, immutable`. Also used by the in-game content page via the Cobalt-routed host |
| `GET /nova/api/gameserver/match-config?port=` | register secret / loopback (like the locker bridge) | plain `key=value` for Reboot (§A.4) |

**Casting a ballot**, atomic, inside one `db.transaction`:

```sql
-- 1. the vote is open right now and the caller is in the frozen electorate
SELECT 1 FROM community_votes v JOIN vote_electorate e ON e.vote_id = v.id
 WHERE v.id = :vote AND e.account_id = :acct AND v.status = 'open'
   AND :now >= v.opens_at AND :now < v.closes_at;
-- 2. the option belongs to this vote
SELECT 1 FROM vote_options WHERE id = :opt AND vote_id = :vote;
-- 3. one ballot per account: insert or overwrite, never a second row
INSERT INTO vote_ballots (vote_id, account_id, option_id) VALUES (:vote, :acct, :opt)
ON CONFLICT (vote_id, account_id) DO UPDATE SET option_id = excluded.option_id, updated_at = datetime('now');
```

**Live results:** `SELECT option_id, SUM(weight), COUNT(*) FROM vote_ballots WHERE vote_id=? AND
voided=0 GROUP BY option_id`, cached for 5 s per vote. Counts are shown only when
`results_visibility='live'`, so a bandwagon cannot form before close.

### C.5 Scheduler and applying the winner

There is one `setInterval` every 15 s on the authority, and it also runs once at boot to catch up after
downtime. Each transition is one transaction with a status guard in the `WHERE` clause, so a double run
or a crash mid-tick cannot apply twice.

```
events:  scheduled → live   when starts_at <= now     (bump revision)
         live      → ended  when ends_at   <= now     (bump revision)
votes:   scheduled → open   when opens_at  <= now     → INSERT INTO vote_electorate SELECT … (the snapshot, §C.8)
         open      → closed when closes_at <= now     → tally (non-voided):
                       winner unique             → winner_option_id, apply_at = closes_at + apply_delay
                       tie, tie_break=first_listed → lowest sort wins
                       tie, tie_break=admin        → status needs_decision (nothing applied)
         closed    → applied when apply_at <= now AND applied_at IS NULL:
                       feature_playlist → INSERT rotation_overrides(playlist, starts_at=now,
                                          ends_at=now+durationHours, source='vote:<id>', display)
                       activate_event   → schedule the linked community_event for [now, now+duration]
                       unvault_item     → gameserver_directives.unvault=<item> on the linked event (8.51 builds)
                       UPDATE … SET status='applied', applied_at=now WHERE id=? AND applied_at IS NULL
                       admin_audit(actor='scheduler'), bump revision
```

Once the revision bumps, nothing else needs a push. The next hotfix list, content-page poll, timeline
poll, feed poll and Reboot `match-config` fetch all read the new rotation. The worst-case delay is the
client's hotfix re-application behaviour (B.3.3, UNKNOWN) plus the current match's length on the game
server, which picks it up at the next match.

**`rotationAt(now)`** = the base list (config, initially `[Playlist_DefaultSolo]` until team assignment
is verified) + playlists of `live` events + unrevoked `rotation_overrides` covering `now`, ordered by
priority. It returns `{base[], featured[{playlist, source, until, display}], forcedOff[]}`. It is a
pure function of the database and the time, which makes it unit-testable with fixed clocks. It is the
only input to:

| Projection | Output |
|---|---|
| hotfix | `FrontEndPlaylistData` block (B.3.3-1); `bEnableShowdown` when any live event has `showdown` |
| content page | `playlistinformation`, `tournamentinformation`, `battleroyalenews.messages`, `emergencynotice`, `loginmessage`, `frontend_matchmaking_header_text` |
| timeline | live events' `timeline_flags` with real windows, future `states[]`, `cacheExpire` = next boundary |
| events download | Showdown events and templates for `live` and `scheduled` events with `showdown` |
| matchmaking / election | demand keyed by playlist; host verdict includes the playlist |
| `match-config` | `playlist=` (featured or base, per the elected host's assignment) + event directives |

Tests to add, matching the repo's golden-test style: a fixed-clock scheduler run (double tick is
idempotent; boot catch-up applies once); a tie → `needs_decision`; a ballot after close → 409; an
account outside the electorate → 403; and a 7.40 golden test that the content page carries
`news.messages` and that the hotfix is byte-stable for a given revision.

### C.6 How the launcher shows it

The launcher has no events, votes or news UI today (00 audit). `getNews()` exists in `novaApi.ts:310`
but no screen calls it. Proposal for `Home.tsx` and a new `Community` screen:

- **Live now** card: title, "ends in", featured modes and art. The copy says to pick the mode in the
  game; the launcher cannot preselect a playlist inside the client.
- **Up next:** a schedule list in the player's local time, with an RSVP toggle.
- **Vote** card: options with art. Before voting, show eligibility and its reason ("Play on 2
  different days to vote"). After voting, show "You voted X · change until …". Show bars only when
  `results_visibility='live'` or after close.
- **Announcements** replace `news.json`, with the same `surfaces` filter (`launcher`).
- Polling: `GET /nova/api/community/feed` every 60 s with `If-None-Match`, plus once on focus. The
  data is small and changes rarely.
- Constraints from earlier decisions (memory: nova-launcher-ui): **amber `--beacon` stays reserved for
  "your PC is hosting"**, so events use the cold palette. `MotionConfig reducedMotion="user"` covers
  any new motion. Contrast is computed, not eyeballed. Bundled fonts, no CDN. Building these screens
  falls under the mandatory web/UI skill pipeline in the user's CLAUDE.md; this report only specifies
  the data.

### C.7 Anti-abuse: what "one vote per account" means here

**Facts (CONFIRMED from source):**

- `POST /nova/api/launcher/register` has no email verification, no CAPTCHA and no registration
  throttle. The only limiter is on failed **logins**, keyed by login name.
- Every request reaches the coordinator through Tailscale Funnel, so **all players share one source
  address** (comment in `launcher.routes.ts`). Per-IP limits are impossible by construction.
- The doctor's `players.machine` is client-reported, so it can be spoofed.

**Consequence:** the primary key on `(vote_id, account_id)` stops one *account* voting twice. It does
nothing against one *person* with a script registering 500 accounts after the vote is announced.
Without further rules, a Nova vote is a poll of accounts, not of people.

**Mitigations, strongest first:**

1. **Snapshot the electorate when the vote opens** (`vote_electorate`). Eligible accounts are older
   than N days, with at least M authenticated matchmaking tickets on at least K distinct days, from
   the new `play_days` table (written at ticket issuance behind `requireAuth`, not from host-reported
   results). Accounts created or activated after the announcement cannot vote at all. Defaults: 7
   days, 2 play-days, 3 tickets.
2. **Review window before auto-apply** (`apply_delay_minutes`, default 60). The results page flags
   ballots from accounts created within X days of `opens_at`, accounts sharing a `machine` value,
   bursts of ballots within seconds, and accounts whose only play-days fall inside the vote window.
   An admin can void ballots, or `cancel`, before apply.
3. **Results hidden until close** by default, to blunt bandwagoning and to stop a cheater seeing how
   many alts they need.
4. **Optional tailnet tie-in.** Playing a match already requires tailnet membership, because the game
   socket only works over the tailnet (ARCHITECTURE §1). If the tailnet uses device approval,
   "accounts seen in a match from a distinct tailnet node" is a person-level signal the admin
   controls. INFERRED: it depends on the tailnet's configuration, and needs the gameserver to report
   joining tailnet IPs, which is Reboot work.
5. Per-account ballot rate limit (e.g. 10 changes/min), an audit row for every change, and no API
   that enumerates other people's ballots.

Say it plainly in the UI and the admin docs: a vote measures "active Nova accounts at the time the
vote opened". A determined person who keeps alts genuinely active can still outvote others. The
review window and the admin's veto are the remedy, not the database.

### C.8 Phased plan

| Phase | Scope | Native work? | Effort | Verification (positive + control, same run) |
|---|---|---|---|---|
| **1** | Fix `news.motds` → `news.messages`; announcements table + admin CRUD; content-page projection (news, emergency, login, header); launcher feed + Announcements | no | S | Screenshot the 7.40 login MOTD with text A in `messages` and B in `motds`; only A shows |
| **2** | Events CRUD + scheduler + timeline windows + `play_days` + participation; launcher Live/Upcoming | no | M | Fixed-clock tests; a timeline captured before and after a boundary |
| **3** | Votes + electorate snapshot + auto-apply into `rotation_overrides`; dynamic `FrontEndPlaylistData`; `playlistinformation` | no | M | Enable `Playlist_Blitz_Solo` and leave `Playlist_Sneaky_Solo` off as the control; screenshot the mode select; check `FortniteGame.log` for the hotfix being applied |
| **4** | Featured mode actually hosted: `match-config` endpoint, Reboot playlist fetch + load fallback, host agent registers its playlist, launcher stops hard-coding Solo | **Reboot + launcher** | M–L | A played match in Blitz shows Blitz rules (storm timings) while a Solo match in the same session stays Solo; `cobalt.log` "Setting playlist to: Playlist_Blitz_Solo" |
| **5** | Showdown integration (events download, `tournamentinformation`, `bEnableShowdown`, 6-part bucket) | no | M | Does the tile render? One valid event + one deliberately malformed control |
| **6** | 7.40 world events: read `BP_S8LeadupEvents` / `BP_CalendarProps` assets; snow; S8 lead-up phases via flags or `match-config` | Reboot (maybe none for props) | M, measurement first | Cracks visible in a match with the flag/directive on, absent with it off |
| **7** | Historical events on other builds: the A.4 trigger table, gated on report 02's build work | Reboot + Cobalt | L per build | per event |

### C.9 Still UNKNOWN, and what settles each

| Unknown | Settled by |
|---|---|
| Does 7.40 re-apply `FrontEndPlaylistData` mid-session or only at login? | Phase 3 experiment |
| Does the 7.40 Showdown UI accept a Nova-built event, and which fields are required? | Phase 5 experiment with a control |
| Which flags drive `BP_CalendarProps*` / `BP_S8LeadupEvents`? | UAssetAPI read of those assets |
| Are LTM playlist objects loaded in the server process before travel? | one Reboot log line (§A.5) |
| Does the content-page `image` URL go through hooked curl (Cobalt-routed art)? | `cobalt.log` shows the media path |
| Does a global-chat MUC message render in the 7.40 BR lobby? | one session |
| Exact per-event retail flag names for 4.5–20.40 | the same asset read, per build. Not needed for the OGFN-style trigger |

---

## Sources

- Nova source: `Project-Reboot-DLL/Project Reboot/events.cpp` (`HasEvent` :4, `LoadEvent` :70,
  `StartEvent` :225, `GetEventPlaylistName` :666, `Unvault` :702), `calendar.cpp`, `processevent.cpp`
  (:207, :452, :550–618, :666–669), `dllmain.cpp` (:537, :601), `definitions.h` (:25, :132),
  `gui.h` (:252, :770–803, :1263); `Main backend/src/services/social/social.routes.ts` (:421, :429,
  :481–571, :575–691); `services/nova/news.ts`, `nova.routes.ts:146`; `services/cloudstorage/
  cloudstorage.routes.ts:239`; `services/matchmaking/matchmaking.routes.ts` (:882, :927–995);
  `services/auth/launcher.routes.ts` (:64–128); `services/nova/diagnostics.routes.ts` (`adminOk`,
  dashboard login); `Launcher/src-tauri/src/host.rs:205,233`; `Launcher/src/useLauncher.ts:27`;
  `Launcher/cobalt/Cobalt/curlhook.h:93-104`.
- 7.40 client measurements: `tools/binscan.js` and `tools/paklist.mjs` runs, 2026-11-08 (raw output in
  the session scratchpad, not committed).
- Upstream Project Reboot (old, Nova's lineage):
  <https://github.com/Milxnor/Project-Reboot/blob/master/Project%20Reboot/events.cpp>
- Project Reboot 3.0:
  <https://github.com/Milxnor/Project-Reboot-3.0/blob/master/Project%20Reboot%203.0/events.h>,
  <https://github.com/Milxnor/Project-Reboot-3.0/blob/master/Project%20Reboot%203.0/gui.h>,
  <https://github.com/Milxnor/Project-Reboot-3.0/blob/master/Project%20Reboot%203.0/calendar.h>,
  <https://github.com/Milxnor/Project-Reboot-3.0/blob/master/Project%20Reboot%203.0/FortGameModeAthena.cpp>
- Erbium: <https://github.com/plooshi/Erbium> (local copy `Documents/backends/_extracted/Erbium-main`:
  `Erbium/Public/Events.h`, `Erbium/Private/Events.cpp`, `FortniteGame/Private/FortGameMode.cpp`,
  `FortniteGame/Private/FortPlayerControllerAthena.cpp`)
- Forge (10.40 game server and SDK dump): <https://github.com/ForgeFN/Forge> (local copy in
  `Documents/backends/Fortnite-GS-Archive-release3/Forge (10.40)`)
- LawinServer timeline flag lists (Nova's season-7/8 flags come from here): local
  `LawinServerV3-main backend code reference/routes/timeline.js`; upstream <https://github.com/Lawin0129/LawinServer>
- FortniteEndpointsDocumentation: <https://github.com/LeleDerGrasshalmi/FortniteEndpointsDocumentation>
  (`EpicGames/EventsService/Events/Data/Download.md`, `EpicGames/FN-Service/Game/Calendar.md`)
- Season 7 → 8 lead-up coverage: <https://www.pcgamesn.com/fortnite/fortnite-earthquakes>,
  <https://www.dexerto.com/fortnite/every-fortnite-earthquake-crack-so-far-366636>,
  <https://fortnitenews.com/fortnite-season-7-cracken-event>
