/**
 * Startup tests — NOVA-AUDIT-011, `backend-eaddrinuse-zombie`.
 *
 * These spawn the REAL entrypoint as a child process rather than calling into it, because the
 * behaviour under test is precisely what the process does when it cannot serve: whether it exits or
 * lingers. `app.inject()` cannot see that, and neither can anything that stops short of a real
 * `listen()` on a real port.
 *
 * The bug this pins: a backend that lost the port race used to log the error and KEEP RUNNING with
 * no HTTP surface. From outside it was invisible — a port probe saw the instance that won the race
 * answering, a process check saw a running backend — while the loser went on holding an open handle
 * to the SQLite database. Two processes on one `nova.db` is the condition that cost 393 of 800
 * increments in the concurrency measurement (ARCHITECTURE.md §4), and this is the realistic way it
 * happens.
 *
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT, 'src', 'index.ts');

/** An ephemeral port the OS has just told us is free. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Spawned {
  proc: ChildProcessByStdio<null, Readable, Readable>;
  out: () => string;
  exited: Promise<number | null>;
}

function spawnBackend(port: number, dbPath: string): Spawned {
  const proc = spawn(process.execPath, [TSX, ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      NOVA_PORT: String(port),
      NOVA_DB_PATH: dbPath,
      // Port 80 is not ours to take in a test, and the standalone server is irrelevant here.
      NOVA_DISABLE_STANDALONE_XMPP: '1',
      NOVA_COORDINATOR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  proc.stdout.on('data', (d) => { buf += d.toString(); });
  proc.stderr.on('data', (d) => { buf += d.toString(); });

  const exited = new Promise<number | null>((resolve) => {
    proc.once('exit', (code) => resolve(code));
  });

  return { proc, out: () => buf, exited };
}

/** Resolve once `match` shows up in the child's output, or reject on timeout / early exit. */
function waitForOutput(s: Spawned, match: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (s.out().includes(match)) { clearInterval(iv); resolve(); return; }
      if (s.proc.exitCode !== null) {
        clearInterval(iv);
        reject(new Error(`child exited (${s.proc.exitCode}) before printing ${JSON.stringify(match)}:\n${s.out()}`));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timed out waiting for ${JSON.stringify(match)}:\n${s.out()}`));
      }
    }, 150);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms);
    // Otherwise the pending timer holds the test runner open for its full duration after the race
    // has already been settled by `p` — 1.6 s of test became 61 s of waiting.
    timer.unref?.();
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

describe('startup — a backend that cannot serve must not linger', () => {
  test('the second instance on a taken port exits non-zero instead of running headless', async () => {
    const port = await freePort();
    const dbA = path.join(os.tmpdir(), `nova-startup-a-${process.pid}.db`);
    const dbB = path.join(os.tmpdir(), `nova-startup-b-${process.pid}.db`);

    // Separate database files on purpose: this test is about the PORT, and sharing a file would
    // let a database-level failure masquerade as the bind failure being asserted.
    const first = spawnBackend(port, dbA);
    let second: Spawned | null = null;
    try {
      await waitForOutput(first, 'running on http', 60_000);

      second = spawnBackend(port, dbB);
      const code = await withTimeout(second.exited, 60_000, 'the second instance never exited');

      assert.equal(code, 1, `the loser of the port race must exit(1); output was:\n${second.out()}`);
      assert.match(
        second.out(),
        /already in use/i,
        'the failure must say WHY, so a launcher log identifies it without a debugger',
      );
      // The winner keeps serving. A crashed-both outcome would be a worse regression than the bug.
      assert.equal(first.proc.exitCode, null, 'the instance that won the port must still be running');
    } finally {
      second?.proc.kill();
      first.proc.kill();
      for (const f of [dbA, dbB]) {
        for (const suffix of ['', '-wal', '-shm']) {
          try { fs.unlinkSync(f + suffix); } catch {}
        }
      }
    }
  });
});
