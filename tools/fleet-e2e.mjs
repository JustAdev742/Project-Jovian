// Fleet doctor end-to-end, without the game. Real processes, real HTTP, throwaway data:
//
//   coordinator backend :3598  (dev tree, its own temp DBs, an admin secret)
//   agent backend       :3597  (NOVA_COORDINATOR set -> host-agent mode)
//   nova-doctor live    -> agent  (fake LOCALAPPDATA with logs we append to)
//   "launcher"          -> drains the agent, posts to the coordinator under a real token
//                          (the same two calls diagreport.rs::forward_doctor_once makes)
//
// Leaves the coordinator running for the dashboard review; prints a summary and keeps forwarding.
//
//   node tools/fleet-e2e.mjs      (or the fleet-doctor-e2e entry in .claude/launch.json)
//   then open http://127.0.0.1:3598/nova/api/doctor/dashboard and sign in with the throwaway
//   admin secret below. Everything lives in a temp dir; nothing touches the real data/ or LOCALAPPDATA.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const be = path.join(repo, 'Main backend');
const tsx = path.join(be, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fleet-e2e-'));
const fakeLad = path.join(work, 'LocalAppData');
const logs = path.join(fakeLad, 'FortniteGame', 'Saved', 'Logs');
const nova = path.join(fakeLad, 'ProjectNova', 'Logs');
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(nova, { recursive: true });
const clientLog = path.join(logs, 'FortniteGame.log');
const cobaltLog = path.join(nova, 'cobalt.log');
fs.writeFileSync(clientLog, 'LogInit: Build: ++Fortnite+Release-7.40-CL-5046157\nLogInit: Filtered Command Line: -epicapp=Fortnite -nosplash\n');
fs.writeFileSync(cobaltLog, '==== Cobalt starting (built 2026-11-08 16:05:25) ====\n');
const ADMIN = 'e2e-admin-secret';
const log = (...a) => console.log('[e2e]', ...a);

const children = [];
function start(name, args, env, cwd) {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = fs.createWriteStream(path.join(work, `${name}.log`));
  p.stdout.pipe(out); p.stderr.pipe(out);
  p.on('exit', c => log(`${name} exited ${c}`));
  children.push(p);
  return p;
}
// tsx runs the backend in a grandchild process, so killing the direct child would orphan it on
// :3597/:3598. Take the whole tree down when this harness goes, however it goes.
function stopAll() {
  for (const p of children) {
    if (p.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-p.pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
}
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => process.exit(0));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function up(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) return true; } catch {} await wait(500); } return false; }

const common = { NOVA_DISABLE_STANDALONE_XMPP: '1' };
start('coordinator', [tsx, 'src/index.ts'], { ...common, NOVA_PORT: '3598', NOVA_DB_PATH: path.join(work, 'coord.db'), NOVA_DOCTOR_DB: path.join(work, 'coord-doctor.db'), NOVA_AC_ADMIN_SECRET: ADMIN, NOVA_COORDINATOR: '' }, be);
start('agent', [tsx, 'src/index.ts'], { ...common, NOVA_PORT: '3597', NOVA_DB_PATH: path.join(work, 'agent.db'), NOVA_DOCTOR_DB: path.join(work, 'agent-doctor.db'), NOVA_COORDINATOR: 'http://127.0.0.1:3598', NOVA_HOST_ELECTION: '1' }, be);
log('waiting for both backends…');
if (!(await up('http://127.0.0.1:3598/nova/api/info')) || !(await up('http://127.0.0.1:3597/nova/api/info'))) { log('a backend did not start; see', work); process.exit(1); }

// A real token from the coordinator (a throwaway account in its temp DB).
const tok = await (await fetch('http://127.0.0.1:3598/account/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=password&username=FleetTester&password=x' })).json();
log('token for', tok.displayName || tok.account_id);

const doctor = start('doctor', [path.join(repo, 'doctor', 'nova-doctor.mjs'), 'live', '--agent', 'http://127.0.0.1:3597', '--parent', String(process.pid)],
  { LOCALAPPDATA: fakeLad, NOVA_DOCTOR_FAST: '1', NOVA_LAUNCHER_VERSION: '1.9.4' }, repo);

// The "launcher": drain + ingest every 2 s.
let forwarded = { lines: 0, reports: 0 };
async function forward() {
  const p = await (await fetch('http://127.0.0.1:3597/nova/api/doctor/pending')).json();
  if (!p.lines.length && !p.report && !p.dropped) return;
  const r = await fetch('http://127.0.0.1:3598/nova/api/doctor/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `bearer ${tok.access_token}` }, body: JSON.stringify({ launcher: '1.9.4', ...p }) });
  const j = await r.json();
  forwarded.lines += j.accepted || 0; if (j.report) forwarded.reports++;
}
setInterval(() => forward().catch(e => log('forward failed', e.message)), 2000);

// Simulate a game session: write problem lines (and noise) into the logs while "playing".
await wait(2500);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '.').replace('T', '-').slice(0, 19).replace(/\.(\d\d)$/, '.$1') + ':000';
const lines = [
  `[${stamp()}][  1]LogConfig: Setting CVar [[noise:1]]`,
  `[${stamp()}][  2]LogFort: Warning: AFortQuickBars::AddItemInternal could not find Item with GUID 092FF850AB12CD34`,
  `[${stamp()}][  3]LogHttp: Warning: {"errorCode":"x","originatingService":"friends","errorMessage":"Token is missing key ID value"}`,
  `[${stamp()}][  4]LogStreaming: Warning: Couldn't find file for package /Game/Items/LootQuotaData requested`,
  `[${stamp()}][  5]LogStreaming: Error: Found 3 dependent packages...`,
  `[${stamp()}][  6]LogNet: Login request: /Game/Maps/Frontend?Name=FleetTester?AuthTicket=eg1~eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMyJ9.sig from 203.0.113.77`,
];
for (const l of lines) { fs.appendFileSync(clientLog, l + '\n'); await wait(300); }
// A burst of one warning, the way a spawn produces it: the doctor must send it ONCE, with a count.
for (let i = 0; i < 10; i++) fs.appendFileSync(clientLog, `[${stamp()}][ 43]LogFort: Warning: ClientRestart_Implementation failed because WorldInventory is invalid, waiting to finish restarting for FleetTester*\n`);
fs.appendFileSync(cobaltLog, "16:20:01.000 Failed to find property 'QuickBars' (see the offset report)\n16:20:02.000 URL: example/fortnite/api/x\n");
log('wrote a session; now letting it go quiet so the doctor runs its full scan…');
await wait(14000);
log('forwarded so far:', JSON.stringify(forwarded));
const fleet = await (await fetch('http://127.0.0.1:3598/nova/api/doctor/fleet.json', { headers: { 'x-nova-admin': ADMIN } })).json();
const recent = await (await fetch('http://127.0.0.1:3598/nova/api/doctor/lines.json', { headers: { 'x-nova-admin': ADMIN } })).json();
console.log(JSON.stringify({
  players: fleet.players.map(p => ({ name: p.display_name, launcher: p.launcher_version, open: p.open_total, p0: p.p0, report: !!p.last_report_at })),
  problems: fleet.problems.slice(0, 5).map(p => `${p.severity} ${p.title} (${p.players} player)`),
  liveLines: recent.lines.map(l => `${l.sev} ${l.src} ${l.rule || '-'}${l.count > 1 ? ` x${l.count}` : ''} :: ${l.text.slice(0, 110)}`),
}, null, 2));
log(`work dir ${work}; coordinator stays up at http://127.0.0.1:3598/nova/api/doctor/dashboard (admin secret ${ADMIN})`);
