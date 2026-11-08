import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FindingSet, makeFinding, redact, MAX_SAMPLES } from '../lib/finding.mjs';

test('redaction removes every secret shape this project has leaked', () => {
  const s = redact([
    '-AUTH_PASSWORD=eg1~eyJhbGciOi.eyJzdWIi.sig_x-y',
    'Authorization: bearer abc.def.ghi',
    'GET /x?secret=hunter2&ok=1',
    'NOVA_AC_ADMIN_SECRET=supersecret',
    'tskey-api-kAbCdEf123',
    '{"access_token":"zzz"}',
  ].join('\n'));
  for (const leaked of ['eyJzdWIi', 'abc.def.ghi', 'hunter2', 'supersecret', 'kAbCdEf123', '"zzz"']) {
    assert.ok(!s.includes(leaked), `leaked ${leaked}: ${s}`);
  }
  assert.ok(s.includes('ok=1'), 'non-secret parameters must survive');
});

test('a bare JWT is redacted too', () => {
  assert.ok(!redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMyJ9.c2ln end').includes('eyJzdWIi'));
});

test('the Windows account name and IP host parts are trimmed; loopback and versions survive', () => {
  const s = redact('C:\\Users\\Admin\\AppData\\Local\\x.log from 100.96.188.28:7777 to 127.0.0.1:3551 build 4.22.0.5046157 bind 0.0.0.0');
  assert.ok(s.includes('C:\\Users\\<user>\\AppData'), s);
  assert.ok(!s.includes('Admin'), s);
  assert.ok(s.includes('100.96.x.x:7777'), s);
  assert.ok(s.includes('127.0.0.1:3551'), s);
  assert.ok(s.includes('4.22.0.5046157'), 'a version string is not an address');
  assert.ok(s.includes('0.0.0.0'), s);
});

test('an exit code is not mistaken for a secret', () => {
  // The C++ redactor once turned "code=3221225477" into "<redacted>" (DIAGNOSTICS_ARCHITECTURE §6).
  assert.ok(redact('Gameserver exited (code=3221225477)').includes('3221225477'));
});

test('malformed findings are refused', () => {
  assert.throws(() => makeFinding({ id: 'x', severity: 'P9', confidence: 'CONFIRMED' }));
  assert.throws(() => makeFinding({ id: 'x', severity: 'P1', confidence: 'SURE' }));
  assert.throws(() => makeFinding({ severity: 'P1', confidence: 'CONFIRMED' }));
});

test('the same key merges: counts add, the range widens, the stronger grade wins', () => {
  const F = new FindingSet();
  F.add({ id: 'a', severity: 'P2', confidence: 'POTENTIAL', count: 3, firstSeen: '2026-09-02', lastSeen: '2026-09-03' });
  F.add({ id: 'a', severity: 'P1', confidence: 'CONFIRMED', count: 2, firstSeen: '2026-09-01', lastSeen: '2026-09-09' });
  const f = F.get('a');
  assert.equal(f.count, 5);
  assert.equal(f.firstSeen, '2026-09-01');
  assert.equal(f.lastSeen, '2026-09-09');
  assert.equal(f.severity, 'P1');
  assert.equal(f.confidence, 'CONFIRMED');
});

test('samples are capped but the count never is', () => {
  const F = new FindingSet();
  for (let i = 0; i < 50; i++) F.add({ id: 'b', severity: 'P3', confidence: 'CONFIRMED', evidence: [{ excerpt: `line ${i}` }] });
  assert.equal(F.get('b').count, 50);
  assert.equal(F.get('b').evidence.length, MAX_SAMPLES);
});

test('ordering puts open, severe, confirmed problems first', () => {
  const F = new FindingSet();
  F.add({ id: 'low', severity: 'P3', confidence: 'CONFIRMED' });
  F.add({ id: 'benign', severity: 'P0', confidence: 'CONFIRMED', status: 'known-benign' });
  F.add({ id: 'lead', severity: 'P0', confidence: 'POTENTIAL' });
  F.add({ id: 'real', severity: 'P0', confidence: 'CONFIRMED' });
  assert.deepEqual(F.list().map(f => f.id), ['real', 'lead', 'low', 'benign']);
});

test('evidence excerpts are redacted on the way in', () => {
  const f = makeFinding({ id: 'c', severity: 'P1', confidence: 'CONFIRMED', evidence: [{ excerpt: 'x eg1~abcdefabcdef.zz y' }] });
  assert.ok(!f.evidence[0].excerpt.includes('abcdefabcdef'));
});
