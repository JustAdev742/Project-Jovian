/**
 * The compatibility database: what behaviour each build era expects, and how well we know it.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. A feature is *supported* only when its expected behaviour
 * is understood, its version applicability is known, an implementation is present, its failure
 * behaviour is defined, it is tested where possible, and its evidence is recorded. "We wrote some
 * code" is *implemented*, which is a different and much weaker claim. `supportLevel()` computes the
 * distinction mechanically so it cannot be asserted by optimism — see the test file.
 *
 * WHY A TABLE AND NOT `if (version.major >= 11)` SCATTERED THROUGH THE ROUTES. Conditionals spread
 * across 40 files cannot be enumerated, audited, tested as a set, or explained to a future reader.
 * A table can be printed, diffed, and — crucially — checked for whether its confidence justifies the
 * behaviour it drives.
 *
 * WHAT THIS TABLE IS NOT. It is not a claim to have reconstructed Chapters 2-4. Most entries beyond
 * Chapter 1 are `UNKNOWN`, deliberately, because the supplied corpus grades its own Chapter 2-4
 * material as inference with no authoritative citations. An UNKNOWN row is not a gap in the work —
 * it is the work: it names the question, records what would answer it, and stops the backend from
 * quietly serving a guess. See CROSS_VERSION_ARCHITECTURE.md §"What is deliberately empty".
 */

/** How a feature changed at a point in the timeline. The brief's vocabulary, exactly. */
export type ChangeKind =
  | 'ADDED'
  | 'REMOVED'
  | 'RENAMED'
  | 'REPLACED'
  | 'MODIFIED'
  | 'VERSION_SPECIFIC'
  | 'UNKNOWN';

/** Evidence grade. Never silently upgraded — see `assertNoSilentUpgrade` in the tests. */
export type Confidence = 'CONFIRMED' | 'STRONGLY_SUPPORTED' | 'INFERRED' | 'UNKNOWN';

export type Subsystem =
  | 'auth' | 'mcp' | 'friends' | 'presence' | 'party' | 'matchmaking' | 'session'
  | 'cloudstorage' | 'content' | 'quests' | 'playlists' | 'worldstate' | 'events'
  | 'storefront' | 'discovery' | 'telemetry' | 'transport';

export interface TimelineEntry {
  /** The major version at which this change takes effect. `null` = "true as far back as we know". */
  atMajor: number | null;
  change: ChangeKind;
  confidence: Confidence;
  /** WHERE the claim comes from. A row without this is not admissible; the tests enforce it. */
  evidence: string;
  /** For REPLACED/RENAMED — the feature id that supersedes this one. */
  replacedBy?: string;
  detail?: string;
}

export interface FeatureRecord {
  /** Stable id, `subsystem.thing`. Used as a diagnostic key, so it must not churn. */
  feature: string;
  subsystem: Subsystem;
  description: string;
  /** Ordered oldest → newest. `stateAt()` walks it. */
  timeline: TimelineEntry[];
  /** Where the behaviour lives in this repo, if anywhere. Absence means "not implemented". */
  implementation?: string;
  /** What happens when it fails. Required for `supportLevel` to reach SUPPORTED. */
  failureBehaviour?: string;
  /** Test files/names that pin it. Absence means untested. */
  tests?: string[];
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  THE TABLE
//
//  Ordering is by subsystem then feature id. Every row carries evidence. Rows whose confidence is
//  UNKNOWN are the honest majority outside Chapter 1 and are meant to be filled in as evidence
//  arrives, not deleted to make the table look finished.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const FEATURES: readonly FeatureRecord[] = [
  // ── auth ───────────────────────────────────────────────────────────────────────────────────────
  {
    feature: 'auth.oauth.token',
    subsystem: 'auth',
    description: 'POST /account/api/oauth/token — the first call any build makes.',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'Observed 128× in cobalt.log across six 7.40 sessions; documented in EpicResearch docs/auth/grant_types/*.',
    }],
    implementation: 'services/auth/auth.routes.ts',
    failureBehaviour: 'Client cannot pass the splash screen. 401 with an Epic error envelope.',
    tests: ['anticheat.test.ts (token minting used as a fixture)'],
  },
  {
    feature: 'auth.oauth.verify',
    subsystem: 'auth',
    description: 'GET /account/api/oauth/verify — session liveness check.',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'Observed 482× in 7.40 sessions; shape matches FortniteEndpointsDocumentation AccountService/Authentication/Verify.md.',
    }],
    implementation: 'services/auth/auth.routes.ts',
    failureBehaviour: 'Client treats the session as dead and returns to login.',
  },
  {
    feature: 'auth.token.kid',
    subsystem: 'auth',
    description: 'JWT `kid` (key id) header on issued access tokens.',
    timeline: [{
      atMajor: null, change: 'UNKNOWN', confidence: 'CONFIRMED',
      evidence: "Epic's live friends service rejected a Nova token with \"Token is missing key ID value\" (FortniteGame.log, 2026-08-15). That proves EPIC requires it; it does not establish that any Fortnite client does.",
      detail: 'Only observed because a request escaped to Epic — see KNOWN_ISSUES nova-303-request-escape. Nova omits `kid` and 7.40 has never objected.',
    }],
    notes: 'Recorded because it is the one hard fact the escape produced. Do not add `kid` on this basis alone; nothing in Nova needs it.',
  },

  {
    feature: 'auth.clientId.eraSignal',
    subsystem: 'auth',
    description: 'What the OAuth client id in the Basic auth header tells you about the caller.',
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: "EpicResearch docs/auth/auth_clients.md lists 112 clients with ids and secrets, 17 of them Fortnite game clients. The table is partitioned by PLATFORM and storefront region, never by game version — there is one PC game client id for everything, and the words 'chapter' and 'season' do not occur anywhere in that corpus.",
      detail: "So the id gives the platform and NOT the era. The only era signal is a floor inferred from hardware names: a PS5 or Series X client cannot be a 2019 build. That is INFERRED, rules eras out rather than in, and is used only to raise a diagnostic — never to reject a request.",
    }],
    implementation: 'services/version/clients.ts — clientById(), eraConflict()',
    failureBehaviour: 'An unrecognised client id is simply unknown; the request proceeds on the User-Agent alone.',
    tests: ['version.test.ts — client registry and era-floor conflicts'],
    notes: "The useful half of this row is the NEGATIVE result. Era cannot be derived from the client id, so the User-Agent stays the primary signal and no amount of client-id work will change that.",
  },
  {
    feature: 'mcp.envelope.undocumented',
    subsystem: 'mcp',
    description: 'Whether the MCP profile RESPONSE envelope is documented anywhere in the supplied corpus.',
    timeline: [{
      atMajor: null, change: 'UNKNOWN', confidence: 'CONFIRMED',
      evidence: "Definitively not. A full sweep of EpicResearch (160 files) for profileChanges, profileRevision, profileCommandRevision, responseVersion, profileChangesBaseRevision and multiUpdate returns ZERO hits, and there is not one `## Response` heading in the whole docs/mcp tree — the headings are Payload (80), Attributes (79), Parameters (63). It is a request-only reference.",
      detail: "The 753-file FortniteEndpointsDocumentation corpus is the same: it documents request bodies, not envelopes. So the envelope Nova sends is reconstructed from the 7.40 CLIENT BINARY (which fields it reads) and from reference implementations — not from any specification.",
    }],
    implementation: 'services/mcp/mcp.routes.ts',
    failureBehaviour: 'Undefined; 7.40 accepts what is currently sent.',
    notes: "Recorded as a CONFIRMED absence so nobody spends another session looking. What would settle it: a captured response from a live Epic MCP, or a client binary's parser. This is why mcp.rvn.serverAuthoritative stays unfixed — there is nothing authoritative to fix it against.",
  },

  // ── mcp ────────────────────────────────────────────────────────────────────────────────────────
  {
    feature: 'mcp.profile.operation',
    subsystem: 'mcp',
    description: 'POST /fortnite/api/game/v2/profile/{id}/{route}/{op}?profileId=&rvn=',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'EpicResearch docs/mcp/profile/operation_request.md; FN-Service Game/Profile/README.md; corroborated by the decompiled Retrofit interface FortnitePublicService.java. Observed 229× (QueryProfile) on 7.40.',
    }],
    implementation: 'services/mcp/mcp.routes.ts',
    failureBehaviour: 'Locker, currency and quest state unavailable; client shows an empty profile.',
  },
  {
    feature: 'mcp.envelope.profileChangesBaseRevision',
    subsystem: 'mcp',
    description: 'The response field 7.40 actually reads when applying profile changes.',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'Binary scan of FortniteClient-Win64-Shipping.exe (7.40): `profileChangesBaseRevision` and `profileChanges` PRESENT; `profileRevision`, `profileCommandRevision`, `responseVersion` ABSENT. See VERSION_COMPATIBILITY §2b.',
    }],
    implementation: 'services/mcp/mcp.routes.ts',
    failureBehaviour: 'Client cannot apply incremental changes; masked today because Nova re-sends the whole profile.',
    notes: 'The three ABSENT fields Nova also sends are inert on 7.40. That is why mcp-rvn-from-client is latent rather than broken.',
  },
  {
    feature: 'mcp.rvn.serverAuthoritative',
    subsystem: 'mcp',
    description: 'The server owns the profile revision; the client\'s ?rvn= is a hint, not the source.',
    timeline: [{
      atMajor: null, change: 'UNKNOWN', confidence: 'STRONGLY_SUPPORTED',
      evidence: "EpicResearch operation_request.md documents rvn=-1 as the DEFAULT the client sends — a sentinel meaning \"I have no cached revision\", which only makes sense if the server owns the real one. No corpus file documents the response envelope.",
    }],
    implementation: 'services/mcp/mcp.routes.ts — currently derives the response revision FROM the client value',
    failureBehaviour: 'Undefined. No observed symptom on 7.40.',
    notes: 'KNOWN_ISSUES mcp-rvn-from-client. Deliberately not "fixed": there is no authoritative envelope spec to fix it against, and 7.40 ignores the affected fields.',
  },

  // ── cloudstorage ───────────────────────────────────────────────────────────────────────────────
  {
    feature: 'cloudstorage.system.hotfix',
    subsystem: 'cloudstorage',
    description: 'GET /fortnite/api/cloudstorage/system[/{file}] — INI hotfixes applied over local config.',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'Observed 107× (list) and 64× per file on 7.40. Shape matches FN-Service Game/Cloudstorage/System/List.md.',
    }],
    implementation: 'services/cloudstorage/cloudstorage.routes.ts',
    failureBehaviour: 'UE4 discards the WHOLE hotfix batch if any file fails — including the XMPP override, which is how the client learns where its server is. See NOVA-305.',
    notes: 'This is the highest-leverage surface in the backend: it overrides the client\'s own DefaultEngine.ini and cannot be beaten by patching files on disk.',
  },

  // ── friends / presence ─────────────────────────────────────────────────────────────────────────
  {
    feature: 'friends.settings.acceptInvites',
    subsystem: 'friends',
    description: 'GET /friends/api/v1/{id}/settings → { acceptInvites }.',
    timeline: [
      {
        atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
        evidence: 'Binary scan of the 7.40 client: `acceptInvites` PRESENT (utf16 ×1). Observed 59× in session logs.',
        detail: 'Bounded 2026-09-06 by a second binary: ABSENT from ++Fortnite+Release-Live-CL-3240987 (December 2016). So the field was added somewhere between that build and 7.40 - still not a major, but no longer unbounded below.',
      },
      {
        atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
        evidence: 'Binary scan: `mutualPrivacy` ABSENT from 7.40 (ascii 0 / utf16 0) although modern endpoint docs show it. Adding it would be an anachronism.',
        detail: 'The major at which mutualPrivacy appears is UNKNOWN — it needs a later client binary to establish.',
      },
    ],
    implementation: 'services/social/social.routes.ts',
    failureBehaviour: 'Party invites silently rejected.',
    tests: ['friends-auth.test.ts'],
  },
  {
    feature: 'friends.mutation.ownership',
    subsystem: 'friends',
    description: 'A caller may only modify its OWN friends/blocklist.',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'Not a Fortnite behaviour — a Nova security invariant. Reproduced as exploitable 2026-08-31 (NOVA-AUDIT-007) and re-verified on the live coordinator 2026-09-05: unauthenticated writes now 401 in all three route families.',
    }],
    implementation: 'services/social/social.routes.ts, services/eos/eos.routes.ts',
    failureBehaviour: '401 with an Epic error envelope; nothing persisted.',
    tests: ['friends-auth.test.ts'],
  },

  // ── party ──────────────────────────────────────────────────────────────────────────────────────
  {
    feature: 'party.v1.xmpp',
    subsystem: 'party',
    description: 'Party state carried over XMPP by FOnlinePartySystemMcp (party "V1").',
    timeline: [
      {
        atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
        evidence: "7.40's own FortniteGame.log: FOnlinePartySystemMcp ×54, FOnlineIdentityMcp ×6. Binary: bUsePartySystemV2 and OnlinePartySystemMcpAdapter ABSENT.",
      },
      {
        atMajor: null, change: 'REPLACED', confidence: 'UNKNOWN', replacedBy: 'party.v2.rest',
        evidence: 'No evidence in the supplied corpus for WHEN party V2 became the client default. The 7.40 binary simply does not contain it.',
        detail: 'Needs a client binary from the transition era to place. Until then this row states only that 7.40 is V1.',
      },
    ],
    implementation: 'services/xmpp/xmpp.server.ts',
    failureBehaviour: 'Cannot form a party; "Play" may still work solo.',
  },
  {
    feature: 'party.v2.rest',
    subsystem: 'party',
    description: 'REST party API under /party/api/v1/Fortnite/... .',
    timeline: [{
      atMajor: null, change: 'UNKNOWN', confidence: 'UNKNOWN',
      evidence: 'Nova routes this family, but 7.40 never calls it and no corpus source dates its introduction.',
    }],
    implementation: 'services/xmpp/xmpp.server.ts + party routes (registered, unexercised)',
    notes: 'Implemented, NOT supported. The distinction this table exists to make.',
  },

  // ── calendar / events ──────────────────────────────────────────────────────────────────────────
  {
    feature: 'calendar.timeline',
    subsystem: 'events',
    description: 'GET /fortnite/api/calendar/v1/timeline — channels, states, activeEvents, cacheExpire.',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'Observed 64× per 7.40 session. Structure matches FN-Service Game/Calendar.md field for field (channels → states[] → {validFrom, activeEvents, state}, plus cacheIntervalMins/currentTime).',
    }],
    implementation: 'services/social/social.routes.ts',
    failureBehaviour: 'No season config: wrong lobby background, missing LTM tiles, playlists absent.',
    tests: ['version.test.ts — the timeline still advertises season 7 and its Chapter 1 flags'],
    notes: 'The real hook for every event mechanism. Nova serves a static season-derived document.',
  },
  {
    feature: 'calendar.seasonNumber.isMajor',
    subsystem: 'events',
    description: "The timeline's `seasonNumber` / `athenaseason<n>` use the CONTINUOUS major version, not the season-within-chapter.",
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: "Two independent sources agree. FN-Service Game/Calendar.md shows seasonNumber 24 / AthenaSeason:athenaseason24 for a document dated 2023-05-18 with the season running 2023-03-09 → 2023-06-18. The build registry (derived from fortnite-archives) places major 24 at Chapter 4 Season 2. So 24 is the major, not the season.",
      detail: 'In Chapter 1 the two are numerically identical, which is why this could not be observed from 7.40 alone and would have been discovered only by breaking Chapter 2.',
    }],
    implementation: 'services/social/social.routes.ts — uses gameVersion.major',
    failureBehaviour: 'A chapter-relative value would advertise the wrong season entirely: a Chapter 2 Season 1 client would be told athenaseason1, i.e. Chapter 1 Season 1.',
    tests: ['version.test.ts — the timeline must key on major, not season'],
    notes: 'This is the concrete reason `gameVersion` exposes major and season SEPARATELY. Wire formats want the major; human-facing text wants the chapter/season pair.',
  },
  {
    feature: 'events.activation.mechanism',
    subsystem: 'events',
    description: 'How a live event actually starts: flag → locked playlist → sequence → world-state transition.',
    timeline: [{
      atMajor: null, change: 'UNKNOWN', confidence: 'UNKNOWN',
      evidence: "Research.txt describes a plausible lifecycle but grades it as inference from player observation and states the activation mechanism \"is not public\". Nothing in the 753 endpoint docs specifies it.",
      detail: 'What would settle it: a client binary from an event-era build, or a captured timeline document from a live event window.',
    }],
    failureBehaviour: 'Undefined — nothing implements event activation.',
    notes: 'Reconstructing this from a SPECULATIVE description would produce confident wrong answers, which is the failure mode this project has paid for repeatedly.',
  },

  // ── playlists / worldstate ─────────────────────────────────────────────────────────────────────
  {
    feature: 'playlists.chapter1.set',
    subsystem: 'playlists',
    description: 'The playlist ids a Chapter 1 Season 7 client knows.',
    timeline: [{
      atMajor: 7, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: 'Extracted from the 7.40 client binary: Playlist_DefaultSolo/Duo/Squad, _50v50, _FiftyFifty, _Playground(V2), _Showdown_*, _ShowdownAlt_*, _Deimos_*. See VERSION_COMPATIBILITY §2b.',
      detail: '`playlist_fill_squads` exists in Nova but NOT in the client — it is Nova-internal.',
    }],
    implementation: 'services/social/social.routes.ts (timeline playlist_info)',
    failureBehaviour: 'Requesting an unknown playlist: client shows no matchmaking option.',
    tests: ['version.test.ts — the playlists offered are ones the 7.40 client actually knows'],
  },
  {
    feature: 'playlists.perEra',
    subsystem: 'playlists',
    description: 'Serving each build era the playlist set that era actually had.',
    timeline: [{
      atMajor: null, change: 'UNKNOWN', confidence: 'UNKNOWN',
      evidence: "Investigated 2026-09-05 and rejected on evidence. The only playlist data in the corpus is Fortnite-Datamining data/playlists/current.json — a SNAPSHOT taken at build 42.00, whose earliest `added` date is 2020-09-25. It therefore contains no Chapter 1 playlists at all, and serving it to a Chapter 1 or 2 client would advertise modes that build has never heard of.",
      detail: "The per-playlist `added` dates are real introduction evidence for the modern era, but converting a date to a build needs a date→build table this project does not have, and none of it reaches back before Chapter 2 Season 4.",
    }],
    implementation: 'services/social/social.routes.ts serves a fixed Chapter 1 set (evidenced from the 7.40 binary)',
    failureBehaviour: 'A build offered an unknown playlist simply shows no matchmaking option for it.',
    notes: "Deliberately NOT implemented per-era. What would settle it: a client binary per era, which yields that build's playlist literals directly — the same scan that produced the 7.40 set.",
  },
  {
    feature: 'worldstate.poi.perBuild',
    subsystem: 'worldstate',
    description: 'Which named locations exist on the map for a given build.',
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: 'fortnite-archives corpus: 192 builds across Chapters 1-7 carry a per-build `locations` list.',
      detail: 'Data exists for the full range; nothing in Nova consumes it yet.',
    }],
    failureBehaviour: 'n/a — no implementation.',
    notes: 'Real cross-version data that is available today. The obvious first consumer is a per-build map/POI response, if a client is ever found that asks for one.',
  },
  {
    feature: 'content.aes.chunkKeys',
    subsystem: 'content',
    description: 'GET /fortnite/api/storefront/v2/keychain — per-chunk AES keys for encrypted cosmetics.',
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: 'Fortnite-Aes-Keys-Archive lists per-build primary and chunk keys for 7.10 through 19.01. Nova\'s two 7.40 entries verified byte-for-byte 2026-09-05.',
      detail: '7.40 has five chunks; keys for 1000/1001/1002 are recorded as ??? in the archive and cannot be served.',
    }],
    implementation: 'services/storefront/storefront.routes.ts',
    failureBehaviour: 'Encrypted cosmetic chunks fail to decrypt; those items do not render.',
    tests: ['version.test.ts — versioncheck, enabled_features and keychain are unchanged'],
    notes: 'Per-build keys exist for the whole Chapter 1-4 range — this is directly extendable once a second build is targeted.',
  },

  {
    feature: 'transport.redirect.hookWindow',
    subsystem: 'transport',
    description: "Cobalt's curl hook has windows in which requests escape to Epic's live servers.",
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: "Cobalt/dllmain.cpp documents it: VEH PAGE_GUARD is a one-shot alarm cleared for ALL threads when it fires, re-armed only by a deferred STATUS_SINGLE_STEP. UE4 issues ~25-30 curl_easy_setopt calls per request across threads. Ten distinct FN- correlation ids across captured logs; the 2026-08-15 QueryFriendSettings 401 is one of them.",
      detail: "Version-specific because the hook is found by byte-signature scan against 7.40. A different build needs a different signature, so this failure mode does not transfer - a DIFFERENT one would.",
    }],
    implementation: 'Launcher/cobalt/Cobalt/dllmain.cpp',
    failureBehaviour: "UE4's hotfix batch is all-or-nothing: one escaped file discards DefaultEngine.ini, so the client never learns the server address. Presents as \"Fortnite was not started correctly\" or stuck matchmaking.",
    notes: "KNOWN_ISSUES nova-303-request-escape. The structural fix is to make the redirect not depend on the hook at all, by configuring service URLs in the build's own DefaultEngine.ini — which is read before any network I/O, unlike the hotfix.",
  },

  // ── matchmaking ────────────────────────────────────────────────────────────────────────────────
  {
    feature: 'matchmaking.ticket.player',
    subsystem: 'matchmaking',
    description: 'POST .../matchmakingservice/ticket/player/{id} → MMS ticket.',
    timeline: [{
      atMajor: null, change: 'ADDED', confidence: 'CONFIRMED',
      evidence: 'Observed 35× on 7.40; corroborated by the client binary fragment `api/game/v2/matchmakingservice/ticket/player/`.',
    }],
    implementation: 'services/matchmaking/matchmaking.routes.ts',
    failureBehaviour: 'Press Play does nothing; client sits in "Connecting".',
  },
  {
    feature: 'matchmaking.ticket.session',
    subsystem: 'matchmaking',
    description: 'The SESSION-scoped ticket variant.',
    timeline: [{
      atMajor: null, change: 'UNKNOWN', confidence: 'STRONGLY_SUPPORTED',
      evidence: 'The fragment `api/game/v2/matchmakingservice/ticket/session/` exists in the 7.40 binary, but no observed session ever called it.',
    }],
    implementation: 'services/compat/latent.routes.ts (stub — returns the catch-all shape)',
    failureBehaviour: 'Unknown; never exercised.',
    notes: 'Implemented as a stub, NOT supported. A literal in a shipping binary proves the build knows the name, not that any reachable path calls it.',
  },
  {
    feature: 'cosmetics.locker.eraFilter',
    subsystem: 'content',
    description: 'Hide cosmetics that did not exist yet in the build asking for the locker.',
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: 'Fortnite-Datamining data/items/registry.json carries introduction:{chapter,season} on 15,025 of 23,532 records, C1S1-C7S4. Measured 2026-09-06: of the 335 cosmetics Nova grants unconditionally, 97 are in that corpus and all are Chapter 1; EID_Conga is C1S8 and was being granted to 7.40, a Season 7 build.',
      detail: 'Filtered on READ, not at seed time, so the stored profile stays complete and one account can connect from several builds. An era the request does not establish filters nothing.',
    }],
    implementation: 'services/mcp/profiles/athena.ts - filterItemsByEra, called from queryAthenaProfile',
    failureBehaviour: 'An item the build has no assets for renders as a blank tile in the locker.',
    tests: [
      'cosmetics.test.ts - does not give EID_Conga to a 7.40 client',
      'cosmetics.test.ts - QueryProfile over HTTP serves an era-correct locker',
    ],
    notes: 'Removes only what provably post-dates a build; it does not expand later-era lockers. The corpus does not cover 238 of the granted ids, and those stay available rather than being dropped on a guess.',
  },
  {
    feature: 'game.enabledFeatures',
    subsystem: 'content',
    description: 'GET /fortnite/api/game/v2/enabled_features.',
    timeline: [{
      atMajor: null, change: 'MODIFIED', confidence: 'CONFIRMED',
      evidence: 'FortniteEndpointsDocumentation EpicGames/FN-Service/Game/EnabledFeatures.md gives BOTH responses: [] currently, and [store] labelled (2017). One of very few endpoints in the corpus documented with an old/new pair.',
      detail: 'THE BOUNDARY IS INFERRED. The corpus says a calendar year, not a build. Only majors 1 and 2 existed in 2017, so major <= 2 is the set that could have seen the old response; Season 2 ran on into February 2018, so its upper edge is a judgement call.',
    }],
    implementation: 'services/social/social.routes.ts',
    failureBehaviour: 'Unknown - no client in the corpus is recorded reacting to either value.',
    tests: ['cosmetics.test.ts - enabled_features follows the calling build'],
    notes: 'The DIFFERENCE is confirmed; the cutoff is not. 7.40 is unaffected and still gets [].',
  },
  {
    feature: 'transport.eos.sdkAddressing',
    subsystem: 'transport',
    description: 'Whether an EOS-era client can be pointed at Nova at all.',
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: 'OnlineSubsystemMcp resolves services by URL, so a host redirect reaches them - this is how 7.40 is served today. The EOS SDK resolves by ProductId / SandboxId / DeploymentId issued by Epic, not by a base URL, so there is no URL for a redirect to rewrite.',
      detail: 'A HARD BLOCKER, not a gap in the work. It bounds what support every version can mean: era-correct RESPONSES are implementable for any build, but an EOS-era client cannot be made to ASK Nova for them by the redirect mechanism this project uses.',
    }],
    failureBehaviour: 'The client talks to Epic, or to nothing. Nova never sees the request.',
    notes: 'Nothing in the backend can lift this; it is a property of how the client addresses services. Recorded so the limit is visible rather than rediscovered.',
  },
  {
    feature: 'mcp.operations.eraSet',
    subsystem: 'mcp',
    description: 'Which MCP profile operations exist in a given build.',
    timeline: [{
      atMajor: null, change: 'VERSION_SPECIFIC', confidence: 'CONFIRMED',
      evidence: 'All 149 operation names in the endpoint corpus scanned against the 7.40 shipping client 2026-09-06, with controls both ways (QueryProfile / ClientQuestLogin / CreateNewIsland PRESENT; ProtoJuno_CreateWorld ABSENT). 84 present, 65 absent. Operation names are verbatim symbols, so count is a valid probe for them - unlike paths, see tools/README.md trap 3.',
      detail: 'Three boundaries this pins for 7.40: EndBattleRoyaleGame PRESENT and EndBattleRoyaleGameV2 ABSENT, so this build is on the V1 side; AthenaPinQuest AND its stated replacement AthenaTrackQuests are BOTH absent; SetIntroGamePlayed absent. Nova handles 34 operations, 7 of which 7.40 does not have.',
    }],
    implementation: 'services/mcp/mcp.routes.ts - 34 handled, the rest fall to an empty-success default',
    tests: [
      'operations.test.ts - the handler switch matches the audited set',
      'operations.test.ts - both eras of the locker path stay handled',
      'operations.test.ts - every operation Nova handles was checked against the client',
    ],
    failureBehaviour: 'An unhandled operation returns an empty-success envelope, never a 404. The client believes it succeeded and nothing happens.',
    notes: 'The 63 operations 7.40 has and Nova does not handle are overwhelmingly Save the World and Creative, where empty success is the right answer for a Battle Royale backend. Audited in KNOWN_ISSUES.md; deliberately NOT implemented, because a literal in a shipping binary proves the build knows the name and none of them appear in the observed request log.',
  },
  {
    feature: 'mcp.profile.profile0',
    subsystem: 'mcp',
    description: 'The single combined MCP profile that predates common_core / campaign / athena.',
    timeline: [{
      atMajor: null, change: 'REPLACED', replacedBy: 'mcp.profile.operation', confidence: 'CONFIRMED',
      evidence: 'TWO BINARIES, which is what makes this the first properly bounded change in this table. ++Fortnite+Release-Live-CL-3240987 (UE 4.14.0, December 2016): profile0 PRESENT (utf16 x2), common_core / campaign / athena ALL ABSENT. 7.40: exactly the reverse - profile0 ABSENT, common_core x9, campaign x14, athena x33. Corroborates the endpoint corpus, which calls profile0 a relict "basicly like common_core, athena and campaign combined".',
      detail: 'WHERE the split happened is still UNKNOWN: the two binaries bracket it between December 2016 and 7.40, and nothing in the corpus narrows it further. The 2016 build also has no Athena or BattleRoyale at all, so it predates Battle Royale entirely and is outside the Chapter 1-4 range this work targets.',
    }],
    implementation: 'services/mcp/operations/QueryProfile.ts - unknown profileIds fall to buildStubProfile',
    failureBehaviour: 'A profile0 request returns an empty stub rather than a 404, so an ancient client is answered rather than errored. That is the safe direction and is already the behaviour.',
    tests: ['operations.test.ts - Release-Live builds'],
    notes: 'Recorded rather than implemented. Nova is a Battle Royale backend and this build has no Battle Royale in it; serving profile0 properly would mean modelling a 2016 Save the World profile from a binary alone.',
  },
];

const BY_ID = new Map<string, FeatureRecord>(FEATURES.map((f) => [f.feature, f]));

export function getFeature(id: string): FeatureRecord | null {
  return BY_ID.get(id) ?? null;
}

export interface FeatureState {
  feature: string;
  change: ChangeKind;
  confidence: Confidence;
  evidence: string;
  replacedBy?: string;
  detail?: string;
  /** True when the feature is known to be gone at this version. */
  removed: boolean;
}

/**
 * What is true about `feature` at `major`?
 *
 * Walks the timeline and returns the newest entry that applies. Entries with `atMajor: null` apply
 * from the beginning of recorded time. Returns null for an unknown feature id rather than a
 * permissive default — an unrecognised id is a bug in the caller, not a reason to allow something.
 */
export function stateAt(featureId: string, major: number): FeatureState | null {
  const rec = BY_ID.get(featureId);
  if (!rec) return null;

  let applicable: TimelineEntry | null = null;
  for (const entry of rec.timeline) {
    if (entry.atMajor === null || entry.atMajor <= major) applicable = entry;
  }
  if (!applicable) return null;

  return {
    feature: featureId,
    change: applicable.change,
    confidence: applicable.confidence,
    evidence: applicable.evidence,
    replacedBy: applicable.replacedBy,
    detail: applicable.detail,
    removed: applicable.change === 'REMOVED',
  };
}

/**
 * SUPPORTED / IMPLEMENTED / KNOWN / UNKNOWN — the distinction the brief calls the most important
 * rule, computed rather than asserted.
 *
 *   SUPPORTED    behaviour understood, versions known, implemented, failure defined, tested, evidenced
 *   IMPLEMENTED  code exists, but at least one of the other criteria is missing
 *   KNOWN        we understand it and have evidence, but there is no implementation
 *   UNKNOWN      we do not know what the correct behaviour is
 *
 * Deliberately strict: a row cannot reach SUPPORTED while its own confidence is UNKNOWN, no matter
 * how much code points at it.
 */
export type SupportLevel = 'SUPPORTED' | 'IMPLEMENTED' | 'KNOWN' | 'UNKNOWN';

export interface SupportAssessment {
  level: SupportLevel;
  /** Which criteria are unmet — the actionable half. */
  missing: string[];
}

export function supportLevel(featureId: string): SupportAssessment {
  const rec = BY_ID.get(featureId);
  if (!rec) return { level: 'UNKNOWN', missing: ['no such feature'] };

  const missing: string[] = [];
  const worstConfidence = rec.timeline.reduce<Confidence>((worst, e) => {
    const rank = { CONFIRMED: 3, STRONGLY_SUPPORTED: 2, INFERRED: 1, UNKNOWN: 0 } as const;
    return rank[e.confidence] < rank[worst] ? e.confidence : worst;
  }, 'CONFIRMED');

  if (worstConfidence === 'UNKNOWN') missing.push('expected behaviour not established');
  if (!rec.implementation) missing.push('no implementation');
  if (!rec.failureBehaviour) missing.push('failure behaviour undefined');
  if (!rec.tests || rec.tests.length === 0) missing.push('untested');
  if (rec.timeline.some((e) => !e.evidence)) missing.push('evidence missing');

  if (missing.length === 0) return { level: 'SUPPORTED', missing };
  if (rec.implementation) return { level: 'IMPLEMENTED', missing };
  if (worstConfidence !== 'UNKNOWN') return { level: 'KNOWN', missing };
  return { level: 'UNKNOWN', missing };
}

/** Every feature, with its support assessment. Backs the compatibility report and its tests. */
export function supportReport(): Array<{ feature: string; subsystem: Subsystem } & SupportAssessment> {
  return FEATURES.map((f) => ({ feature: f.feature, subsystem: f.subsystem, ...supportLevel(f.feature) }));
}
