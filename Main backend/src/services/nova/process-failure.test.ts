/**
 * Process-level failures leave a trace, and the right ones are fatal.
 *
 * WHY THIS IS A SPAWNED-PROCESS TEST. The behaviour under test is what happens when the process
 * dies, so it cannot be exercised in-process — installing a second `uncaughtException` handler in
 * the test runner would test the handler, not the outcome. Each case runs a real `node` and asserts
 * on its exit code and output.
 *
 * WHAT THIS PROTECTS. Before these handlers existed, an uncaught exception killed the backend with
 * nothing recorded anywhere: diagnostics are in-memory so they died with it, and the agent log was
 * truncated on the next start. The failure class that takes the whole service down was the one that
 * left no trace.
 *
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** Run a snippet with the same handler set index.ts installs, and report how it went. */
function runWithHandlers(body: string) {
  const prelude = `
    function record(kind, detail, err) {
      try {
        const m = err instanceof Error ? err.message : String(err ?? '');
        console.error('[FATAL] ' + kind + ' ' + detail + ' ' + m);
      } catch {}
    }
    process.on('uncaughtException', (e) => {
      record('CRASH', 'uncaughtException', e);
      setTimeout(() => process.exit(1), 50);
    });
    process.on('unhandledRejection', (r) => record('INTERNAL_ERROR', 'unhandledRejection', r));
    process.on('exit', (c) => { if (c !== 0) console.error('[FATAL] process exiting with code ' + c); });
  `;
  const r = spawnSync(process.execPath, ['-e', prelude + body], { encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('process-level failure capture', () => {
  test('an uncaught exception is recorded AND still kills the process', () => {
    // Both halves matter. Recording without exiting would leave the process in the undefined state
    // Node warns about — trading a visible crash for silent corruption, which is strictly worse.
    const r = runWithHandlers(`setTimeout(() => { throw new Error('boom-uncaught'); }, 1);`);
    assert.ok(r.out.includes('[FATAL]'), `no FATAL line. got: ${r.out.slice(0, 300)}`);
    assert.ok(r.out.includes('boom-uncaught'), 'the exception message was not recorded');
    assert.equal(r.code, 1, 'an uncaught exception must exit non-zero so the supervisor restarts it');
  });

  test('an unhandled rejection is recorded but does NOT kill the process', () => {
    // Deliberately non-fatal: an unhandled rejection is usually a forgotten await on a non-critical
    // path, and killing a live match server over one is a worse outcome than the bug itself.
    const r = runWithHandlers(`
      Promise.reject(new Error('boom-rejected'));
      setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0); }, 300);
    `);
    assert.ok(r.out.includes('boom-rejected'), 'the rejection was not recorded');
    assert.ok(r.out.includes('STILL-ALIVE'), 'the process died on a rejection; it must survive');
    assert.equal(r.code, 0);
  });

  test('a clean exit is not reported as a failure', () => {
    // The guard against crying wolf: every ordinary restart would otherwise look like an incident.
    const r = runWithHandlers(`process.exit(0);`);
    assert.equal(r.code, 0);
    assert.ok(!r.out.includes('[FATAL]'), `a clean exit produced: ${r.out.slice(0, 200)}`);
  });

  test('a non-zero exit is reported even with no exception', () => {
    const r = runWithHandlers(`process.exit(3);`);
    assert.equal(r.code, 3);
    assert.ok(r.out.includes('exiting with code 3'), 'a non-zero exit left no trace');
  });

  test('a throw inside the handler cannot stop the record being written', () => {
    // The handler is wrapped for exactly this. An exception raised inside uncaughtException is
    // unrecoverable and would take the process down WITHOUT the record — losing the thing we were
    // trying to capture.
    const r = spawnSync(process.execPath, ['-e', `
      process.on('uncaughtException', (e) => {
        try { console.error('[FATAL] ' + e.message); JSON.parse('{oh no'); } catch {}
        setTimeout(() => process.exit(1), 50);
      });
      setTimeout(() => { throw new Error('boom-nested'); }, 1);
    `], { encoding: 'utf8', timeout: 15000 });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.ok(out.includes('boom-nested'), 'the record was lost when the handler threw');
    assert.equal(r.status, 1);
  });
});
