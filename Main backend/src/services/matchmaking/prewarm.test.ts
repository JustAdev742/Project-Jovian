/**
 * Pre-warm: a server is started while players are in the lobby, not after they press Play.
 *
 * WHY THIS EXISTS. 2026-11-08: a player sat in the lobby for 64s, pressed Play, and then waited 62s
 * in the queue while a server was started for them from cold. The agent now sends lobby=1 once its
 * player's game has had time to boot, and should-i-serve treats that as demand. These tests pin the
 * three things that must stay true: an old agent (no lobby flag) sees exactly the old behaviour; a
 * lobby player gets a host elected; and two lobby players never produce two servers.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-prewarm-${process.pid}.db`);
process.env.NOVA_HOST_ELECTION = '1';
delete process.env.NOVA_COORDINATOR;
delete process.env.NOVA_PREWARM;

let app: FastifyInstance;
let Config: any;

before(async () => {
  Config = (await import('../../config')).Config;
  const { matchmakingRoutes } = await import('./matchmaking.routes');
  app = Fastify({ logger: false });
  await app.register(matchmakingRoutes);
  await app.ready();
});

const ask = async (accountId: string, extra = '', playlist = 'playlist_defaultsolo', region = 'EU') =>
  (await app.inject({
    method: 'GET',
    url: `/nova/api/host/should-i-serve?accountId=${accountId}&playlist=${playlist}&region=${region}&address=100.64.0.${accountId.length}&port=7777${extra}`,
  })).json();

describe('pre-warm', () => {
  test('an agent that does not send lobby=1 sees the old behaviour: no queue, no server', async () => {
    const v = await ask('oldagent0000000000000000000000aa');
    assert.equal(v.serve, false);
    assert.equal(v.reason, 'no-demand');
  });

  test('a player in the lobby gets a server started before anyone presses Play', async () => {
    const v = await ask('lobbyplayer0000000000000000000aa', '&lobby=1');
    assert.equal(v.serve, true, JSON.stringify(v));
    assert.equal(v.prewarm, true);
    assert.match(v.reason, /^prewarm:elected$/);
  });

  test('a second lobby player does not start a second server for the same lobby', async () => {
    const v = await ask('secondlobby000000000000000000bbb', '&lobby=1');
    assert.equal(v.serve, false, JSON.stringify(v));
    assert.match(v.reason, /another-host-pending/);
  });

  test('the elected machine keeps its claim while it boots', async () => {
    const v = await ask('lobbyplayer0000000000000000000aa', '&lobby=1');
    assert.equal(v.serve, true);
  });

  test('NOVA_PREWARM=0 turns it off: a lobby flag alone is not demand', async () => {
    Config.PREWARM = false;
    try {
      const v = await ask('thirdlobby0000000000000000000ccc', '&lobby=1', 'playlist_defaultduo');
      assert.equal(v.serve, false);
      assert.equal(v.reason, 'no-demand');
    } finally {
      Config.PREWARM = true;
    }
  });
});
