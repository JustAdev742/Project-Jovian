/**
 * The agent reads the spawned server's stdout for its menu marker, so the launcher can inject Reboot
 * the moment it is safe instead of after a flat 45s (27s measured on a Ryzen 5 5600, 2026-11-08).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { watchForMarker } from './hostRunner';

test('the marker is found even when it straddles two chunks', () => {
  const s = new PassThrough();
  let hits = 0;
  watchForMarker(s, 'CreatingParty', () => hits++);
  s.write('[2026.11.08-06.31.52:148][245]LogOnlineAccount: Display: Login: Creating party... (Creati');
  assert.equal(hits, 0);
  s.write('ngParty)\n');
  assert.equal(hits, 1);
});

test('it fires once, then keeps draining so the game never blocks on a full pipe', async () => {
  const s = new PassThrough({ highWaterMark: 1024 });
  let hits = 0;
  watchForMarker(s, 'CreatingParty', () => hits++);
  s.write('(CreatingParty)\n');
  // Far more than the buffer holds; write() would return false forever if nothing were reading.
  let lastOk = true;
  for (let i = 0; i < 2000; i++) lastOk = s.write('LogNet: more output after the marker '.repeat(4) + '\n');
  await new Promise((r) => setImmediate(r));
  s.write('(CreatingParty) again\n');
  assert.equal(hits, 1);
  assert.ok(s.readableFlowing, 'the stream keeps flowing after the marker');
  void lastOk;
});
