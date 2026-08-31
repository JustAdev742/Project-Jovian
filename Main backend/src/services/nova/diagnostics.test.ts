/**
 * Regression tests for the structured diagnostics store.
 *
 * Each test here exists because of a specific defect found in the 2026-08-31 audit. The point is not
 * coverage for its own sake — it is that the two failures which cost this project the most time
 * (secrets in logs, and evidence evicted before anyone could read it) now cannot come back silently.
 *
 * Run: npm test
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  redactSecrets,
  normaliseRoute,
  subsystemFor,
  recordDiagnostic,
  getDiagnostics,
  getDiagnosticsSummary,
  clearDiagnostics,
} from './diagnostics';

beforeEach(() => clearDiagnostics());

describe('redactSecrets — NOVA-AUDIT-001, live tokens were served by /nova/api/logs', () => {
  test('strips an eg1~ session token from a URL path', () => {
    // This is the exact shape 7.40 sends at sign-out, 76 times in the retained cobalt.log.
    const url = '/account/api/oauth/sessions/kill/eg1~eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYmMifQ.SIG';
    const out = redactSecrets(url);
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT body must not survive');
    assert.ok(out.includes('eg1~<redacted>'), 'the shape should stay readable');
    assert.ok(out.startsWith('/account/api/oauth/sessions/kill/'), 'the diagnostic value must survive');
  });

  test('strips a bare JWT that carries no eg1~ prefix', () => {
    const out = redactSecrets('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-_123');
    assert.ok(!out.includes('eyJzdWIiOiIxMjM0NTY3ODkwIn0'));
  });

  test('strips secret-bearing query parameters', () => {
    const out = redactSecrets('/auth?access_token=abc123&password=hunter2&keep=this');
    assert.ok(!out.includes('abc123'));
    assert.ok(!out.includes('hunter2'));
    assert.ok(out.includes('keep=this'), 'non-secret params must survive for diagnosis');
  });

  test('strips an Authorization-style credential from a message body', () => {
    assert.ok(!redactSecrets('failed with Bearer abc.def.ghi').includes('abc.def.ghi'));
  });

  test('leaves an ordinary URL untouched', () => {
    const url = '/fortnite/api/game/v2/enabled_features';
    assert.equal(redactSecrets(url), url);
  });
});

describe('normaliseRoute — aggregation is what stops evidence being evicted', () => {
  test('collapses 32-hex account ids', () => {
    assert.equal(
      normaliseRoute('/fortnite/api/game/v2/profile/03eebb6c289fc13e0dd0b60617757122/client/QueryProfile'),
      '/fortnite/api/game/v2/profile/{accountId}/client/QueryProfile',
    );
  });

  test('collapses session UUIDs', () => {
    assert.equal(
      normaliseRoute('/fortnite/api/matchmaking/session/ffa3eb5d-ef1d-4af2-9a47-86d66171a7c0/join'),
      '/fortnite/api/matchmaking/session/{uuid}/join',
    );
  });

  test('collapses a token segment, so a token can never become a map key', () => {
    assert.equal(
      normaliseRoute('/account/api/oauth/sessions/kill/eg1~eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig'),
      '/account/api/oauth/sessions/kill/{token}',
    );
  });

  test('drops the query string', () => {
    assert.equal(normaliseRoute('/x/y?profileId=athena&rvn=1'), '/x/y');
  });
});

describe('subsystemFor — severity weighting depends on this being right', () => {
  test('classifies the subsystems that carry the highest weight', () => {
    assert.equal(subsystemFor('/fortnite/api/game/v2/matchmakingservice/ticket/player/{accountId}'), 'matchmaking');
    assert.equal(subsystemFor('/account/api/oauth/token'), 'auth');
    assert.equal(subsystemFor('/fortnite/api/game/v2/profile/{accountId}/client/QueryProfile'), 'mcp');
    assert.equal(subsystemFor('/datarouter/api/v1/public/data'), 'telemetry');
  });
});

describe('recordDiagnostic — aggregation, counting and bounds', () => {
  test('repeats of the same problem become one row with a counter', () => {
    // 706 datarouter calls in one real session is the case that broke the old ring buffer.
    for (let i = 0; i < 706; i++) {
      recordDiagnostic({ category: 'MISSING', method: 'POST', url: '/datarouter/api/v1/public/data' });
    }
    const rows = getDiagnostics();
    assert.equal(rows.length, 1, 'must aggregate to a single row');
    assert.equal(rows[0].count, 706);
  });

  test('a flood of one problem does not evict a different, rarer one', () => {
    // The exact failure mode of the old 800-entry FIFO: the important line was pushed out by noise.
    recordDiagnostic({
      category: 'AUTH_FAILURE', method: 'POST', url: '/account/api/oauth/token', status: 401,
    });
    for (let i = 0; i < 5000; i++) {
      recordDiagnostic({ category: 'MISSING', method: 'POST', url: '/datarouter/api/v1/public/data' });
    }
    const auth = getDiagnostics().find((e) => e.category === 'AUTH_FAILURE');
    assert.ok(auth, 'the rare auth failure must still be present after 5000 noisy events');
    assert.equal(auth!.count, 1);
  });

  test('counts distinct affected users without retaining account ids', () => {
    for (const id of ['aaa', 'bbb', 'aaa', 'ccc']) {
      recordDiagnostic({ category: 'MISSING', method: 'GET', url: '/x', accountId: id });
    }
    const row = getDiagnostics()[0];
    assert.equal(row.affectedUsers, 3);
    assert.ok(!JSON.stringify(row).includes('aaa'), 'no raw account id may appear in the API response');
  });

  test('separates the same endpoint across different game builds', () => {
    recordDiagnostic({ category: 'MISSING', method: 'GET', url: '/x', version: 'Release-7.40' });
    recordDiagnostic({ category: 'MISSING', method: 'GET', url: '/x', version: 'Release-8.51' });
    assert.equal(getDiagnostics().length, 2, 'version is part of the identity of a problem');
  });

  test('redacts a token that arrives inside the detail field', () => {
    recordDiagnostic({
      category: 'INTERNAL_ERROR', method: 'GET', url: '/x',
      detail: 'upstream rejected eg1~eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig',
    });
    assert.ok(!JSON.stringify(getDiagnostics()).includes('eyJhbGciOiJIUzI1NiJ9'));
  });

  test('never throws, whatever it is handed', () => {
    assert.doesNotThrow(() => {
      recordDiagnostic({ category: 'UNKNOWN', method: 'GET', url: undefined as any });
      recordDiagnostic({ category: 'UNKNOWN', method: 'GET', url: '' });
    });
  });
});

describe('severity model — importance must beat raw volume', () => {
  test('a rare matchmaking failure outranks a very common telemetry one', () => {
    // The brief's requirement, stated directly: "A cosmetic problem affecting many people may be
    // less serious than a matchmaking problem affecting fewer people."
    for (let i = 0; i < 1000; i++) {
      recordDiagnostic({ category: 'MISSING', method: 'POST', url: '/datarouter/api/v1/public/data', accountId: `u${i}` });
    }
    for (let i = 0; i < 3; i++) {
      recordDiagnostic({
        category: 'INTERNAL_ERROR', method: 'POST', status: 500,
        url: '/fortnite/api/game/v2/matchmakingservice/ticket/player/03eebb6c289fc13e0dd0b60617757122',
        accountId: `m${i}`,
      });
    }
    const rows = getDiagnostics();
    const top = rows[0];
    assert.equal(top.subsystem, 'matchmaking', `expected matchmaking to rank first, got ${top.subsystem}`);
    assert.equal(top.severity, 'HIGH', 'three blocked players is serious but not yet widespread');

    // And the converse half of the same requirement: sheer volume must not manufacture urgency.
    const telemetry = rows.find((e) => e.subsystem === 'telemetry')!;
    assert.equal(telemetry.count, 1000);
    assert.ok(
      ['MEDIUM', 'LOW', 'INFORMATIONAL'].includes(telemetry.severity),
      `1000 telemetry misses should not outrank a matchmaking outage, got ${telemetry.severity}`,
    );
  });

  test('a widespread, growing matchmaking outage does reach CRITICAL', () => {
    for (let i = 0; i < 100; i++) {
      recordDiagnostic({
        category: 'INTERNAL_ERROR', method: 'POST', status: 500,
        url: '/fortnite/api/game/v2/matchmakingservice/ticket/player/03eebb6c289fc13e0dd0b60617757122',
        accountId: `p${i}`,
      });
    }
    assert.equal(getDiagnostics()[0].severity, 'CRITICAL');
  });

  test('summary rolls up by category, subsystem and severity', () => {
    recordDiagnostic({ category: 'MISSING', method: 'GET', url: '/fortnite/api/cloudstorage/system' });
    recordDiagnostic({ category: 'AUTH_FAILURE', method: 'POST', url: '/account/api/oauth/token', status: 401 });
    const s = getDiagnosticsSummary();
    assert.equal(s.totalEvents, 2);
    assert.equal(s.distinctProblems, 2);
    assert.equal(s.byCategory.MISSING, 1);
    assert.equal(s.bySubsystem.auth, 1);
  });
});
