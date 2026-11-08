# FEATURES — master checklist

The single list of what Nova does, graded by evidence. **WORKS** = seen working in a played session
or an end-to-end test with real processes. **PARTIAL** = works with stated gaps. **BROKEN** = exists
and fails. **FAKE** = looks like it works and doesn't (a success response with nothing behind it).
**MISSING** = not built. **UNTESTED** = code exists, nobody has watched it work.

Evidence lives in `docs/research/00`–`05` (Phase 0, 2026-11-08) and `KNOWN_ISSUES.md`. Phases refer to
`ROADMAP.md`. Update this file in the same commit as the change that moves a row.

Context that shapes every row: Nova runs the **real** Fortnite client. The game draws its own lobby,
locker, shop, friends list and parties, so most in-game features are fixed by answering the game's
services correctly. The launcher is Nova's own design and does not copy Epic's art or branding.

## 1. Joining and playing a match (7.40)

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| Sign in, launch, reach the lobby | WORKS | played 2026-11-08 | — |
| Host election, on-demand server, P2P over Tailscale | WORKS | played 2026-11-08 | — |
| Lobby pre-warm (server starts before Play) | WORKS | 2026-11-08 1.9.5: elected from lobby, ready, 22s queue | — |
| **Getting past the loading screen after joining** | WORKS (1.9.7) | verified in play 2026-11-08: Athena UI, loading screen dropped, bus, landed. Cause was Cobalt's persistent ProcessEvent hook (KNOWN_ISSUES client-stuck-on-loading-screen) | — |
| Opening chests | WORKS | 2026-11-08: Reboot logged the container opening, quickbar 6 → 7, weapon picked up and fired. The `ServerAttemptInteract … failed` warning is noise: Reboot opens containers itself | — |
| Intro bumper | OFF by default (opt-in) | its hook caused the hang; the hook now disables itself after each task, unverified with the bumper on | P1 |
| In-game chat / party / friend presence | OFF (workaround) | the coordinator points XMPP at a dead port; retest online with 1.9.7 | P1 step 0 |
| Phantom host player removed | WORKS | 1.9.5: "failed to spawn a pawn" for the server's controller | — |
| 60 Hz server updates | UNTESTED | KNOWN_ISSUES server-net-30hz | P1 verify |
| Match stats, XP, level progress recorded | MISSING | no caller of `/nova/api/match/report` (01 §D) | P1 |
| In-match cosmetics: skin, back bling, pickaxe | PARTIAL | `[Locker] backpack apply FAILED`; Random → default skin (01 #10) | P1 |
| In-match glider, contrail | MISSING | Reboot fetches 3 slots only (01 #10) | P1 |

## 2. Game modes

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| Solo, one player | PARTIAL | hosts and runs; the player is stuck on the loading screen (section 1) | P1 |
| Solo, two or more players | BROKEN (probable) | the game's team picker put both players on team 3, and teammates can't damage each other (03; needs a two-client test) | P1 step 1 |
| **Any other mode** | BROKEN | 31/31 hosted matches logged `Playlist_DefaultSolo`: hosts register "*", the launcher hard-codes Solo, nothing sets Defines::Playlist (03, 05 B) | P1 |
| Duos / Squads / Trios | MISSING | needs the playlist pipeline, a party-aware team picker, team-based match end (03) | P1 step 2 |
| Playground + loot-only S7 LTMs | MISSING; closest after Solo | Playground code exists but can't be reached; LTMs are mutator-driven, S each once the pipeline exists (03) | P1 step 3 |
| 50v50 family, Driftin' | MISSING | two buses, min player counts (03) | P2 |
| Private matches | MISSING | client sends `player.option.customKey`, backend ignores it (03) | P2 |
| Team Rumble, Disco Domination, Food Fight | MISSING (L each) | score-to-win rule; no reference server implements it (03) | P2 |
| Creative | MISSING (L) | nothing turns it on; hub level only, no island ownership or saving (03) | P2+ |
| Modes the menu offers vs can run | BROKEN | the `FrontEndPlaylistData` override shows 7 tiles regardless of server capability (03) | P1 step 1 |
| Playlists in the 7.40 build | 124 | pak index = client `Adding Playlist` lines; full list in 03 appendix | — |

## 3. Locker and cosmetics

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| Equip and keep a loadout | WORKS | equipped items applied in match | — |
| **Owned cosmetics match the build** | BROKEN | 237 of 335 granted IDs do not exist in 7.40; 1,121 of 1,219 real cosmetics never granted; default pickaxe/glider missing (01 #6) | P1 |
| Styles / variants owned | PARTIAL | variants not seeded (01 §B) | P1 |
| Favourites, archive, random | UNTESTED | operations accepted; Random resolves to "" (01 #10) | P1 |
| Wraps, loading screens, contrails, music packs | BROKEN | none of the granted IDs exist in 7.40 (01 #6) | P1 |
| Locker presets | MISSING on 7.40 (presets arrive in Chapter 2) | 02 §5.5 | P4 |

## 4. Shop, battle pass, challenges, progression

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| Item shop | FAKE | 10 static offers, all already owned, 3 grant characters not in 7.40 (01 #9) | P1 |
| Gifting | FAKE | button advertised, `GiftCatalogEntry` does nothing (01 #9) | P1 |
| Challenges tab | BROKEN (empty) | no quests or bundles in the profile; 7.40 has 6 S7 schedules, 16 bundles, 19 dailies (01 #4) | P1 |
| XP / level / battle pass tiers | FAKE | level fixed at 100; nothing records progress (01 #5) | P1 |
| Career stats, leaderboards | FAKE | always zero (01 §K) | P1 |

## 5. Friends, parties, chat

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| Friend requests | BROKEN | pending requests hidden; no live notifications; double-request auto-accepts (01 #1) | P1 |
| Parties between two players | UNTESTED | never used by two real players; one account, two XMPP sessions when hosting (01 #8, #10) | P1 |
| Whisper, party chat | UNTESTED | never used (01 summary) | P1 |
| Global chat | BROKEN | per-player room name (`social.routes.ts:727`); dies after 2–3 min because MUC leave is unanswered (01 #2, #3) | P1 |
| Presence (online / in match) | PARTIAL | works for one player; two-player untested | P1 |
| Blocking, reporting | UNTESTED | — | P1 |
| Recent players | MISSING | needs the stats producer (01 #9) | P1 |

## 6. Voice chat

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| In-game voice (Vivox) | MISSING, cannot be emulated | `LogVivoxVoiceChat: onConnectFailed` | — |
| Launcher party voice (WebRTC over the tailnet) | MISSING; designed | 04 | P3 |
| Push-to-talk while the game has focus | MISSING; needs a Rust keyboard hook (Tauri 1 global shortcuts report no key-up) | 04 §5 | P3 |

## 7. News, events, community

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| In-game news | BROKEN | sent as `news.motds`, which 7.40 does not read; it reads `messages`/`platform_messages` (01 #7, 05 B) | P2 (first item) |
| Admin announcements, events, schedules | MISSING; designed | 05 C | P2 |
| Community voting that changes the featured mode | MISSING; designed; needs modes to work first | 05 C.5, C.8 | P2 |
| Showdown / tournament tiles | MISSING; 7.40 has the UI and calls the events service 37×/session | 05 B | P2 |
| Historical live events | MISSING; none are in the 7.40 build; each needs its own build + Reboot | 05 A | P5 |
| 7.40 world events (S8 lead-up cracks, snow, calendar props) | MISSING; assets are in the build, drivers unknown | 05 A.3 | P2/P5 |

## 8. Seasons, Chapter 1 to Chapter 4

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| Backend per-build answers (season, lobby, keys, locker era) | PARTIAL | 4 endpoints vary by build; most C2–C4 rows unknown (CROSS_VERSION_STATUS, 02 §3.1) | P4 |
| More than one build at once | MISSING | one global build id, no build on the server registry, one hotfix set (02 blocker 2) | P4 foundation |
| Launcher build library and season picker | MISSING | one folder path; `_EAC.exe` required, C4 uses `_EAC_EOS.exe` (02 §3.4) | P4 foundation |
| Game server for non-7.40 builds | UNTESTED (Reboot has 1.8–22.40 code, unrun under Nova); C4 needs a different server | 02 blocker 1, 5 | P4 |
| Client redirect for non-7.40 builds | MISSING | Cobalt has one 7.40 pattern; EOS hook is empty (02 §3.3) | P4 |

## 9. Launcher

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| Play, host status, settings, logs, self-check, updates | WORKS | in use | — |
| Fleet doctor + diagnostics sharing switch | WORKS | 1.9.4, dashboard shows live lines | — |
| Home dashboard with friends, party, events, votes, news | MISSING | Home is a play/host screen only (00) | P2 |
| Voice screen | MISSING | — | P3 |

## 10. Platform and security

| Feature | Status | Evidence | Phase |
|---|---|---|---|
| **Login tokens can't be forged** | BROKEN; fix written, needs the secret set on the coordinator | KNOWN_ISSUES jwt-secret-public | now (waiting on the user) |
| Coordinator local-control routes without auth | BROKEN (8 routes) | KNOWN_ISSUES coordinator-local-control-routes-public | P1 |
| Gameserver registration auth | PARTIAL (step one live) | KNOWN_ISSUES gameserver-register-unauthenticated | P1 |
| One account per person (votes, abuse) | MISSING | 05 C.7 | P2 |
| Persistent profiles, locker, friends | PARTIAL | SQLite on the coordinator; progression never written | P1 |
| Tests | WORKS | backend 300, doctor 58, launcher 26, e2e probe, fleet harness; no two-player test exists | every phase |
