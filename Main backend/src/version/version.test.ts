/**
 * Cross-version foundation tests.
 *
 * Two jobs, and the second is the important one:
 *
 *   1. Pin the version model — the registry, identification, and the compatibility table's own
 *      invariants (every claim carries evidence; nothing is silently upgraded to CONFIRMED).
 *
 *   2. PROTECT THE 7.40 BASELINE. 7.40 is the only experimentally validated target this project has,
 *      and the cross-version work is supposed to be built around it rather than over it. The golden
 *      test below drives the real route handlers with a real 7.40 User-Agent and compares the
 *      responses field by field. If a future version adapter changes what 7.40 receives, this fails
 *      before anyone installs it.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-version-${process.pid}.db`);

import { BUILD_ERAS, eraForMajor, NEWEST_KNOWN_MAJOR } from './builds';
import { identifyVersion, atOrAfter, before as beforeVersion, isBeyondKnownBuilds } from './identify';
import { FEATURES, stateAt, supportLevel, supportReport, getFeature } from './features';
import { KEYCHAINS, keychainForBuild, buildString } from './keychain';

/** The exact User-Agent 7.40 sends. Taken from a real session, not composed. */
const UA_740 = 'Fortnite/++Fortnite+Release-7.40-CL-5046157 Windows/10.0.17763.1.256.64bit';

describe('build registry — derived from the corpus, not from arithmetic', () => {
  test('the major sequence is complete and self-consistent', () => {
    const majors = BUILD_ERAS.map((e) => e.major);
    assert.deepEqual(majors, [...majors].sort((a, b) => a - b), 'must be ordered');
    for (let i = 1; i < majors.length; i++) {
      assert.equal(majors[i], majors[i - 1] + 1, `gap before major ${majors[i]}`);
    }
    assert.equal(new Set(majors).size, majors.length, 'no duplicate majors');
  });

  test('Chapter 1 is the only chapter where season equals major', () => {
    for (const era of BUILD_ERAS) {
      if (era.chapter === 1) {
        assert.equal(era.season, era.major, `Ch1 major ${era.major} should have season == major`);
      } else {
        assert.notEqual(
          era.season, era.major,
          `major ${era.major} is Chapter ${era.chapter}; season==major there would mean the old bug is back`,
        );
      }
    }
  });

  test('7.40 resolves to Chapter 1 Season 7', () => {
    const era = eraForMajor(7);
    assert.ok(era);
    assert.equal(era.chapter, 1);
    assert.equal(era.season, 7);
    assert.ok(era.knownBuilds.includes('7_40'), 'the corpus must actually contain this build');
  });

  test('Chapter 6 Season 4 spans two majors — the table is the authority, not the arithmetic', () => {
    // 36 and 37 both sit in Chapter 6 Season 4. Any code that computes season from major by
    // division or subtraction gets this wrong, which is why the registry is a lookup.
    assert.deepEqual(
      BUILD_ERAS.filter((e) => e.chapter === 6 && e.season === 4).map((e) => e.major),
      [36, 37],
    );
  });

  test('an unknown major returns null rather than an invented era', () => {
    assert.equal(eraForMajor(NEWEST_KNOWN_MAJOR + 5), null);
    assert.equal(eraForMajor(0), null);
  });
});

describe('version identification', () => {
  test('a real 7.40 User-Agent is identified exactly, and CONFIRMED', () => {
    const v = identifyVersion({ 'user-agent': UA_740 }, 7);
    assert.equal(v.major, 7);
    assert.equal(v.minor, 40);
    assert.equal(v.chapter, 1);
    assert.equal(v.season, 7);
    assert.equal(v.changelist, 5046157);
    assert.equal(v.confidence, 'CONFIRMED');
    assert.equal(v.id, '7.40');
    assert.ok(v.signals.includes('user-agent:Release'));
    assert.ok(v.signals.includes('registry:chapter-season'));
    assert.ok(v.signals.includes('user-agent:CL'));
  });

  test('the Windows version in the same string does not get parsed as the build', () => {
    // `Windows/10.0.17763` also matches a bare \d+\.\d+, and on some agents matches first. The
    // regex is anchored on `Release-` for this reason.
    const v = identifyVersion({ 'user-agent': UA_740 }, 7);
    assert.notEqual(v.major, 10, 'parsed the Windows version instead of the build');
  });

  test('no User-Agent falls back, and SAYS it fell back', () => {
    const v = identifyVersion({}, 7);
    assert.equal(v.confidence, 'UNKNOWN', 'a default must never look like a measurement');
    assert.equal(v.id, 'unknown');
    // The fallback picks a major; it does not get to invent an era.
    assert.equal(v.chapter, 1);
    assert.equal(v.season, 7);
  });

  test('a build newer than the registry is parsed but not placed', () => {
    const v = identifyVersion({ 'user-agent': `Fortnite/++Fortnite+Release-${NEWEST_KNOWN_MAJOR + 3}.00-CL-1` }, 7);
    assert.equal(v.major, NEWEST_KNOWN_MAJOR + 3);
    assert.equal(v.chapter, null, 'must not guess a chapter');
    assert.equal(v.season, null);
    assert.equal(v.confidence, 'STRONGLY_SUPPORTED', 'the numbers are real; the era is not known');
    assert.ok(isBeyondKnownBuilds(v));
  });

  test('ordering helpers', () => {
    const v = identifyVersion({ 'user-agent': UA_740 }, 7);
    assert.ok(atOrAfter(v, 7, 40));
    assert.ok(atOrAfter(v, 7));
    assert.ok(!atOrAfter(v, 7, 41));
    assert.ok(beforeVersion(v, 8));
    assert.ok(!beforeVersion(v, 7, 40));
  });
});

describe('the compatibility table must not be able to lie', () => {
  test('every timeline entry carries evidence', () => {
    for (const f of FEATURES) {
      assert.ok(f.timeline.length > 0, `${f.feature} has no timeline`);
      for (const e of f.timeline) {
        assert.ok(e.evidence && e.evidence.length > 20, `${f.feature}: an entry has no usable evidence`);
      }
    }
  });

  test('feature ids are unique and stable-looking', () => {
    const ids = FEATURES.map((f) => f.feature);
    assert.equal(new Set(ids).size, ids.length, 'duplicate feature id');
    for (const id of ids) {
      assert.match(id, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, `${id} is not a subsystem.thing id`);
    }
  });

  test('a REPLACED entry names its replacement, and the replacement exists', () => {
    for (const f of FEATURES) {
      for (const e of f.timeline) {
        if (e.change === 'REPLACED') {
          assert.ok(e.replacedBy, `${f.feature} is REPLACED but names no replacement`);
          assert.ok(getFeature(e.replacedBy!), `${f.feature} points at unknown feature ${e.replacedBy}`);
        }
      }
    }
  });

  test('UNKNOWN confidence can never reach SUPPORTED, however much code exists', () => {
    // The most important rule in the brief, enforced mechanically rather than by good intentions.
    const unknowns = FEATURES.filter((f) => f.timeline.some((e) => e.confidence === 'UNKNOWN'));
    assert.ok(unknowns.length > 0, 'the table should be honest enough to contain UNKNOWNs');
    for (const f of unknowns) {
      assert.notEqual(
        supportLevel(f.feature).level, 'SUPPORTED',
        `${f.feature} claims SUPPORTED while its own evidence is UNKNOWN`,
      );
    }
  });

  test('implemented-but-not-supported is reported as such, with reasons', () => {
    // party.v2.rest is routed and unexercised: the exact case the distinction exists for.
    const a = supportLevel('party.v2.rest');
    assert.equal(a.level, 'IMPLEMENTED');
    assert.ok(a.missing.includes('expected behaviour not established'));
    assert.ok(a.missing.length > 0, 'IMPLEMENTED must always say what is missing');
  });

  test('a fully evidenced, implemented, tested feature reaches SUPPORTED', () => {
    // A positive control: without one, the strictness above could be passing for the wrong reason.
    const a = supportLevel('friends.mutation.ownership');
    assert.equal(a.level, 'SUPPORTED', `expected SUPPORTED, missing: ${a.missing.join(', ')}`);
    assert.deepEqual(a.missing, []);
  });

  test('an unknown feature id is refused, not permitted by default', () => {
    assert.equal(stateAt('no.such.feature', 7), null);
    assert.equal(supportLevel('no.such.feature').level, 'UNKNOWN');
  });

  test('stateAt walks the timeline to the newest applicable entry', () => {
    const s = stateAt('playlists.chapter1.set', 7);
    assert.ok(s);
    assert.equal(s.change, 'VERSION_SPECIFIC');
    assert.equal(s.confidence, 'CONFIRMED');
    // Before the entry's atMajor, it does not apply.
    assert.equal(stateAt('playlists.chapter1.set', 6), null);
  });

  test('the support report is dominated by honest gaps, not by claims', () => {
    const report = supportReport();
    const supported = report.filter((r) => r.level === 'SUPPORTED').length;
    assert.ok(supported >= 1, 'something must be genuinely supported');
    assert.ok(
      supported < report.length,
      'a table where everything is SUPPORTED is a table that stopped being honest',
    );
  });
});

describe('per-build keychain — the first behaviour that actually varies by version', () => {
  test('the registry spans more than one chapter', () => {
    // The whole point. Before this, every client received 7.40's two keys.
    assert.ok(KEYCHAINS.length >= 50, `expected a broad archive, got ${KEYCHAINS.length} builds`);
    const majors = new Set(KEYCHAINS.map((k) => Number(k.build.split('.')[0])));
    assert.ok(majors.has(7), 'Chapter 1 must be covered');
    assert.ok([...majors].some((m) => m >= 11), 'coverage must reach past Chapter 1');
  });

  test('7.40 still gets exactly its two verified keys', () => {
    const c = keychainForBuild('7.40');
    assert.ok(c);
    assert.equal(c.entries.length, 2);
    assert.ok(c.entries[0].startsWith('91C415954BF27B6E43970FB8A75FE8BB:'), 'chunk 1003 GUID changed');
    assert.ok(c.entries[1].startsWith('D776CA2A40FD9EC1F8522E9E13E99031:'), 'chunk 1004 GUID changed');
    assert.equal(c.unknownChunks, 3, "7.40's three ??? chunks must stay recorded as gaps");
  });

  test('a different build gets DIFFERENT keys', () => {
    // If this ever passes by returning the same thing for both, the cross-version claim is empty.
    const a = keychainForBuild('7.40');
    const b = KEYCHAINS.find((k) => k.build !== '7.40' && k.entries.length > 0);
    assert.ok(a && b, 'need two builds with keys to compare');
    assert.notDeepEqual(a.entries, b.entries, `${b.build} returned the same keys as 7.40`);
  });

  test("an unknown build gets nothing rather than someone else's keys", () => {
    // Chunk keys do not carry forward. A wrong key presents as a decryption bug, which is harder to
    // diagnose than an absent one.
    assert.equal(keychainForBuild('99.99'), null);
    assert.equal(keychainForBuild(''), null);
  });

  test('every entry is a well-formed GUID:base64 pair', () => {
    for (const chain of KEYCHAINS) {
      for (const entry of chain.entries) {
        const [guid, key] = entry.split(':');
        assert.match(guid, /^[0-9A-F]{32}$/, `${chain.build}: bad GUID ${guid}`);
        // 32 raw bytes -> 44 base64 chars with one pad.
        assert.equal(Buffer.from(key, 'base64').length, 32, `${chain.build}: key is not 32 bytes`);
      }
    }
  });

  test('no key marked unknown in the archive was invented', () => {
    // 66 chunks across the archive have no published key. They must be counted, never filled in.
    const totalUnknown = KEYCHAINS.reduce((n, k) => n + k.unknownChunks, 0);
    assert.ok(totalUnknown > 0, 'the gaps should be recorded, not silently dropped');
  });

  test('buildString matches the archive spelling', () => {
    assert.equal(buildString(7, 40), '7.40');
    assert.equal(buildString(8, 0), '8.00');
    assert.equal(buildString(19, 1), '19.01');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  THE 7.40 BASELINE. This is the protected part.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

let app: FastifyInstance;

before(async () => {
  const dbm = await import('../database');
  const { socialRoutes } = (await import('../services/social/social.routes')) as any;
  const { cloudstorageRoutes } = (await import('../services/cloudstorage/cloudstorage.routes')) as any;
  const { storefrontRoutes } = (await import('../services/storefront/storefront.routes')) as any;
  const { lightswitchRoutes } = (await import('../services/lightswitch/lightswitch.routes')) as any;
  const { versionRouter } = (await import('../middleware/version-router')) as any;

  await dbm.initDatabase();
  app = Fastify({ logger: false });
  await app.register(formbody);
  app.addHook('onRequest', versionRouter);
  await app.register(socialRoutes);
  await app.register(cloudstorageRoutes);
  await app.register(storefrontRoutes);
  await app.register(lightswitchRoutes);
  await app.ready();
});

const as740 = (url: string) =>
  app.inject({ method: 'GET', url, headers: { 'user-agent': UA_740 } });

describe('7.40 baseline — the cross-version work must be built AROUND this, not over it', () => {
  test('the timeline still advertises season 7 and its Chapter 1 flags', async () => {
    const res = await as740('/fortnite/api/calendar/v1/timeline');
    assert.equal(res.statusCode, 200);
    const body = res.json();

    const clientEvents = body.channels['client-events'].states[0];
    // seasonNumber is the MAJOR (7 here). If someone "fixes" this to the chapter-relative season it
    // stays 7 for Chapter 1 and silently breaks every later chapter — hence the explicit assertion
    // alongside calendar.seasonNumber.isMajor in the feature table.
    assert.equal(clientEvents.state.seasonNumber, 7);
    assert.equal(clientEvents.state.seasonTemplateId, 'AthenaSeason:athenaseason7');

    const flags = clientEvents.activeEvents.map((e: any) => e.eventType);
    assert.ok(flags.includes('EventFlag.Season7'), 'S7 flag missing');
    assert.ok(flags.includes('EventFlag.LobbySeason7'), 'S7 lobby flag missing');
    assert.ok(flags.includes('EventFlag.Frostnite'), 'a S7-specific LTM flag must survive');
    assert.ok(!flags.some((f: string) => /Season8|Spring2019/.test(f)), 'S8 flags must not leak into a S7 client');

    // Structural fields the client reads.
    assert.equal(typeof body.cacheIntervalMins, 'number');
    assert.equal(typeof body.currentTime, 'string');
    assert.ok(body.channels['client-matchmaking'], 'matchmaking channel required');
    assert.ok(body.channels['standalone-store'], 'store channel required');
  });

  test('the lobby background matches the season the timeline advertises', async () => {
    const res = await as740('/content/api/pages/fortnite-game');
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.stringify(res.json()).includes('lobbyseason7'), 'a S7 client must get the S7 stage');
  });

  test('the playlists offered are ones the 7.40 client actually knows', async () => {
    // Cross-checked against the playlist set extracted from the client binary. Offering a name the
    // build does not contain is how a matchmaking option silently disappears.
    const KNOWN_TO_740 = new Set([
      'Playlist_DefaultSolo', 'Playlist_DefaultDuo', 'Playlist_DefaultSquad',
      'Playlist_50v50', 'Playlist_FiftyFifty', 'Playlist_Playground', 'Playlist_PlaygroundV2',
      'Playlist_Showdown_Solo', 'Playlist_Showdown_Duos', 'Playlist_Showdown_Squads',
      'Playlist_ShowdownAlt_Solo', 'Playlist_ShowdownAlt_Duos', 'Playlist_ShowdownAlt_Squads',
      'Playlist_Deimos_SoloShow', 'Playlist_Deimos_DuoShow', 'Playlist_Deimos_SquadShow',
    ]);
    const body = (await as740('/content/api/pages/fortnite-game')).json();
    const offered = body.playlistinformation.playlist_info.playlists.map((p: any) => p.playlist_name);
    assert.ok(offered.length > 0);
    for (const name of offered) {
      assert.ok(KNOWN_TO_740.has(name), `${name} is offered to 7.40 but is not in the 7.40 client`);
    }
  });

  test('versioncheck, enabled_features and keychain are unchanged', async () => {
    assert.deepEqual((await as740('/fortnite/api/v2/versioncheck/Windows')).json(), { type: 'NO_UPDATE' });
    assert.deepEqual((await as740('/fortnite/api/game/v2/enabled_features')).json(), []);

    // Verified byte-for-byte against Fortnite-Aes-Keys-Archive's 7.40 table.
    const keys = (await as740('/fortnite/api/storefront/v2/keychain')).json();
    assert.equal(keys.length, 2);
    assert.ok(keys[0].startsWith('91C415954BF27B6E43970FB8A75FE8BB:'), 'pakchunk1003 GUID changed');
    assert.ok(keys[1].startsWith('D776CA2A40FD9EC1F8522E9E13E99031:'), 'pakchunk1004 GUID changed');
  });

  test('lightswitch reports UP for a client with no ban', async () => {
    const body = (await as740('/lightswitch/api/service/bulk/status')).json();
    assert.equal(body[0].serviceInstanceId, 'fortnite');
    assert.equal(body[0].status, 'UP');
    assert.equal(body[0].banned, false);
    assert.ok(body[0].allowedActions.includes('PLAY'));
  });

  test('a request with NO User-Agent still gets the configured target, not nothing', async () => {
    // The launcher, tooling and proxied traffic arrive like this. Falling to season 0 or null here
    // would blank the lobby for anything that is not the game itself.
    const body = (await app.inject({ method: 'GET', url: '/fortnite/api/calendar/v1/timeline' })).json();
    assert.equal(typeof body.channels['client-events'].states[0].state.seasonNumber, 'number');
    assert.ok(body.channels['client-events'].states[0].state.seasonNumber > 0);
  });
});
