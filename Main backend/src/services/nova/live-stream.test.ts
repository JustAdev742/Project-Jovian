/**
 * The live path, end to end: a failure happens → a subscriber is told → the dashboard can show it.
 *
 * Phase 17 of the brief is explicit that a failure mode is not "supported" until the path has been
 * verified, so these tests assert on the actual delivery rather than on the route existing.
 *
 * The SSE transport itself is exercised through `subscribeDiagnostics`, which is what the route
 * wraps. Driving a real EventSource through `inject` is not possible — inject resolves when the
 * response ENDS, and an event stream never does.
 *
 * Run: npm test
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-live-${process.pid}.db`);

let recordDiagnostic: any;
let subscribeDiagnostics: any;
let diagnosticSubscriberCount: any;
let clearDiagnostics: any;

before(async () => {
  ({ recordDiagnostic, subscribeDiagnostics, diagnosticSubscriberCount, clearDiagnostics } =
    (await import('./diagnostics')) as any);
});

beforeEach(() => clearDiagnostics());

describe('live diagnostic stream', () => {
  test('a recorded failure reaches a subscriber', async () => {
    const got: any[] = [];
    const off = subscribeDiagnostics((e: any) => got.push(e));
    assert.ok(off, 'subscribe returned null with no subscribers attached');

    recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/live/one', status: 500 });

    assert.equal(got.length, 1, 'the subscriber was not told');
    assert.equal(got[0].category, 'FAILED');
    assert.equal(got[0].route, '/live/one');
    assert.equal(got[0].status, 500);
    off!();
  });

  test('isNew distinguishes a new problem from a recurrence', async () => {
    // The UI leans on this: "something new just broke" and "the known thing happened again" deserve
    // different attention, and a count alone cannot tell them apart at a glance.
    const got: any[] = [];
    const off = subscribeDiagnostics((e: any) => got.push(e));
    recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/live/two', status: 500 });
    recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/live/two', status: 500 });
    off!();

    assert.equal(got.length, 2);
    assert.equal(got[0].isNew, true, 'the first occurrence must be flagged new');
    assert.equal(got[1].isNew, false, 'the second must not');
    assert.equal(got[1].count, 2, 'count is the running total, not the delta');
  });

  test('unsubscribing actually stops delivery', async () => {
    // A leaked listener per dropped connection would consume the subscriber budget until the stream
    // silently stopped accepting anyone — and "live updates stopped working" points nowhere near it.
    const got: any[] = [];
    const off = subscribeDiagnostics((e: any) => got.push(e));
    off!();
    recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/live/three', status: 500 });
    assert.equal(got.length, 0, 'events were delivered after unsubscribe');
    assert.equal(diagnosticSubscriberCount(), 0, 'the listener was not released');
  });

  test('a subscriber that throws cannot break recording', async () => {
    // recordDiagnostic runs from error paths. An exception escaping the emit loop would destroy the
    // very record it was reporting — the worst possible failure for a diagnostic system.
    const good: any[] = [];
    const offBad = subscribeDiagnostics(() => { throw new Error('subscriber exploded'); });
    const offGood = subscribeDiagnostics((e: any) => good.push(e));

    assert.doesNotThrow(() =>
      recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/live/four', status: 500 }));

    assert.equal(good.length, 1, 'a throwing subscriber stopped delivery to a healthy one');
    offBad!(); offGood!();
  });

  test('subscribers are capped, and the cap is reported rather than silently starving', async () => {
    // Returning null lets the route answer 503. Accepting a connection that receives nothing is the
    // exact silent-failure shape this whole subsystem exists to remove.
    const offs: Array<() => void> = [];
    for (let i = 0; i < 16; i++) {
      const off = subscribeDiagnostics(() => {});
      assert.ok(off, `subscriber ${i} was refused below the cap`);
      offs.push(off!);
    }
    assert.equal(subscribeDiagnostics(() => {}), null, 'the 17th subscriber was not refused');
    for (const off of offs) off();
    assert.equal(diagnosticSubscriberCount(), 0);
  });

  test('the emitted event carries no account identifier', async () => {
    // The stream is admin-gated, but it is also the most widely-copied artefact here (screenshots,
    // pasted logs). Account ids belong in the aggregate, which hashes them; they have no business
    // on the wire per-event.
    const got: any[] = [];
    const off = subscribeDiagnostics((e: any) => got.push(e));
    recordDiagnostic({
      category: 'AUTH_FAILURE', method: 'GET', url: '/live/five', status: 401,
      accountId: 'abcdef0123456789abcdef0123456789',
    });
    off!();
    const serialised = JSON.stringify(got[0]);
    assert.ok(!serialised.includes('abcdef0123456789'), `account id leaked: ${serialised}`);
  });
});
