# ROADMAP

How Nova goes from "one player can almost play Solo on 7.40" to the ecosystem in the 2026-11-08
directive (every mode, a real locker, friends and parties, voice, events and voting, Chapters 1–4).
Ordered by what blocks what, then by player impact over effort. Each step ends in something a person
can check in a played session; nothing is called done before that. Status per feature:
`FEATURES.md`. Evidence: `docs/research/00`–`05`.

**Ground rules that shape the order**
- Nova runs the real game. In-game features are fixed by answering the game's services correctly;
  the launcher is Nova's own design and never copies Epic's art or branding.
- Seasons other than 7.40 need that build on disk; nothing is built or claimed for a build nobody has.
- Two-player features (parties, duos, voice) need a second machine, so they get dedicated test sessions.
- Launcher UI work follows the design pipeline in the user's CLAUDE.md (design direction, components,
  review gates) before it is called finished.

---

## Phase 0 — Ground truth · DONE 2026-11-08

Five research reports, a codebase audit, `FEATURES.md`, this file. Found on the way and fixed: the
phantom host player, 45s pre-inject sleep, lobby pre-warm, 30 Hz net, quickbar gate (1.9.5–1.9.6).
Found and waiting on the user: the public JWT secret (fix written; rotating it signs everyone out).

## Phase 1 — Make 7.40 actually playable and complete

Order matters: nothing else is testable until a player gets past the loading screen.

| Step | Work | Size | Proof |
|---|---|---|---|
| **0** | ~~Loading screen~~ **FIXED in 1.9.7** (Cobalt hook). Remaining: retest XMPP online with 1.9.7 and restore 3551 if it holds; turn the bumper on once and confirm | S | `Hiding loading screen` after `Welcomed by server` with XMPP on 3551 |
| ~~0a~~ | ~~Chests~~: not a bug. They open; the warning is the native path reporting "not handled" (FEATURES) | — | — |
| 0b | Rotate `NOVA_JWT_SECRET` on the coordinator (when the user says so) | S | an old-placeholder token is rejected; a fresh sign-in works |
| 1 | Team picker for Solo (each player their own team), plus a `FrontEndPlaylistData` override that only lists modes servers can run | M | two clients in one Solo match can damage each other |
| 2 | Playlist pipeline (backend → host agent → Reboot `Defines::Playlist`), team-based match end, party-aware teams | M | a Duos match puts a party on one team; cobalt.log `Setting playlist to: Playlist_DefaultDuo` |
| 3 | Playground + the loot/settings-only S7 LTMs; re-apply mode rules to each new pawn | S each | the LTM's rules visible in a played match, Solo unchanged in the same session |
| 4 | Social basics: one shared global room, answer every MUC leave, friend requests visible with live notifications, BR news under `messages` | S each | two accounts see each other's request, chat in one room, news text shows in game |
| 5 | Real locker: owned cosmetics generated from the 7.40 pak index (1,219), default pickaxe/glider, migrate stored profiles, Random picks a real item, styles seeded | S–M | wraps/contrails/loading screens equip; no missing-item icons |
| 6 | In-match cosmetics: back bling, glider, contrail applied by Reboot | M | all slots visible in a match |
| 7 | Honest shop: rotation of real 7.40 items; gifting disabled until it works | M | shop shows unowned real items; no fake gift button |
| 8 | Progression: Reboot posts an authenticated match report; XP, level, career stats, recent players; S7 challenges seeded on ClientQuestLogin | L | stats and level change after a match and persist after relaunch |
| 9 | Two-player session (laptop or a friend): parties, invites, whispers, join-a-friend; fix one-account/two-session routing | M | the full party journey works between two PCs |
| 10 | Close the 8 coordinator local-control routes; gameserver registration auth step two | S–M | doctor reports 0 unauthenticated routes |

## Phase 2 — Community: news, events, votes, more modes

From report 05's phased plan, plus the remaining modes from report 03.

1. Announcements: admin CRUD, projected into the game's content page and the launcher (S).
2. Events: CRUD, scheduler, timeline windows, participation; launcher Live/Upcoming (M).
3. Votes: electorate snapshot (accounts with play history), hidden results until close, review window,
   winner applied as a time-limited featured mode in `FrontEndPlaylistData` (M). Depends on Phase 1 step 2.
4. Showdown tiles: the 7.40 tournament UI driven by the events service (M).
5. 50v50 family, Driftin', private matches, then Team Rumble / Disco Domination / Food Fight (M–L).
6. Launcher home dashboard: friends online, party, events, votes, news, live servers, using real data
   only (M), through the design pipeline.
7. 7.40 world events: read `BP_S8LeadupEvents` / `BP_CalendarProps`, drive S8 lead-up cracks and snow
   from the scheduler (M, measurement first).
8. Creative (L).

## Phase 3 — Voice chat in the launcher

From report 04. First a two-machine trial of every unproven point (tailnet ICE, firewall, push-to-talk
latency while the game has focus, mic capture in an elevated WebView2). Then: signaling route
`/nova/voice` on the coordinator (party-scoped, token in the first message), mesh WebRTC over 100.x
addresses, Rust low-level keyboard hook for push-to-talk, WebView2 mic permission scoped to the
launcher's origin, voice screen and settings. Requires Phase 1 step 0b (forgeable tokens) and step 9
(parties between two real players).

## Phase 4 — Seasons, Chapter 1 to Chapter 4

From report 02. **Foundation first:** a multi-build launcher library, version per login session,
matchmaking and the server registry split by build, per-build hotfixes, Cobalt build detection with a
second redirect strategy (string-based, Starfall-style) beside the untouched 7.40 path. Then, one
season at a time, each a release that is played before the next:

1. C1 S7–8 (7.30, 8.51): cheapest proof Cobalt and Reboot work beyond 7.40.
2. C1 S5–6 and S9–10.
3. C1 S3–4.
4. C2 up to 14.x (map name, profile revision rule at 12.20, locker presets).
5. C2 15–18 (party V2 rewrite; Reload's party.js as reference).
6. C3 S1 (19.x: UE5, EOS redirect in Cobalt; 19.01 is the last build with AES keys).
7. C3 S2–4 (Discover playlists, Zero Build).
8. C1 S1–2 (different version detection; low value; can run alongside).
9. C4 (needs a different game server).

## Phase 5 — Historical live events

From report 05 Part A. Each event runs only on its own build (The End 10.40, Astronomical 12.41,
Device 12.61, Galactus 14.60, Collision 20.40, …) with a backend-driven trigger (a `match-config`
endpoint read on the game thread) replacing upstream's manual host button. Gated on Phase 4 reaching
that build; scheduled and voted on through Phase 2.

---

## How progress is tracked

- `FEATURES.md`: a row moves only with evidence, in the same commit as the change.
- `KNOWN_ISSUES.md`: every bug found, with its grade, cause and proof of fix.
- `TEST-REPORT.md`: what was verified, how, and what is still unverified.
- `docs/research/`: the evidence behind the roadmap; superseded findings are corrected in place.
