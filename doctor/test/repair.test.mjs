/**
 * Repairs run against throwaway copies — never the real installed files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPAIRS } from '../lib/repair.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nova-doctor-repair-'));
const repair = id => REPAIRS.find(r => r.id === id);

test('scrub-tokens redacts every token and keeps every other byte, NUL runs included', () => {
  const d = tmp();
  const log = path.join(d, 'cobalt.log');
  const nul = String.fromCharCode(0).repeat(16);
  fs.writeFileSync(log, `a eg1~eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMyJ9.sig_x b\n${nul}\nc eg1~<redacted> d\n`, 'latin1');
  const ctx = { paths: { cobaltLog: log, startupLog: path.join(d, 'none1'), agentLog: path.join(d, 'none2') } };
  const msg = repair('scrub-tokens').apply(ctx);
  const out = fs.readFileSync(log, 'latin1');
  assert.match(msg, /redacted 1 token/);
  assert.ok(!out.includes('eyJzdWIi'));
  assert.ok(out.includes(nul), 'the NUL run must survive byte-for-byte');
  assert.ok(out.includes('c eg1~<redacted> d'));
});

test('fix-sliver-window only touches values below 640x480, and backs the file up first', () => {
  const d = tmp(), cfg = path.join(d, 'cfg'), backup = path.join(d, 'backup');
  fs.mkdirSync(cfg);
  const p = path.join(cfg, 'GameUserSettings.ini');
  fs.writeFileSync(p, '[/Script/FortniteGame.FortGameUserSettings]\nResolutionSizeX=160\nResolutionSizeY=28\nLastUserConfirmedResolutionSizeX=2560\nDesiredScreenWidth=2560\nDesiredScreenHeight=1440\n');
  repair('fix-sliver-window').apply({ paths: { ue4Config: cfg } }, {}, backup);
  const out = fs.readFileSync(p, 'utf8');
  assert.match(out, /ResolutionSizeX=2560/);
  assert.match(out, /ResolutionSizeY=1440/);
  assert.match(out, /LastUserConfirmedResolutionSizeX=2560/, 'a value the player chose is left alone');
  assert.match(fs.readFileSync(path.join(backup, 'ue4config', 'GameUserSettings.ini'), 'utf8'), /ResolutionSizeX=160/);
});

test('restore-torn refuses when the staged payload has no clean copy', () => {
  const d = tmp();
  const installed = path.join(d, 'inst'), payload = path.join(d, 'payload');
  fs.mkdirSync(path.join(installed, 'nova-proxy'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'nova-proxy'), { recursive: true });
  const torn = path.join(installed, 'nova-proxy', 'proxy.js');
  fs.writeFileSync(torn, Buffer.alloc(100));
  fs.writeFileSync(path.join(payload, 'nova-proxy', 'proxy.js'), Buffer.alloc(100)); // also torn
  const ctx = { paths: { installedResources: installed, payload } };
  assert.throws(() => repair('restore-torn:proxy').apply(ctx, { data: { files: [torn] } }, path.join(d, 'b')), /no clean source/);
});

test('restore-torn copies the clean file over the torn one and keeps the torn one as backup', () => {
  const d = tmp();
  const installed = path.join(d, 'inst'), payload = path.join(d, 'payload');
  fs.mkdirSync(path.join(installed, 'nova-proxy'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'nova-proxy'), { recursive: true });
  const torn = path.join(installed, 'nova-proxy', 'proxy.js');
  fs.writeFileSync(torn, Buffer.alloc(100));
  fs.writeFileSync(path.join(payload, 'nova-proxy', 'proxy.js'), 'console.log("proxy")');
  const b = path.join(d, 'b');
  repair('restore-torn:proxy').apply({ paths: { installedResources: installed, payload } }, { data: { files: [torn] } }, b);
  assert.equal(fs.readFileSync(torn, 'utf8'), 'console.log("proxy")');
  assert.equal(fs.readFileSync(path.join(b, 'installed', 'nova-proxy', 'proxy.js')).length, 100);
});
