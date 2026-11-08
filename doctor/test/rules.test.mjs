/**
 * The catalog against lines in the formats the real logs use (copied from the 2026-11-08 evidence
 * survey), including the cases that produced wrong answers on the first runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, validateRules } from '../rules/signatures.mjs';

const rule = id => RULES.find(r => r.id === id);
const hit = (id, line) => { const r = rule(id); const m = r.re.exec(line); return m && !(r.skipIf && r.skipIf(m)) ? m : null; };

test('the catalog is well-formed (unique ids, regexes, sources, titles)', () => {
  assert.ok(validateRules());
});

test('the old offset format matches only "Failed to find3 X" — not PushWidget, not the new format', () => {
  assert.ok(hit('offset-not-found-legacy', '14:27:52.100 Failed to find3 InstigatedBy'));
  assert.equal(hit('offset-not-found-legacy', '14:27:03.000 Failed to find PushWidget (This may be fine)!'), null);
  assert.equal(hit('offset-not-found-legacy', "12:07:18.000 Failed to find property 'QuickBars' (see the offset report)"), null);
});

test('QuickBars is its own rule, not a generic offset miss', () => {
  const line = "12:07:18.000 Failed to find property 'QuickBars' (see the offset report)";
  assert.ok(hit('quickbars-property-missing', line));
  assert.equal(hit('offset-not-found', line), null);
});

test('the gameserver exit rule reads the real HostRunner format, signal included', () => {
  const crash = hit('gameserver-exit', '[HostRunner] Gameserver exited (code=3221225477 signal=null)');
  assert.equal(rule('gameserver-exit').classify(crash).title.includes('0xC0000005'), true);
  const term = hit('gameserver-exit', '[HostRunner] Gameserver exited (code=null signal=SIGTERM)');
  assert.equal(rule('gameserver-exit').classify(term).status, 'known-benign');
  assert.equal(rule('gameserver-exit').classify(hit('gameserver-exit', '[HostRunner] Gameserver exited (code=0)')).status, 'known-benign');
});

test('an escaped request is recognised by a foreign originatingService, and Nova\'s own are not', () => {
  assert.ok(hit('request-escaped-to-epic', '{"errorCode":"x","originatingService":"friends","intent":"prod"}'));
  assert.equal(hit('request-escaped-to-epic', '{"originatingService":"nova-backend"}'), null);
  assert.equal(hit('request-escaped-to-epic', '{"originatingService":"com.epicgames.account.public"}'), null);
});

test('bVerifyPeer = true is graded benign — it is in every log, including sessions that played', () => {
  assert.equal(rule('verifypeer-true').status, 'known-benign');
  assert.ok(hit('verifypeer-true', 'LogHttp: bVerifyPeer = true  - Libcurl will verify peer certificate'));
});

test('the critical-error rule is anchored to UE4\'s own line, not Cobalt\'s advice text', () => {
  assert.ok(hit('ue4-critical-error', '[2026.09.18-11.44.59:742][ 81]LogWindows: Error: === Critical error: ==='));
  assert.equal(hit('ue4-critical-error', '12:47:22.542 [Exception] see UE\'s === Critical error: === block in FortniteGame.log'), null);
});

test('XMPP on 3551 is fine; any other port is the cloudstorage-hotfix fault', () => {
  assert.equal(hit('xmpp-wrong-endpoint', 'MCP: New XMPP connection configured to Server=[ws://127.0.0.1:3551] Port=[3551]'), null);
  assert.ok(hit('xmpp-wrong-endpoint', 'MCP: New XMPP connection configured to Server=[ws://127.0.0.1:80] Port=[80]'));
});

test('the known-recoverable fault at RVA 0x1242250 is benign; other RVAs are not', () => {
  assert.ok(hit('first-chance-av-known', '12:47:22.542 [Exception] first-chance 0xC0000005 at 0x00007FF7D7602250 (RVA 0x1242250) - dump written.'));
  assert.equal(hit('first-chance-av-other', '12:47:22.542 [Exception] first-chance 0xC0000005 at 0x00007FF7D7602250 (RVA 0x1242250) - dump written.'), null);
  const other = hit('first-chance-av-other', '22:01:04.000 [Exception] first-chance 0xC0000005 at 0x00007FF7D7602958 (RVA 0x19AC958) - dump written.');
  assert.ok(other);
});

test('an RVA beyond the image is flagged as measured against the wrong module', () => {
  const m = hit('first-chance-av-other', '14:27:54.615 [Exception] first-chance 0xC0000005 at 0x00007FF8CA9DE453 (RVA 0x35276E453) - dump written.');
  assert.match(rule('first-chance-av-other').classify(m).title, /WRONG module/);
});

test('Reboot [Crash] lines at …2250 are the known fault, others are not', () => {
  const r = rule('reboot-crash-handler');
  assert.equal(r.classify(hit('reboot-crash-handler', '14:27:54.615 [Crash] unhandled exception 0xC0000005 at 0x00007FF7D7602250 - wrote crash.log + crash.dmp')).status, 'known-benign');
  assert.equal(r.classify(hit('reboot-crash-handler', '14:27:54.615 [Crash] unhandled exception 0xC0000005 at 0x00007FF6F61EC958 - wrote crash.log + crash.dmp')).status, undefined);
});

test('a live-format token in a Nova log is caught, a redacted one is not', () => {
  assert.ok(hit('token-in-log', 'launch: args=-AUTH_PASSWORD=eg1~eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMyJ9.sig'));
  assert.equal(hit('token-in-log', 'launch: args=-AUTH_PASSWORD=eg1~<redacted>'), null);
});
