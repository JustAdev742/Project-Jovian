/** Small helpers shared by the modules. Node built-ins only — the doctor has no dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function stat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/** Read a file as text, or null. Large files are read whole: coverage is not capped. */
export function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function md5(p) {
  try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

export function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

/** Recursively list files under `dir` whose name passes `filter`. Skips node_modules/target/.git. */
export function walk(dir, filter = () => true, out = []) {
  for (const e of listDir(dir)) {
    if (e.isDirectory()) {
      if (['node_modules', 'target', '.git', 'x64', 'dist', '.vs'].includes(e.name)) continue;
      walk(path.join(dir, e.name), filter, out);
    } else if (filter(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Count NUL bytes — the signature of a file torn by an unclean shutdown. */
export function countNul(p) {
  try {
    const b = fs.readFileSync(p);
    let n = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 0) n++;
    return n;
  } catch { return null; }
}

/**
 * Run a command and capture its output. Never throws; a tool that is missing or fails is itself
 * evidence and the caller decides what it means.
 */
export function run(cmd, args = [], opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: opts.timeout ?? 600_000,
    cwd: opts.cwd, env: opts.env ?? process.env, shell: opts.shell ?? false,
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    error: r.error ? String(r.error.message || r.error) : null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ms: Date.now() - t0,
  };
}

/** UE4 log timestamp `2026.09.19-02.14.17:384` → ISO-ish string (UTC as UE4 writes it). */
export function ue4Time(stamp) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})$/.exec(stamp || '');
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

export function rel(root, p) {
  if (!p) return p;
  const r = path.relative(root, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
}
