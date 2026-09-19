/**
 * Region-aware matchmaking and global self-hosting.
 *
 * WHY THIS EXISTS. Both features were built and neither had a single test. They are also the two
 * that are hardest to check by playing: on one machine in one country every region path collapses to
 * the trivial case and looks perfect, and the bugs only appear once players are on different
 * continents — which is exactly when nobody is in a position to debug it.
 *
 * The regression that prompted this is the one in `hasLiveGameServer`. `getHostDemand` asks it
 * whether a host is needed, and it used to answer from a region-BLIND fallback, so a single joinable
 * server anywhere on earth made `needsHost` false for every region. No second host was ever elected
 * and every distant player was routed across the planet — with the election's 65% proximity weighting
 * looking perfectly correct in the code and never being consulted, because the demand it reacts to
 * had already been answered. See the fallback note in resolveGameServer.
 *
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-regions-${process.pid}.db`);

import { estimateRttMs, proximityScore, lobbyProximityScore, isRegion, regionLabel } from './regions';
import {
  registerDynamicServer,
  unregisterDynamicServer,
  hasLiveGameServer,
  getHostDemand,
  matchmakingStarted,
  matchmakingEnded,
  electionScore,
} from './matchmaking.routes';

/** A mesh candidate with sane defaults; override only what a test is about. */
function candidate(over: Partial<Parameters<typeof electionScore>[0]> = {}) {
  return {
    accountId: 'acct',
    tsIp: '100.0.0.1',
    cpuCores: 8,
    ramGB: 16,
    netScore: 80,
    region: 'EU',
    score: 50,
    lastSeen: Date.now(),
    ...over,
  };
}

describe('region distance maths', () => {
  test('same region is near, and distance orders correctly', () => {
    // Only the ORDERING has to be right — the absolute numbers are acknowledged estimates.
    assert.ok(estimateRttMs('EU', 'EU') < estimateRttMs('EU', 'NAE'));
    assert.ok(estimateRttMs('EU', 'NAE') < estimateRttMs('EU', 'OCE'));
    assert.ok(estimateRttMs('OCE', 'NAW') < estimateRttMs('OCE', 'EU'));
  });

  test('an unknown region is treated as middling, not rewarded or punished', () => {
    const unknown = estimateRttMs('MOON', 'EU');
    assert.ok(unknown > estimateRttMs('EU', 'EU'), 'must not beat a same-region host');
    assert.ok(unknown < estimateRttMs('EU', 'OCE'), 'must not be punished like the far side of the world');
    assert.equal(isRegion('MOON'), false);
    assert.equal(regionLabel('MOON'), 'MOON', 'an unknown code is echoed rather than mislabelled');
  });

  test('proximity scores near-full marks in-region and collapses across the world', () => {
    // Not a literal 100: same-region is modelled as 15ms, which the curve scores 94. What matters
    // is that every in-region candidate gets the SAME near-top mark, so hardware breaks the tie.
    assert.ok(proximityScore('EU', 'EU') >= 90, 'in-region must be near-perfect');
    assert.equal(proximityScore('EU', 'EU'), proximityScore('OCE', 'OCE'), 'and equal everywhere');

    assert.ok(proximityScore('EU', 'NAE') < proximityScore('EU', 'EU'));
    assert.ok(proximityScore('EU', 'OCE') < proximityScore('EU', 'NAE'));
    assert.ok(proximityScore('EU', 'OCE') < 25, 'the far side of the world must score poorly');
  });

  test('a lobby is scored on everyone in it, not the best case', () => {
    const allLocal = lobbyProximityScore('EU', ['EU', 'EU']);
    assert.ok(allLocal >= 90);

    // A host that is perfect for half the lobby and terrible for the other half must not outrank
    // one that is merely good for everyone.
    const split = lobbyProximityScore('EU', ['EU', 'OCE']);
    assert.ok(split < allLocal, `serving a distant player must cost something (got ${split})`);
    assert.ok(split > lobbyProximityScore('OCE', ['EU', 'EU']));
  });

  test('no waiters is not an error — it scores neutrally', () => {
    const empty = lobbyProximityScore('EU', []);
    assert.ok(Number.isFinite(empty) && empty >= 0 && empty <= 100);
  });
});

describe('host election (global self-hosting)', () => {
  test('a nearby mid-range machine beats a distant powerhouse', () => {
    // The claim electionScore's own comment makes. It is the whole reason proximity is weighted at
    // 65%: no amount of RAM compensates for 250ms.
    const near = candidate({ accountId: 'near', cpuCores: 4, ramGB: 8, region: 'EU', score: 30 });
    const far = candidate({ accountId: 'far', cpuCores: 16, ramGB: 32, region: 'OCE', score: 95 });
    const waiters = ['EU', 'EU', 'EU'];

    assert.ok(
      electionScore(near, waiters) > electionScore(far, waiters),
      'the local machine must win, or players get a playable-hardware server they cannot play on',
    );
  });

  test('within one region it still ranks on hardware', () => {
    // The normal case today. Proximity is equal for everyone, so the better machine must win —
    // otherwise this change would have made single-country setups worse.
    const beefy = candidate({ accountId: 'pc', cpuCores: 12, ramGB: 16, score: 70 });
    const weak = candidate({ accountId: 'laptop', cpuCores: 8, ramGB: 8, score: 40 });
    const waiters = ['EU', 'EU'];

    assert.ok(electionScore(beefy, waiters) > electionScore(weak, waiters));
  });

  test('a candidate that reports no region is still electable', () => {
    // Older launchers do not send one. Scoring them zero would silently stop them ever hosting.
    const noRegion = candidate({ accountId: 'old', region: '' });
    assert.ok(electionScore(noRegion, ['EU']) > 0);
  });
});

describe('region-aware demand — a distant server must not satisfy local players', () => {
  const PLAYLIST = 'playlist_defaultsolo';

  /** Register a server and hand back its cleanup, so a failing assert cannot leak into other tests. */
  function server(address: string, port: number, region: string) {
    registerDynamicServer(address, port, PLAYLIST, region, `srv-${region}`, 'ready');
    return () => unregisterDynamicServer(address, port, PLAYLIST);
  }

  test('a server in the player’s own region counts', () => {
    const done = server('10.0.0.1', 7777, 'EU');
    try {
      assert.equal(hasLiveGameServer(PLAYLIST, 'EU'), true);
    } finally { done(); }
  });

  test('THE REGRESSION: a server only in OCE does not count for an EU player', () => {
    const done = server('10.0.0.2', 7777, 'OCE');
    try {
      assert.equal(
        hasLiveGameServer(PLAYLIST, 'EU'), false,
        'an OCE server answering for EU is what stopped a second host ever being elected',
      );
      assert.equal(hasLiveGameServer(PLAYLIST, 'OCE'), true, 'it must still serve its own region');
    } finally { done(); }
  });

  test('so the coordinator asks for a host in the unserved region', () => {
    const done = server('10.0.0.3', 7777, 'OCE');
    const waiter = matchmakingStarted(PLAYLIST, 'EU');
    try {
      const eu = getHostDemand(PLAYLIST, 'EU');
      assert.equal(eu.hasServer, false);
      assert.equal(eu.needsHost, true, 'without this, the EU player waits forever or plays at 300ms');

      const oce = getHostDemand(PLAYLIST, 'OCE');
      assert.equal(oce.hasServer, true, 'the region that IS served must not spawn a redundant host');
      assert.equal(oce.needsHost, false);
    } finally { matchmakingEnded(waiter); done(); }
  });

  test('a wildcard server still serves everyone', () => {
    // How a single-machine setup registers. It must keep working exactly as before.
    const done = server('10.0.0.4', 7777, '*');
    try {
      assert.equal(hasLiveGameServer(PLAYLIST, 'EU'), true);
      assert.equal(hasLiveGameServer(PLAYLIST, 'OCE'), true);
    } finally { done(); }
  });

  test('a caller that sends no region is unaffected', () => {
    // Every launcher in the field before regions existed. Region-strictness must not strand them.
    const done = server('10.0.0.5', 7777, 'OCE');
    try {
      assert.equal(hasLiveGameServer(PLAYLIST), true);
      assert.equal(hasLiveGameServer(PLAYLIST, ''), true);
    } finally { done(); }
  });
});
