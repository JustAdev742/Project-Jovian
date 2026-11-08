# 01 — What 7.40 asks Nova for, and where Nova answers wrongly or not at all

*Researched 2026-11-08. Read-only on all source. Measured against: two client sessions and one
headless-server session played today (06:30 UTC and 07:06 UTC), the whole cumulative `cobalt.log`
(2026-07-25 → today), the live coordinator's `nova.log` (2026-07-19 → today, 158,638 lines,
read over SSH with filters only), the shipping 7.40 binary (string scan with `tools/binscan.js`), and
the 7.40 pak index (`tools/paklist.mjs`, index only, 15 main paks, 468,784 entries).*

Evidence grades follow the repo convention: **CONFIRMED** (measured or read directly),
**STRONGLY SUPPORTED** (several independent indicators), **PROBABLE**, **INFERRED**, **UNVERIFIED**.

---

## Summary

**The headline repeated in the docs ("BACKEND-source failures: 0", "34/34 endpoint families
routed") is true, and it is the wrong lens for features.** Every request 7.40 made in 16 weeks got a
2xx. The gaps are not missing routes. They are 200 responses with empty or wrong content, state that
is never created, and feature paths that have never been exercised by two players at once.

What the logs show directly:

1. **Global chat is broken twice.** Each player gets a *private* "global" room
   (`Fortnite_Nova_global_<first 8 of own accountId>`), so nobody can talk to anyone. The room also
   dies 2–3 minutes into every session: the client re-reserves rooms, sends a MUC *leave*, Nova never
   answers leaves for non-`Party-` rooms, and the client's next join fails with today's
   `MUC: JoinPublicRoom failed. Another operation already pending`. This is not the 2026-09-06 bug
   (that was an unanswered *join*). This is an unanswered *leave*.
2. **Friends cannot work through the normal UI.** The friends list endpoint drops all pending
   requests, so a recipient never sees an incoming request. Nova also sends none of the XMPP friend
   notifications the client listens for. Sending a request twice accepts it on the recipient's behalf.
   Since parties, "join friend" and whispers all start from the friends list, this blocks the social
   game.
3. **The Challenges tab is empty and nothing progresses.** There are zero quest, ChallengeBundle or
   ChallengeBundleSchedule items in the athena profile. `ClientQuestLogin` is an alias of
   `QueryProfile`. The 7.40 paks contain six Season 7 schedules, 16 Season 7 bundles and 19 daily
   quests. Nothing produces XP, stats or quest progress either: `/nova/api/match/report` has no
   caller anywhere, and the headless server never calls `EndBattleRoyaleGame`.
4. **71% of the cosmetics Nova grants do not exist in 7.40.** 237 of the 335 granted IDs are absent
   from the 7.40 pak index. Every wrap, loading screen, contrail and music pack Nova grants is
   invented, and so are the seeded default pickaxe and glider. Meanwhile 1,121 of the 1,219 cosmetic
   definitions under `Athena/Items/Cosmetics/` in 7.40 are never granted.
5. **The BR news panel is empty.** Nova sends `battleroyalenews.news.motds`. 7.40 does not contain
   the string `motds` at all; it reads `messages` / `platform_messages`.
6. **Shop:** 10 static offers. 3 of the 10 point at characters that are not in 7.40, all 10 are
   already owned, and gifting is advertised but `GiftCatalogEntry` is a no-op.

**Party is V1 over XMPP only** on 7.40. The binary has no `party/api` and no
`com.epicgames.social.party`, but does have `com.epicgames.party.invitation/joinrequest/...`.
Single-player party plumbing works: create, config, member data and presence publish. Two-player
invite or join has **never been recorded**. In 16 weeks the coordinator saw only 2 XMPP accounts
ever and 10 message stanzas, all `party.leaverequest` to self, with zero chat, zero invitations and
zero join requests. Treat the party, whisper and party-chat rows below as unverified code paths,
not as working features.

Effort key: **S** < 1 day · **M** 1–3 days · **L** > 3 days or crosses components (DLL + backend).

---

## Evidence base, and what each source can and cannot see

| source | span | what it shows | blind spots |
|---|---|---|---|
| `FortniteGame.log` (07:06 UTC), `FortniteGame-backup-2026.11.08-06.34.31.log` (06:30 UTC) | today, 2 client sessions | MCP dispatch lines (only QueryProfile + ClientQuestLogin are logged at this verbosity), chat manager, party OSS, matchmaking WS | no HTTP bodies; most MCP ops are not logged by name |
| `FortniteGame_2*.log` | today, headless server | the server logs in **as the hosting player** and runs its own V1 party (`3A9B1E68…`) | — |
| `cobalt.log` | 2026-07-25 → today, cumulative | every redirected URL (no method, no query string, no body) | XMPP; requests that escape the hook (NOVA-303) |
| coordinator `nova.log` | 2026-07-19 → today | every HTTP request line with query, `[UNHANDLED]`, `[XMPP RX]` (first 300 chars of every inbound stanza, since ~07-25) | responses; outbound XMPP |
| 7.40 binary scan | — | which JSON keys / op names / notification types the client knows | presence ≠ reachable |
| 7.40 pak index | 15 main paks | which cosmetic/quest assets exist | 5 encrypted `pakchunk1000–1004` skipped (secondary keys) |
| coordinator source | — | **byte-identical** to local `Main backend/src` for the 7 files cited below (sha256 compared) | — |

**Never observed in either log, in 16 weeks:** `PurchaseCatalogEntry`, `MarkItemSeen`,
`SetItemFavoriteStatus(Batch)`, `SetBattleRoyaleBanner`, `GiftCatalogEntry`, `RefundMtxPurchase`,
`QueryPublicProfile`, `BulkEquipBattleRoyaleCustomization`, any friend POST/DELETE except 3 audit probes,
any XMPP `type="chat"`/`type="groupchat"` message, any `com.epicgames.party.invitation`/`joinrequest`.
Absence here means "no player has done this", not "it works".

**The coordinator's MCP traffic is ~98% the launcher, not the game.** Of 64,283 `client/QueryProfile`
calls, nearly all alternate athena/common_core with `GET /nova/api/sessions` every ~2 s
(`Launcher/src/novaApi.ts:69`). The game made 358 QueryProfile calls in the whole cobalt.log.

---

## A. Profile core (MCP envelope, profiles)

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `QueryProfile` athena | **implemented** | blob store, `athena.ts:444-455`; era filter `:423-442` | client: `Full profile update (rev=11, version=nova_lawin_ch1s7)`; 358 game calls in cobalt.log | — | — |
| `QueryProfile` common_core | **implemented (stateless)** | rebuilt per call, `rvn: 1` forever, `common_core.ts:64-124` | `Full profile update (rev=1, version=nova_backend)` | purchase history (see C) | — |
| `QueryProfile` common_public | **partial** | banner hard-coded `BRSeason01/DefaultColor1`, `common_core.ts:126-134`; SetBattleRoyaleBanner never writes it | 220 coordinator calls | others see the default banner wherever common_public is read | S |
| other profiles (creative, collection_book_*, theater0, outpost0, metadata, campaign) | **stub** | `QueryProfile.ts:21-38` | 7.40 did not request any of these today | — (out of scope) | — |
| `QueryPublicProfile` | **missing (default empty envelope)** | falls to `mcp.routes.ts:257-268` | in binary (`ascii=2`); 0 calls observed | viewing another player's profile, if any 7.40 path uses it | S |
| `dedicated_server/*` mutating ops (incl. `EndBattleRoyaleGame`) | **refused by design** | `readOnly` guard `mcp.routes.ts:74-77, 296-298` | 1 probe, refused; the headless server never calls it | match-end XP/stats (see D) | — |
| Revision handling | **acceptable on 7.40** | 7.40 reads only `profileChangesBaseRevision` + `profileChanges` (KNOWN_ISSUES `mcp-rvn-from-client`) | — | — | — |

## B. Locker

7.40's own locker path is `EquipBattleRoyaleCustomization` + `SetBattleRoyaleBanner`.
`SetCosmeticLockerSlot`, `SetCosmeticLockerBanner` and `SetItemArchivedStatusBatch` are **absent from
the 7.40 binary** (scan below), so their status does not matter for this build.

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `EquipBattleRoyaleCustomization` (skin/bling/pickaxe/glider/contrail/LS/music, emote slots 0–5, wraps 0–6/−1) | **implemented, persisted** | `athena.ts:473-511`; mirrors LawinServerV3 `mcp.js:996-1197` | 33 in cobalt.log, 52 on coordinator; today's server-side loadout read back `character=CID_175… backpack=BID_003_RedKnight pickaxe=Pickaxe_ID_013_Teslacoil` (cobalt.log 17:32:27) | — | — |
| **Owned item set** | **wrong (CONFIRMED)** | hand-written list, `athena.ts:6-152`; seeded on first access `:254-356` | pak-index diff, table below: **237 of 335 granted IDs do not exist in 7.40**; `version/cosmetics.ts:9` already records "97 in the corpus, 238 not" | blank/missing locker tiles; whole Wraps / Loading Screens / Contrails / Music tabs contain only nonexistent items; 1,121 real 7.40 cosmetics unavailable | S–M |
| Default loadout | **wrong** | `DEFAULT_PICKAXE = Pickaxe_ID_001_Default`, `DEFAULT_GLIDER = Glider_ID_001_Default`, `athena.ts:246-247`; neither exists in paks | pak index has `Athena/Items/Cosmetics/Pickaxes/DefaultPickaxe` and `.../Gliders/DefaultGlider` | new accounts start with a phantom pickaxe/glider equipped | S |
| Styles / variants | **partial (UNVERIFIED impact)** | every item seeded `variants: []` (`athena.ts:261`); `applyVariants` stores any `active` with `owned: []` and no ownership check (`:458-470`); Lawin checks `owned.includes(active)` | no variantUpdates bodies are visible in any log | style picker probably shows non-default styles as locked | M |
| Random (`*_random`) | **partial** | persisted as `AthenaCharacter:cid_random`; `bareId()` maps random to `''` (`athena.ts:186`), so `/nova/api/locker/loadout` returns empty and the gameserver applies nothing | — | "Random" = default skin in match | S |
| `SetBattleRoyaleBanner` | **implemented** (athena stats + locker item) | `athena.ts:581-593`; field names match Lawin | 0 calls observed | — | — |
| `SetItemFavoriteStatus` / `…Batch` | **implemented** | `athena.ts:549-563` | 0 calls observed; both in binary | — | — |
| `MarkItemSeen` | **implemented** | `athena.ts:566-578` | 0 calls (everything is seeded `item_seen: true`) | — | — |
| `BulkEquipBattleRoyaleCustomization` | **missing (no-op default)** | not in switch, `mcp.routes.ts:257` | in binary (`ascii=2 utf16=1`); 0 calls observed | latent | S |
| `SetCosmeticLockerSlot` / `SetCosmeticLockerBanner` | implemented, **N/A on 7.40** | `athena.ts:514-546, 596-610` | ABSENT from 7.40 binary | — | — |
| `SetItemArchivedStatusBatch` (archive) | missing, **N/A on 7.40** | — | ABSENT from 7.40 binary | — | — |
| Loadout presets (`CopyCosmeticLoadout`/`DeleteCosmeticLoadout`) | no-op, **N/A on 7.40** | `mcp.routes.ts:239-240` | ABSENT from 7.40 (KNOWN_ISSUES MCP audit) | — | — |
| In-match application (not backend) | **partial** | DLL fetches only character/backpack/pickaxe, `Project Reboot/helper.cpp:544-550`; backend also returns glider/contrail (`nova.routes.ts:207`) | today: `[Locker] backpack part 0 is not a name (ComparisonIndex 3461523968…)` → `backpack apply FAILED` | back bling, glider and contrail never shown in match | M (DLL) |

**Locker pak diff (CONFIRMED; reproduce with `tools/paklist.mjs` on the 7.40 paks, restricted to
`Athena/Items/Cosmetics/`, plus a case-insensitive set diff against `athena.ts`):**

| list | granted | exist in 7.40 paks | invented / wrong | real 7.40 assets of this type NOT granted |
|---|---:|---:|---:|---:|
| Characters | 154 | 60 | 94 | 268 of 328 |
| Backpacks | 39 | 3 | 36 | 202 of 205 |
| Pickaxes | 35 | 7 | 28 | 143 of 150 (+ `DefaultPickaxe`) |
| Gliders | 26 | 1 | 25 | 120 of 121 (+ `DefaultGlider`) |
| Emotes | 45 | 27 | 18 | 135 of 162 |
| Wraps | 12 | **0** | 12 | 16 of 16 |
| Loading screens | 8 | **0** | 8 | 98 of 98 |
| Contrails | 8 | **0** | 8 | 32 of 32 |
| Music packs | 8 | **0** | 8 | 8 of 8 |
| Sprays / Toys | 0 | — | — | 87 / 12 (never granted) |
| **Total** | **335** | **98** | **237** | **1,121 of 1,219** |

Examples of invented IDs: `CID_053_Athena_Commando_M_SkullTrooper` (Skull Trooper is `CID_030`),
`CID_100_…_CuChuworker`, `Wrap_002_Flames`, `LSID_002_S3`, `Trails_ID_002_Hearts`, `MusicPack_002_S3`,
`EID_Conga` (Season 8). Caveat: the 5 encrypted `pakchunk1000–1004` were not indexed. They hold
items encrypted at 7.40's release and cannot rescue invented names like these.

## C. Shop, purchase, gifting, receipts, entitlements

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `GET /fortnite/api/storefront/v2/catalog` | **partial** | 10 static offers built at module load; 10 fixed skins, 1500 V-Bucks each, `requirements: []` (`storefront.routes.ts:7-13, 75-119`) | client: `RefreshCatalog complete (HTTP 200)`, `(10 total offers)`; 108 game calls | 3 of 10 offers grant CIDs that are **not in 7.40** (`CID_053…SkullTrooper`, `CID_082…Vampire`, `CID_207…BuffCat`); every offer is already owned; no rotation | S |
| `GET /fortnite/api/storefront/v2/keychain` | **implemented (per build)** | `storefront.routes.ts:58-72`, `version/keychain.ts` | 111 calls, 200 | — | — |
| `PurchaseCatalogEntry` | **implemented, never exercised** | server-authoritative price/grants, `mcp.routes.ts:125-199`; grants via `grantAthenaItems` (`athena.ts:619-646`) | **0 calls in 16 weeks** | — (but a purchase is not recorded anywhere, so `mtx_purchase_history.purchases` stays `[]`, `common_core.ts:96`) | S |
| `GiftCatalogEntry` | **missing (silent no-op)** | in the empty-envelope list, `mcp.routes.ts:237`; catalog advertises `giftInfo.bIsEnabled: true` (`storefront.routes.ts:112`) | in binary; `com.epicgames.gift.received` in binary; 0 calls | **gift button shows "sent", recipient gets nothing** | S (disable) / M (implement) |
| `RemoveGiftBox`, `SetReceiveGiftsEnabled` | no-op | `mcp.routes.ts:235-236` | in binary; 0 calls | gift inbox | S |
| `RefundMtxPurchase` | **partial / unsafe** | credits `body.expectedTotalPrice`, never removes the item, `mcp.routes.ts:201-225`; no purchase history exists for the client to list | 0 calls | refunds unreachable; if reached, amount is client-chosen | S |
| `GET /fortnite/api/receipts/v1/account/:id/receipts` | implemented (`[]`) | `social.routes.ts:388` | client: `Validated no receipts`, `Did not redeem any new purchases` | — | — |
| `GET /entitlement/api/account/:id/entitlements`, `/fortnite/api/entitlementCheck` | implemented | `entitlement.routes.ts:10-40`; latent tier-1 204 | 1 and 2 calls | — | — |
| `/fortnite/api/storefront/v2/gift/check_eligibility/...` | unrouted, **N/A on 7.40** | — | ABSENT from 7.40 binary | — | — |
| Battle pass / season storefront | absent, **not needed today** | book is pre-purchased at tier 100 | `BRSeasonStorefront` ABSENT from binary | — | — |

## D. XP, battle pass, quests and challenges

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `ClientQuestLogin` | **partial (alias, grants nothing)** | `mcp.routes.ts:89-96` → `queryAthenaProfile`; KNOWN_ISSUES `clientquestlogin-grants-nothing` | 88 cobalt / 141 coordinator; client dispatch `ClientQuestLogin?profileId=athena&rvn=11` | daily quest grant, weekly unlocks | M |
| Quest / ChallengeBundle / ChallengeBundleSchedule items | **missing (CONFIRMED)** | seed has none, `athena.ts:254-356` | **7.40 paks contain** `ChallengeBundleSchedules/Season7/{Season7_Free, Season7_Paid, Season7_IceKing, Season7_OT, Season7_ProgressiveA, Season7_SgtWinter}_Schedule`, 16 `ChallengeBundles/Season7/QuestBundle_S7_*` (Week_001…010, Cumulative, IceKing, NeonCat, Overtime, SgtWinter, ArcticSniper), 64 files under `Quests/BattlePass/Season7`, 19 under `Quests/DailyQuests`. Binary has `ChallengeBundle` ×136 and `ChallengeBundleSchedule` ×22 | **Challenges tab empty**; skin-progression quests (Ice King, Sgt Winter, Overtime) never shown | M (display) |
| `ClaimQuestReward`, `UpdateQuestClientObjectives`, `FortRerollDailyQuest`, `MarkNewQuestNotificationSent` | missing / no-op | default branch / `mcp.routes.ts:228-229` | all PRESENT in binary; 0 calls (nothing to act on) | quest claim/reroll | M |
| `AthenaPinQuest` / `SetPinnedQuests` | no-op, **N/A on 7.40** | `mcp.routes.ts:230, 247` | AthenaPinQuest ABSENT from binary | — | — |
| Quest progress persistence | **missing (no producer)** | the gameserver DLL calls only `/nova/api/locker/loadout` (only HTTP call found in `Project Reboot/*.cpp`); `dedicated_server` mutations refused | 0 `EndBattleRoyaleGame` / quest updates in 16 weeks | challenges can never complete | L |
| Season XP / level / tiers | **static** | `book_level: 100`, `book_purchased: true`, `level: 100`, `xp: 0`, `book_xp: 0` (`athena.ts:312-331`, `config.ts:52`) | — | XP bar and level never move; there is no write path | M (once stats exist) |
| Match XP calculation | **dead code** | `stats.service.ts` `calculateMatchXp`, only used by `/nova/api/match/report` (`stats.routes.ts:93-142`) | `match/report`: **0 callers in the repo**, 1 hit in 16 weeks of coordinator log (a probe) | XP, stats, match history | L |

## E. Friends

7.40's friends fragments (from the comment at `social.routes.ts:126-129`, re-derived from the binary)
are the `public` forms plus the `v1/{id}/settings` GET. The binary also contains the XMPP notification
types `com.epicgames.friends.core.apiobjects.Friend`, `…FriendRemoval`, `…BlockListEntryAdded`
and the sender name `xmpp-admin`.

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `GET /friends/api/public/friends/:id?includePending=true` | **partial: drops pending (CONFIRMED)** | filters `status === 'accepted'` and ignores `includePending`, `social.routes.ts:55-67`. Lawin returns ACCEPTED plus PENDING/INBOUND plus PENDING/OUTBOUND (`friends.js` `/friends/api/public/friends/:accountId`) | 111 cobalt / 174 coordinator (`?includePending=true` on every call) | **recipient never sees an incoming request**, so accept is impossible from the UI | S |
| `POST /friends/api/public/friends/:id/:friendId` (send / accept) | **implemented, buggy, never exercised** | `social.routes.ts:165-179, 205`. The auto-accept check `theirFriends.find(f => f.friend_id === accountId && f.status === 'pending')` does not check direction, and `addFriend` writes **both** directions (`database.ts:815-821`), so **a second send by A accepts on B's behalf** | 0 calls except 1 audit probe | consent; also no notification to either side | S |
| `DELETE /friends/api/public/friends/:id/:friendId` (remove / decline / cancel) | implemented | `social.routes.ts:181-187, 206` | 0 calls | no `FriendRemoval` push, so the other side stays stale until relog | S |
| `POST/DELETE /friends/api/public/blocklist/:id/:blockedId` | implemented | `social.routes.ts:189-202, 207-208`; blocked users can still send requests (no check) | 0 calls | no `BlockListEntryAdded` push | S |
| `GET /friends/api/public/blocklist/:id` | implemented (`{blockedUsers}`) | `social.routes.ts:83-89` | 108 / 171 calls | — | — |
| `GET /friends/api/v1/:id/settings` | implemented (static) | `social.routes.ts:108-110` | 104 / 166 | — | — |
| `GET /friends/api/public/list/fortnite/:id/recentPlayers` | **stub `[]`** | `social.routes.ts:100-102`; match participants are never recorded (see D) | 105 / 167 | "Recent players" list empty | M |
| Account lookup by display name / bulk | implemented | `compat.routes.ts:33-45`, `auth.routes.ts:281-302` | — | — | — |
| **XMPP friend notifications** (`com.epicgames.friends.core.apiobjects.Friend` / `FriendRemoval` / `BlockListEntryAdded` from `xmpp-admin@prod.ol.epicgames.com`) | **missing (CONFIRMED)** | `sendXmppMessage` exists (`xmpp.server.ts:781-787`) but sends no `from` and is called only by achievements; Lawin sends all three (`structs/friend.js:46-167`) | types PRESENT in binary; client fetches the friends list about once per login (111 GETs / 111 logins) | live friend-list updates; with the pending filter above, requests are invisible until **both** players add each other and relog | S–M |
| Presence exchange on accept | missing | Lawin calls `getPresenceFromUser` both ways on accept | — | a new friend shows offline until the next presence tick or relog | S |
| Friends leaderboard | works mechanically | — | client: `Beginning Friends Leaderboards Query` → `Number of users: 0` | — (needs friends) | — |

## F. Party: V1 over XMPP, the only party system 7.40 has

Binary: `party/api` ABSENT, `com.epicgames.social.party` ABSENT; `com.epicgames.party.invitation`,
`joinrequest`, `joinacknowledged`, `memberjoined`, `memberexited`, `memberpromoted` all PRESENT; `Party-`
PRESENT. Client OSS is `FOnlinePartySystemMcp`.

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| Create persistent party | **works** | client-local + self-presence | `CreateParty request success … state=Disconnected` → `Persistent party state changed to Active` | — | — |
| `UpdateParty` / `UpdatePartyData` / `UpdatePartyMemberData` (SendToParty `com.epicgames.party.data/memberdata/updatepartyconfiguration`) | **works after XMPP login** | relay or echo to self, `xmpp.server.ts:416-434` | 6+7+10 successes; 2 failures per session ~400 ms **before** `OnLoggedIntoXmpp` (client startup race; KNOWN_ISSUES "NOT ours") | — | — |
| `PublishPartyInfoToPresence` | **works** | self-echo `xmpp.server.ts:517-523`; broadcast includes sender `:794-805` | 7 successes, 2 startup failures | — | — |
| Invite (`com.epicgames.party.invitation`) | **implemented relay, UNVERIFIED** | `xmpp.server.ts:425-429` relays to the first client whose bare/full JID matches | **0 in 16 weeks** | party invites | — |
| Join (`joinrequest` → `joinacknowledged` → `memberjoined`) | **implemented relay, UNVERIFIED; PROBABLE defect when the leader hosts** | target resolved by `Clients.find(...)` on bare JID → **first session of that account** (`xmpp.server.ts:425-427`). A hosting player has **two** sessions on one account (client plus headless server, `xmpp.server.ts:144-163`), and the server runs its **own** party (server log: party `3A9B1E68…` vs client party `A49AEFA0…`) | 0 join requests ever | joining a friend who is hosting can reach the wrong process | M |
| Leave (`com.epicgames.party.leaverequest`) | works (echoed to self) | `xmpp.server.ts:430-432` | the only 10 message stanzas ever received | — | — |
| Promote / kick (`memberpromoted`, `memberexited`) | relay, UNVERIFIED | same relay | 0 | — | — |
| Crash cleanup | **partial** | synthesises `memberexited` on socket close, but sends it to **every** online client, not the party (`xmpp.server.ts:670-685`) | — | noise to unrelated players | S |
| Party chat (`Party-<id>@muc…`) join / leave / groupchat | implemented, UNVERIFIED with 2 players | join always answered `:460-500`; leave answered for `party-` rooms `:438-458`; groupchat membership checked **by account** `:405` | 0 groupchat stanzas ever | — | — |
| Party V2 HTTP (`/party/api/v1/Fortnite/...`) | routed but **dead on 7.40** | `social.routes.ts:221-340` | 1 probe in 16 weeks | — | — |
| Voice chat (Vivox) | **broken, not backend-servable as is** | — | `onConnectFailed https://fnwp.www.vivox.com/api2/ couldn't resolve host name (10006)` ×8 per client session | party voice | L |
| Party member "homebase" | **unknown** | — | `Got bad homebase data` ×15 per session even with the self-echo fix | probably cosmetic (STW homebase in party UI) | ? |

## G. Presence

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| Initial presence plus roster replay | implemented | `xmpp.server.ts:540-548` | 72 + 16 registrations | — | — |
| Status updates (lobby / in match / joinable) | implemented, **over-broadcast** | `broadcastPresence` goes to **every** connected client, not friends (`:790-815`) | RX: `"Status":"Battle Royale Lobby - 1 / 4"`, `"Playing Battle Royale - 1 Left"` | privacy; O(n²) at scale | S |
| Multi-session accounts | **PROBABLE defect** | status and `from` resolved **by account only**: `Clients.find(c => c.accountId === accountId)` (`:505`, `:791`) | coordinator RX shows the same account publishing two different presences: `"Status":"","bIsPlaying":true,"bIsJoinable":true,"SessionId":"a7afcb39…"` (headless server) and `"Status":"Playing Battle Royale - 1 / 4","bIsJoinable":false` (client), each with its own `party.joininfodata` | friends see the hosting player's presence and joinable party flip between processes | M |
| `/presence/api/v1/...` HTTP | stubs | `social.routes.ts:346-356` | never called by 7.40 | — | — |

## H. XMPP chat: whisper, party chat, global chat

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `reserveGeneralChatRooms/:subGame/:platform` | **wrong content (CONFIRMED)** | room name is `Fortnite_Nova_global_${accountId.substring(0, 8)}` (`social.routes.ts:727`), so **every player gets their own room**. Key `foundationChatRooms` (`:737`) is not a 7.40 key (binary: `FounderChatRooms` ×2); `bNeedsPaidAccessForFounderChat` / `bNeedsPaidAccessForGlobalChat` / `bIsGlobalChatDisabled` / `bIsFounderChatDisabled` / `bIsSubGameGlobalChatDisabled` are all **PRESENT in the binary and omitted** | client: `Global subgame chat rooms: {Fortnite_Nova_global_03eebb6c,}`; coordinator: JustATester joins `Fortnite_Nova_global_7f0de3ca`, JustADev joins `…_03eebb6c` | **global chat reaches nobody** | S |
| Re-reserve loop | **side effect (INFERRED cause)** | founder fields omitted → `Found Chat Rooms Found, NeedsPaidAccess: 0` → `Retrying Query, Error: No rooms found … Presumed all rooms full` → re-request in 156–183 s | both sessions today; 2026-09-06 session: 159/216/265 s | triggers the leave/join below every few minutes | S (send `bNeedsPaidAccessForFounderChat: true`; verify) |
| MUC **leave** for non-party rooms | **missing (CONFIRMED, today's error)** | `type="unavailable"` is only handled when `to` starts with `party-` (`xmpp.server.ts:438-458`, inherited from Lawin `xmpp.js:259`); other leaves fall through to the status branch and get **no reply**, and membership is not removed | coordinator line 157976: `<presence type="unavailable" to="Fortnite_Nova_global_03eebb6c@muc…/…D4B636BB…"/>` with no rejoin from that resource; client 06:32:26: `LeaveChatRoom … IsInChatRoom: 1` → `MUC: JoinPublicRoom failed. Another operation already pending for room Fortnite_Nova_global_03eebb6c` → `FOnlineChatMcp::JoinPublicRoom - failure` | global chat dead ~2–3 min into every session. **Distinct from the fixed `muc-join-answered-with-silence`** (that was the join) | S |
| MUC join | implemented, always answered | `xmpp.server.ts:460-500` (2026-09-06 fix) | `HandleChannelCreated - Matched my channel, setting State to Joined` | — | — |
| Groupchat delivery | implemented | `:401-415`; per-session delivery | 0 groupchat stanzas ever | — | — |
| Whisper (`type="chat"`) | implemented, UNVERIFIED | `:394-400`; bare-JID match only; first matching session; body ≥ 300 chars silently dropped | 0 chat stanzas ever | whisper to a hosting friend may reach the server process | S |
| Offline messages / history | missing | — | — | — | — |

## I. News and content pages

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `GET /content/api/pages/fortnite-game`: BR news | **wrong key (STRONGLY SUPPORTED)** | news is under `battleroyalenews.news.motds` (`social.routes.ts:491-500`) | binary: `motds`/`Motds`/`MOTDs` **ABSENT**; `platform_messages` PRESENT; Lawin (`contentpages.json`) uses `news.messages` + `platform_messages`; 133 cobalt / 207 coordinator calls, all 200 | **BR news panel empty** | S |
| `subgameselectdata` | missing | not sent | PRESENT in binary; Lawin sends it | subgame-select card text | S |
| `dynamicbackgrounds` (per-build lobby stage) | sent, **inert on 7.40** | `social.routes.ts:523-538` | `dynamicbackgrounds` / `DynamicBackground(s)` ABSENT from binary | — (harmless) | — |
| `emergencynotice`, `loginmessage`, `survivalmessage`, `savetheworldnews`, `playlistinformation`, `tournamentinformation` | implemented (mostly empty) | `social.routes.ts:502-551` | all PRESENT in binary | — | — |
| `/api/v1/fortnite-br/surfaces/motd/target` | stub | `compat.routes.ts` | never called by 7.40 | — | — |

## J. Calendar, timeline, events

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `GET /fortnite/api/calendar/v1/timeline` | **implemented** | per-build season plus S7 LTM flags, `social.routes.ts:575-663` | `Calendar request returned HTTP 200 … Updating channel 'client-matchmaking' / 'client-events'` | — | — |
| `GET /api/v1/events/Fortnite/download/:id` | stub (no events) | `social.routes.ts:421-427` | 66 / 102 calls | in-game tournaments (if 7.40 surfaces them) | M |
| `/api/v1/leaderboards/Fortnite/...` | stub | `social.routes.ts:429-431` | not called | — | — |

## K. Stats and leaderboards

| operation / route | status | Nova evidence | log evidence | blocks | effort |
|---|---|---|---|---|---|
| `GET /fortnite/api/statsv2/account/:id` | implemented, **always zero** | `stats.routes.ts:12-22`; `seedDefaultStats` inserts zeros (`database.ts:672-699`) | 3 calls | career screen permanently zero | L (needs producer) |
| `POST /fortnite/api/statsv2/query` | implemented | `stats.routes.ts:38-51` | 3 / 5 calls | — | — |
| `GET /fortnite/api/statsv2/leaderboards/:name` | implemented, all values 0 | `stats.routes.ts:54-73` | 3 / 5 (`br_placetop1_keyboardmouse_m0_playlist_defaultsolo`, `…defaultduo`) | meaningless leaderboard | (follows producer) |
| `POST /statsproxy/api/statsv2/query` | unrouted | — | 1 `[UNHANDLED]` (origin unknown) | — | S |
| **Stats producer** (`/nova/api/match/report`) | **no caller** | route `stats.routes.ts:93-142`; zero callers in Launcher, Reboot DLL or backend | 1 hit in 16 weeks (probe) | stats, XP, recent players, achievements | L |

## L. Everything else 7.40 calls (healthy, listed for completeness)

Auth (`oauth/token`, `verify`, `sessions/kill`, account lookups), `lightswitch bulk/status`,
`v2/versioncheck`, `enabled_features`, cloudstorage system and user (39 `PUT ClientSettings.Sav`
persisted), `privacy`, `tryPlayOnPlatform`, `grant_access`, `profileToken/verify`, datarouter, and
matchmaking (`ticket/player` → WS `Queued → SessionAssignment → Play` → `matchmaking/session/{id}` +
`/join`) are all routed and answered correctly in today's logs. No game-relevant `[UNHANDLED]` exists
in 16 weeks except `/statsproxy/api/statsv2/query` (1), `/hotconfigs/v2/livefn.json` (1),
`/fortnite/api/discovery/accessToken/Live` (1) and `/content/api/pages/fortnite-game/spark-tracks` (1).
Those last three are later-build endpoints or probes, not 7.40.

---

## Fix first (ranked by player impact ÷ effort)

1. **One shared global room** (S): `social.routes.ts:727`. Use a fixed room name, optionally per
   region. Also send the five `b…` flags and rename `foundationChatRooms` → `founderChatRooms`.
2. **Answer every MUC leave** (S): `xmpp.server.ts:438-458`. Handle `type="unavailable"` for any
   `@muc` room: remove membership, reply with self-presence 110, notify the other occupants. Then set
   `bNeedsPaidAccessForFounderChat: true` and check in one session that the 150–270 s re-reserve loop
   stops (INFERRED).
3. **Make friend requests visible and live** (S–M): return PENDING INBOUND/OUTBOUND rows when
   `includePending=true` (`social.routes.ts:55-67`); fix the direction-blind auto-accept
   (`:169-173`); send `com.epicgames.friends.core.apiobjects.Friend` / `FriendRemoval` /
   `BlockListEntryAdded` from `xmpp-admin@prod.ol.epicgames.com` on every change, and exchange presence
   on accept (Lawin `structs/friend.js` is the template). This unblocks parties, whispers and
   "join friend".
4. **BR news under `messages`** (S): `social.routes.ts:491-500`. Add `platform_messages` and
   `subgameselectdata`.
5. **Regenerate the owned cosmetics from the 7.40 pak index** (S–M): replace `athena.ts:6-152` with
   the real IDs (1,219 definitions under `Athena/Items/Cosmetics/`; generate it the way
   `version/cosmetics.ts` is generated). Seed `DefaultPickaxe`/`DefaultGlider`, migrate stored blobs (drop nonexistent keys,
   remap the defaults), and fix the 3 phantom shop CIDs.
6. **Stop lying about gifting** (S): set `giftInfo.bIsEnabled: false` until `GiftCatalogEntry` is
   real (`storefront.routes.ts:112`).
7. **Random resolves to a real item** (S): `getEquippedCosmetics` should pick an owned item instead
   of `''` (`athena.ts:215-224`).
8. **Show Season 7 challenges** (M): seed `ChallengeBundleSchedule` / `ChallengeBundle` / `Quest` items
   from the pak asset names on `ClientQuestLogin`. The objective `completion_*` names need the quest
   assets parsed; `UAssetAPI-master.zip` is in `Full documentation`.
9. **A stats/XP producer** (L): a match-end hook in the Reboot DLL that posts an authenticated report
   (the route and XP maths already exist); then XP, level, quest progress, recent players and
   leaderboards can follow.
10. **One account, two XMPP sessions** (M): route bare-JID messages and attribute presence to the
    *client* resource, not the first one, or keep the headless server off XMPP presence and party
    entirely (`xmpp.server.ts:425-427, 505, 791`). This needs a two-player test, which nobody has run.
11. Styles: seed `variants[].owned` from the item assets (M). In-match back bling/glider/contrail is a
    DLL fix (M).

---

## Open questions

1. **Has a two-player V1 party ever formed through Nova?** No evidence either way: 2 XMPP accounts
   in 16 weeks, 0 invitations, 0 join requests, 0 chat stanzas. One two-machine session with
   `[XMPP RX]` logging on would settle F, G and H at once.
2. **Does `bNeedsPaidAccessForFounderChat: true` stop the re-reserve retry?** INFERRED from the
   client's log order (`Found Chat Rooms Found, NeedsPaidAccess: 0` immediately precedes
   `Retrying Query`). Needs one session to confirm.
3. **How does 7.40 render an owned item whose asset does not exist:** blank tile, hidden, or log
   spam? The three phantom shop offers raise the same question. Needs one locker screenshot with the
   current seed.
4. **Does the 7.40 style picker require `variants[].owned`?** No variant traffic has been captured.
5. **`Got bad homebase data` ×15 per session**: the self-echo fix did not remove it. Is it STW
   homebase data (harmless) or a party-member field Nova should supply?
6. **What `completion_*` objective names do the Season 7 quests use?** This needs the quest `.uexp`
   parsed. Also: which daily-quest pool does 7.40 expect `ClientQuestLogin` to draw from?
7. **Where should match results come from:** an authenticated `dedicated_server/EndBattleRoyaleGame`
   from the headless server (7.40 has the V1 op), or the Nova custom `/nova/api/match/report`? Either
   way the producer has to be in the DLL.
8. **What is in the encrypted `pakchunk1000–1004`,** and do the two keys served for 7.40 open any of
   them? This affects the "real cosmetics" count in B.
9. **Should the headless gameserver log into XMPP at all?** It creates a party, publishes joinable
   presence and joins global chat as the hosting player.

### Incidental, outside the scope but noticed

- `xmpp.server.ts:281-282` logs the first 300 characters of every inbound stanza, including SASL
  PLAIN `<auth>`. Today that prefix reaches only the account id, the JWT header and part of the
  payload, never the signature. It is one length change away from logging a full bearer token. Redact
  `<auth>` bodies.
- `queryAthenaProfile` can persist on read (`athena.ts:448-453`). With the launcher polling
  QueryProfile every ~2 s (`Launcher/src/novaApi.ts:69`; ~64k calls on the coordinator), every guard
  hit is a disk write.
