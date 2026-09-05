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
  | 'storefront' | 'discovery' | 'telemetry';

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
