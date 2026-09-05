/**
 * Anti-cheat tests.
 *
 * The failure that matters most here is not a missed cheat — it is a FALSE POSITIVE. This system
 * writes flags that accumulate into a 24-hour risk total, and `NOVA_AC_AUTOBAN_AT` turns that total
 * into an automatic ban. Wrongly locking out a real player is worse than reviewing a cheater a day
 * late, and the service's own comments say so. So most of what is asserted below is that innocent
 * input stays unflagged.
 *
 * Run: npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

const DB = path.join(os.tmpdir(), `nova-anticheat-${process.pid}.db`);
process.env.NOVA_DB_PATH = DB;

// Dynamic imports for the reason documented in friends-auth.test.ts: `import` is hoisted above the
// assignment above, and a static import would resolve Config.DB_PATH to the REAL database.
let svc: any, dbm: any, anticheatRoutes: any, authRoutes: any, statsRoutes: any;
let app: FastifyInstance;
let token = '', self = '';

function assertScratchDatabase(resolved: string): void {
  const real = path.resolve(__dirname, '..', '..', '..', 'data', 'nova.db');
  assert.notEqual(path.resolve(resolved), path.resolve(real), 'REFUSING TO RUN against the real database');
  assert.ok(path.resolve(resolved).startsWith(path.resolve(os.tmpdir())), `REFUSING TO RUN: ${resolved} is not a temp path`);
}

before(async () => {
  const { Config } = await import('../../config');
  assertScratchDatabase(Config.DB_PATH);
  svc = await import('./anticheat.service');
  dbm = await import('../../database');
  ({ anticheatRoutes } = await import('./anticheat.routes') as any);
  ({ authRoutes } = await import('../auth/auth.routes') as any);
  ({ statsRoutes } = await import('../stats/stats.routes') as any);

  await dbm.initDatabase();
  app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(authRoutes);
  await app.register(anticheatRoutes);
  await app.register(statsRoutes);
  await app.ready();

  const res = await app.inject({
    method: 'POST', url: '/account/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=achost&password=x',
  });
  token = res.json().access_token;
  self = res.json().account_id;
});

after(async () => {
  await app?.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* fine */ } }
});

describe('attestation: legitimate modules must not be flagged', () => {
  const suspicious = (mods: string[]) =>
    svc.analyzeAttestation(mods).filter((d: any) => d.rule === 'attestation.suspicious_module');

  test('real Windows and vendor binaries that CONTAIN a suspicious word are not flagged', () => {
    // Every one of these is a genuine signed binary, and every one tripped the old naive substring
    // rule at severity 7. Found by sweeping 6,120 binary names across System32 and Program Files.
    const innocent = [
      'EasyAntiCheat_EOS.exe',            // Epic's OWN anti-cheat — Fortnite ships it. "cheat"
      'FDResPub.dll',                     // Function Discovery Resource Publication. r-ESP-ub
      'gamingservicesproxy.dll',          // Xbox Gaming Services. servic-ESP-roxy
      'SystemPropertiesPerformance.exe',  // properti-ESP-erformance
      'SystemPropertiesProtection.exe',
      'ThreatResponseEngine.dll',         // r-ESP-onse
      'imagesp1.dll',
      'libespeak-ng.dll',                 // speech synthesis / accessibility
      'espeak-ng.exe',
      'mavinject.exe',                    // signed Microsoft App-V injector
      'ttdinject.exe',                    // signed Microsoft Time Travel Debugging
    ];
    const hits = suspicious(innocent);
    assert.deepEqual(hits.map((d: any) => d.detail), [],
      'a legitimate signed binary must never reach severity 7 on a substring collision');
  });

  test('three innocent modules would have cleared a typical autoban threshold', () => {
    // Why the above matters rather than being cosmetic: severity 7 x 3 = 21, and the config's own
    // example threshold is in that range. gamingservicesproxy.dll alone is on a lot of gaming PCs.
    assert.equal(svc.analyzeAttestation(['gamingservicesproxy.dll', 'FDResPub.dll', 'EasyAntiCheat_EOS.exe'])
      .filter((d: any) => d.rule === 'attestation.suspicious_module')
      .reduce((n: number, d: any) => n + d.severity, 0), 0);
  });

  test('cheat-shaped names are still caught, including bare and decorated esp', () => {
    const cheats = ['esp.dll', 'ESP_Module.dll', 'esp-loader.dll', 'esp2.dll', 'aimbot.dll',
      'wallhack64.dll', 'cheat.dll', 'hack.dll', 'xenos.exe', 'ExtremeInjector.exe',
      'processhacker.exe', 'CheatEngine.dll', 'unknowncheats.dll', 'skinchanger.dll',
      'spoofer.exe', 'bypass.dll', 'injector.exe', 'inject.dll'];
    assert.equal(suspicious(cheats).length, cheats.length, 'every cheat-shaped name must still flag');
  });

  test('Nova\'s own required injections are allow-listed, not flagged', () => {
    // The game only runs BECAUSE Nova injects. Flagging its own DLLs would flag every player.
    const nova = ['GFSDK_Aftermath_Lib.x64.dll', 'Project Reboot.dll', 'Cobalt.dll'];
    assert.deepEqual(suspicious(nova), []);
    assert.deepEqual(svc.analyzeAttestation(nova).filter((d: any) => d.rule === 'attestation.unknown_modules'), []);
  });

  test('unknown modules stay at severity 1 and aggregate into one flag', () => {
    const dets = svc.analyzeAttestation(['weird1.dll', 'weird2.dll', 'weird3.dll']);
    assert.equal(dets.length, 1);
    assert.equal(dets[0].severity, 1);
  });
});

describe('match plausibility', () => {
  test('a genuinely excellent match is not flagged', () => {
    // 20 kills in a 100-player 18-minute win is outstanding but possible. Flagging it would punish
    // the best players on the server.
    assert.deepEqual(
      svc.analyzeMatchReport({ accountId: 'a', matchId: 'm', playersInMatch: 100, kills: 20, damage: 6000, placement: 1, durationSec: 1080 }),
      [],
    );
  });

  test('more kills than players is flagged', () => {
    const d = svc.analyzeMatchReport({ accountId: 'a', matchId: 'm', playersInMatch: 10, kills: 12, damage: 1200, placement: 1, durationSec: 600 });
    assert.ok(d.some((x: any) => x.rule === 'match.kills_exceed_players'));
  });

  test('a short burst of kills is not flagged, but a sustained impossible rate is', () => {
    const burst = svc.analyzeMatchReport({ accountId: 'a', matchId: 'm', playersInMatch: 100, kills: 8, damage: 2000, placement: 5, durationSec: 100 });
    assert.ok(!burst.some((x: any) => x.rule === 'match.kill_rate'), 'the 3-minute floor protects short bursts');
    const sustained = svc.analyzeMatchReport({ accountId: 'a', matchId: 'm', playersInMatch: 100, kills: 60, damage: 20000, placement: 1, durationSec: 600 });
    assert.ok(sustained.some((x: any) => x.rule === 'match.kill_rate'));
  });
});

describe('report authority — flags must land on the right account', () => {
  test('every player in a match can be reported, not just the first', async () => {
    // THE REGRESSION. `participants` is read from match_participants — the table of results ALREADY
    // RECORDED — and was used both as "was the subject in this match" and as the duplicate check.
    // Once any player's results were stored, every OTHER player in the same match looked like they
    // "were not in the match", so the honest host collected a severity-8 flag per remaining player
    // and their results were discarded.
    const matchId = dbm.recordMatch('sess-1', 'Playlist_DefaultSolo', 'NAE', self);
    const post = (subject: string) => app.inject({
      method: 'POST', url: '/nova/api/anticheat/report',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      payload: { matchId, subjectAccountId: subject, playersInMatch: 4, kills: 1, damage: 300, placement: 2, durationSec: 600 },
    });

    const first = await post('player-one');
    assert.equal(first.json().accepted, true, 'the first player must be accepted');

    const second = await post('player-two');
    assert.equal(second.json().accepted, true, 'the SECOND player must be accepted too');
    assert.equal(second.json().reporterFlags, 0, 'the honest host must not be flagged for reporting a second player');

    const third = await post('player-three');
    assert.equal(third.json().accepted, true);
    assert.equal(third.json().reporterFlags, 0);
  });

  test('re-reporting the same player IS still a duplicate', async () => {
    const matchId = dbm.recordMatch('sess-2', 'Playlist_DefaultSolo', 'NAE', self);
    const post = () => app.inject({
      method: 'POST', url: '/nova/api/anticheat/report',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      payload: { matchId, subjectAccountId: 'dupe-player', playersInMatch: 4, kills: 1, damage: 300, placement: 2, durationSec: 600 },
    });
    assert.equal((await post()).json().accepted, true);
    const again = await post();
    assert.equal(again.json().accepted, false, 'the same player twice must be rejected');
  });

  test('a non-host reporting someone else\'s match is flagged, and the SUBJECT is not', async () => {
    const matchId = dbm.recordMatch('sess-3', 'Playlist_DefaultSolo', 'NAE', 'someone-else');
    const res = await app.inject({
      method: 'POST', url: '/nova/api/anticheat/report',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      payload: { matchId, subjectAccountId: 'victim-player', playersInMatch: 4, kills: 1, damage: 300, placement: 2, durationSec: 600 },
    });
    const body = res.json();
    assert.equal(body.accepted, false);
    assert.ok(body.reporterFlags > 0, 'the reporter is responsible for an authority violation');
    assert.equal(body.subjectFlags, 0, 'the subject must not be flagged for someone else\'s bad report');
    assert.equal(dbm.getAnticheatRisk('victim-player'), 0, 'anti-cheat must not be usable to grief another player');
  });
});

describe('admin endpoints fail closed', () => {
  test('with no secret configured, admin views are refused rather than open', async () => {
    // Config.AC_ADMIN_SECRET and REGISTER_SECRET are both empty by default.
    const flags = await app.inject({ method: 'GET', url: '/nova/api/anticheat/flags' });
    assert.equal(flags.statusCode, 403);
    const ban = await app.inject({
      method: 'POST', url: '/nova/api/anticheat/ban',
      headers: { 'content-type': 'application/json' },
      payload: { accountId: self, banned: true },
    });
    assert.equal(ban.statusCode, 403);
    assert.notEqual(dbm.getAccount(self)?.banned, 1, 'nobody may be banned without the admin secret');
  });

  test('attest and report require authentication', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/nova/api/anticheat/attest', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/nova/api/anticheat/report', payload: {} })).statusCode, 401);
  });
});
