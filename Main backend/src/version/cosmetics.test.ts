/**
 * Era filtering of cosmetics.
 *
 * The defect this guards is specific and was found by measurement, not review: Nova granted the same
 * 335 cosmetics to every build, and one of them — EID_Conga — is a Chapter 1 Season 8 emote being
 * handed to 7.40, a Season 7 build with no assets for it.
 *
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { COSMETIC_ERA, existsByEra } from './cosmetics';

describe('cosmetic era data', () => {
  test('knows the era of a useful share of what Nova grants', () => {
    assert.ok(COSMETIC_ERA.size > 50, `only ${COSMETIC_ERA.size} ids have an era`);
  });

  test('has no entry outside Chapters 1-7 or Seasons 1-12', () => {
    for (const [id, era] of COSMETIC_ERA) {
      assert.ok(era.chapter >= 1 && era.chapter <= 7, `${id}: chapter ${era.chapter}`);
      if (era.season !== null) {
        assert.ok(era.season >= 1 && era.season <= 12, `${id}: season ${era.season}`);
      }
    }
  });
});

describe('existsByEra', () => {
  // THE REGRESSION. Chapter 1 Season 8 emote, Chapter 1 Season 7 build.
  test('does not give EID_Conga to a 7.40 client', () => {
    assert.deepEqual(COSMETIC_ERA.get('EID_Conga'), { chapter: 1, season: 8 });
    assert.equal(existsByEra('EID_Conga', 1, 7), false);
  });

  test('does give EID_Conga to Season 8 and later', () => {
    assert.equal(existsByEra('EID_Conga', 1, 8), true);
    assert.equal(existsByEra('EID_Conga', 1, 9), true);
    assert.equal(existsByEra('EID_Conga', 2, 1), true);
  });

  test('keeps a launch skin available in every later era', () => {
    // CID_001 is a Chapter 1 Season 1 default and is the seed profile's equipped character.
    for (const [ch, sn] of [[1, 1], [1, 7], [2, 1], [3, 4], [4, 5]] as const) {
      assert.equal(existsByEra('CID_001_Athena_Commando_F_Default', ch, sn), true, `C${ch}S${sn}`);
    }
  });

  test('compares chapter before season, so C2S1 beats C1S8', () => {
    assert.equal(existsByEra('EID_Conga', 2, 1), true);   // later chapter, lower season number
  });

  test('treats an id it has never seen as always available', () => {
    // Preserves the previous behaviour for the 238 granted ids the corpus does not cover. The
    // filter's job is to remove what provably post-dates a build, not everything unvouched-for.
    assert.equal(existsByEra('CID_NOT_IN_ANY_CORPUS', 1, 7), true);
    // The CosmeticLocker item's key must survive the filter or the locker itself disappears.
    assert.equal(existsByEra('sandbox_loadout', 1, 7), true);
  });

  test('never grants a special season, whose ordinal is not established', () => {
    for (const [id, era] of COSMETIC_ERA) {
      if (era.season === null) assert.equal(existsByEra(id, 7, 12), false, id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  END TO END. The unit tests above prove the predicate; this proves the WIRING — that a real
//  QueryProfile over HTTP, identified only by its User-Agent, actually gets an era-correct locker.
//  Without this the filter could be perfect and never called.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import os from 'node:os';
import path from 'node:path';
import { before } from 'node:test';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-cosmetics-${process.pid}.db`);

let app: any;

before(async () => {
  const Fastify = (await import('fastify')).default;
  const formbody = (await import('@fastify/formbody')).default;
  const dbm = await import('../database');
  const { mcpRoutes } = (await import('../services/mcp/mcp.routes')) as any;
  const { versionRouter } = (await import('../middleware/version-router')) as any;

  await dbm.initDatabase();
  app = Fastify({ logger: false });
  await app.register(formbody);
  app.addHook('onRequest', versionRouter);
  await app.register(mcpRoutes);
  await app.ready();
});

/** The unauthenticated read-only route: enough for QueryProfile, and needs no token to drive. */
const lockerFor = async (build: string): Promise<string[]> => {
  const res = await app.inject({
    method: 'POST',
    url: `/fortnite/api/game/v2/profile/e2e-${build.replace('.', '')}/public/QueryProfile?profileId=athena&rvn=-1`,
    headers: {
      'user-agent': `Fortnite/++Fortnite+Release-${build}-CL-9999999 Windows/10.0.17763`,
      'content-type': 'application/json',
    },
    payload: {},
  });
  assert.equal(res.statusCode, 200, `${build} -> HTTP ${res.statusCode}`);
  const full = res.json().profileChanges.find((c: any) => c.changeType === 'fullProfileUpdate');
  assert.ok(full, `${build}: no fullProfileUpdate in the response`);
  return Object.keys(full.profile.items);
};

describe('QueryProfile over HTTP serves an era-correct locker', () => {
  test('a 7.40 client is not sent the Season 8 emote', async () => {
    const items = await lockerFor('7.40');
    assert.ok(!items.includes('AthenaDance:EID_Conga'), 'EID_Conga leaked into a Season 7 locker');
  });

  test('an 8.30 client IS sent it — the filter removes, it does not just delete', async () => {
    const items = await lockerFor('8.30');
    assert.ok(items.includes('AthenaDance:EID_Conga'), 'EID_Conga missing from a Season 8 locker');
  });

  test('a Chapter 2 client is sent it too — chapter outranks season number', async () => {
    const items = await lockerFor('11.31');
    assert.ok(items.includes('AthenaDance:EID_Conga'));
  });

  test('the locker item itself survives every era', async () => {
    for (const build of ['7.40', '8.30', '11.31', '19.01']) {
      assert.ok((await lockerFor(build)).includes('sandbox_loadout'), `${build} lost its locker`);
    }
  });

  test('7.40 loses ONLY what post-dates it, not a meaningful chunk of its locker', async () => {
    // Guards the direction of the comparison. An inverted operator would empty the locker instead,
    // and every "is X absent" assertion above would still pass.
    const s7 = await lockerFor('7.40');
    const s8 = await lockerFor('8.30');
    assert.equal(s8.length - s7.length, 1, `expected exactly EID_Conga to differ, got ${s8.length - s7.length}`);
    assert.ok(s7.length > 300, `7.40 locker collapsed to ${s7.length} items`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  enabled_features — the one endpoint the corpus documents with both an old and a current response.
//  See the comment on the route in social.routes.ts for the evidence and for why the boundary is
//  INFERRED rather than measured.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('enabled_features follows the calling build', () => {
  let social: any;

  const featuresFor = async (build?: string) => {
    const res = await social.inject({
      method: 'GET',
      url: '/fortnite/api/game/v2/enabled_features',
      headers: build
        ? { 'user-agent': `Fortnite/++Fortnite+Release-${build}-CL-9999999 Windows/10.0.17763` }
        : {},
    });
    assert.equal(res.statusCode, 200);
    return res.json();
  };

  before(async () => {
    const Fastify = (await import('fastify')).default;
    const { socialRoutes } = (await import('../services/social/social.routes')) as any;
    const { versionRouter } = (await import('../middleware/version-router')) as any;
    social = Fastify({ logger: false });
    social.addHook('onRequest', versionRouter);
    await social.register(socialRoutes);
    await social.ready();
  });

  test('a 2017 build gets ["store"]', async () => {
    assert.deepEqual(await featuresFor('1.11'), ['store']);
    assert.deepEqual(await featuresFor('2.50'), ['store']);
  });

  test('every later build gets [] — including the protected 7.40 baseline', async () => {
    for (const build of ['3.00', '7.40', '8.30', '11.31', '19.01', '27.11']) {
      assert.deepEqual(await featuresFor(build), [], build);
    }
  });

  test('an unidentifiable request gets [], not the 2017 shape', async () => {
    // The fallback major is configured, so this must not be allowed to trip the 2017 branch by
    // accident. [] is the safe direction: it is what every build since 2018 expects.
    assert.deepEqual(await featuresFor(undefined), []);
  });
});

describe('an era that was GUESSED must not filter anything', () => {
  // THE BUG THIS PINS, found 2026-09-06 against a real pre-Chapter-1 binary
  // (++Fortnite+Release-Live-CL-3240987, UE 4.14, Dec 2016 — no Athena, no BattleRoyale).
  //
  // identifyVersion fills in chapter and season even when it parses nothing, taking them from the
  // CONFIGURED FALLBACK and marking the result UNKNOWN. The first version of the era filter checked
  // only that chapter/season were numbers, so a build it could not identify — and a bare curl
  // request — were both served a Chapter 1 Season 7 locker as though that had been measured.
  //
  // Null-checking the fields is not enough. The confidence is the only honest signal.
  test('a Release-Live build is not filtered as Chapter 1 Season 7', async () => {
    const items = await lockerFor('Live');
    assert.ok(
      items.includes('AthenaDance:EID_Conga'),
      'an unidentifiable build had its locker filtered on a fallback guess',
    );
  });

  test('a request with no version at all is not filtered either', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/fortnite/api/game/v2/profile/e2e-noua/public/QueryProfile?profileId=athena&rvn=-1',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const full = res.json().profileChanges.find((c: any) => c.changeType === 'fullProfileUpdate');
    assert.ok(full.profile.items['AthenaDance:EID_Conga'], 'no-UA request was filtered on a guess');
  });

  test('but a build it CAN identify is still filtered', () => {
    // The guard must not have been bought by disabling the feature.
    assert.equal(existsByEra('EID_Conga', 1, 7), false);
  });
});
