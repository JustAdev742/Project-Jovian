/**
 * Where everything is. Discovered, not assumed: every path carries whether it exists, and a module
 * that needs a missing input reports that as a coverage gap rather than silently checking nothing.
 *
 * The map this encodes is the one in SESSION-HANDOFF.txt §2 and ARCHITECTURE.md §6a — in particular
 * that the copy of a component that RUNS is rarely the copy that was built (installed launcher
 * resources, the staged payload, the game's Aftermath slot), which has bitten this project three
 * times.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readText, listDir } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function lastMatch(text, re) {
  if (!text) return null;
  let m, last = null;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(text))) last = m;
  return last;
}

/** The game folder: explicit flag/env first, then what the launcher last launched, then the log. */
function discoverGameDir(opts, startupLog, ue4LogsDir) {
  const explicit = opts.game || process.env.NOVA_GAME_DIR;
  if (explicit) return { dir: explicit, how: opts.game ? '--game' : 'NOVA_GAME_DIR' };

  const m = lastMatch(readText(startupLog), /firstlaunch: begin \(path=([^,)]+)/);
  const lastLaunched = m ? m[1].trim() : null;
  if (lastLaunched && exists(lastLaunched)) return { dir: lastLaunched, how: 'launcher-startup.log' };

  // `LogInit: Base Directory: C:/…/FortniteGame/Binaries/Win64/` — three levels below the build root.
  const client = path.join(ue4LogsDir, 'FortniteGame.log');
  const b = /Base Directory:\s*(.+?)\s*$/m.exec(readText(client) || '');
  if (b) {
    const d = path.resolve(b[1].replace(/\//g, path.sep), '..', '..', '..');
    if (exists(d)) return { dir: d, how: 'FortniteGame.log Base Directory' };
  }
  return {
    dir: null, lastLaunched,
    how: lastLaunched
      ? `the launcher last used ${lastLaunched}, which no longer exists — pass --game <build folder>`
      : 'not found — pass --game <build folder>',
  };
}

function firstExisting(cands) {
  for (const c of cands) if (c && exists(c)) return c;
  return null;
}

function findMsvcTool(name) {
  const roots = [
    'C:/Program Files/Microsoft Visual Studio',
    'C:/Program Files (x86)/Microsoft Visual Studio',
  ];
  for (const r of roots) {
    for (const ver of listDir(r)) {
      for (const ed of listDir(path.join(r, ver.name))) {
        const base = path.join(r, ver.name, ed.name);
        if (name === 'MSBuild.exe') {
          const p = path.join(base, 'MSBuild/Current/Bin/MSBuild.exe');
          if (exists(p)) return p;
        } else {
          const msvc = path.join(base, 'VC/Tools/MSVC');
          for (const v of listDir(msvc).reverse()) {
            const p = path.join(msvc, v.name, 'bin/Hostx64/x64', name);
            if (exists(p)) return p;
          }
        }
      }
    }
  }
  return null;
}

export function discover(opts = {}) {
  const repo = path.resolve(here, '..', '..');
  const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const launcherDir = path.join(lad, 'Project Launcher');
  const ue4Saved = path.join(lad, 'FortniteGame', 'Saved');
  const ue4Logs = path.join(ue4Saved, 'Logs');
  const startupLog = path.join(launcherDir, 'launcher-startup.log');
  const game = discoverGameDir(opts, startupLog, ue4Logs);

  const ctx = {
    opts,
    startedAt: new Date().toISOString(),
    repo,
    paths: {
      backend: path.join(repo, 'Main backend'),
      launcher: path.join(repo, 'Launcher'),
      tauri: path.join(repo, 'Launcher', 'src-tauri'),
      cobalt: path.join(repo, 'Launcher', 'cobalt'),
      reboot: path.join(repo, 'Project-Reboot-DLL'),
      proxy: path.join(repo, 'nova-proxy'),
      coordinator: path.join(repo, 'coordinator'),
      tools: path.join(repo, 'tools'),
      knownIssues: path.join(repo, 'KNOWN_ISSUES.md'),
      payload: path.join(repo, 'Launcher', 'src-tauri', 'resources'),

      installed: launcherDir,
      installedExe: path.join(launcherDir, 'Project Launcher.exe'),
      installedResources: path.join(launcherDir, 'resources'),
      startupLog,
      agentLog: path.join(launcherDir, 'nova-agent.log'),
      novaLogs: path.join(lad, 'ProjectNova', 'Logs'),
      cobaltLog: path.join(lad, 'ProjectNova', 'Logs', 'cobalt.log'),
      novaState: path.join(lad, 'ProjectNova'),

      ue4Saved,
      ue4Logs,
      ue4Crashes: path.join(ue4Saved, 'Crashes'),
      ue4Config: path.join(ue4Saved, 'Config', 'WindowsClient'),

      game: game.dir,
      gameHow: game.how,
      gameLastLaunched: game.lastLaunched ?? null,
      gameWin64: game.dir ? path.join(game.dir, 'FortniteGame', 'Binaries', 'Win64') : null,
      gameExe: game.dir ? path.join(game.dir, 'FortniteGame', 'Binaries', 'Win64', 'FortniteClient-Win64-Shipping.exe') : null,
      gamePaks: game.dir ? path.join(game.dir, 'FortniteGame', 'Content', 'Paks') : null,
      aftermathSlot: game.dir
        ? path.join(game.dir, 'Engine', 'Binaries', 'ThirdParty', 'NVIDIA', 'NVaftermath', 'Win64', 'GFSDK_Aftermath_Lib.x64.dll')
        : null,
    },
    tools: {
      node: process.execPath,
      msbuild: findMsvcTool('MSBuild.exe'),
      dumpbin: findMsvcTool('dumpbin.exe'),
      cargo: firstExisting([path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe')]) || 'cargo',
      tsc: firstExisting([path.join(repo, 'Main backend', 'node_modules', '.bin', 'tsc.cmd'),
        path.join(repo, 'Main backend', 'node_modules', '.bin', 'tsc')]),
      // Run TypeScript through node rather than the .cmd shim: no shell, no argument-escaping warning.
      tscJs: firstExisting([path.join(repo, 'Main backend', 'node_modules', 'typescript', 'bin', 'tsc')]),
    },
    remote: {
      // Read-only access to the live coordinator, used only with --remote. These are already in
      // coordinator/README.md; the key itself never leaves ~/.ssh.
      host: process.env.NOVA_DOCTOR_SSH_HOST || 'admin_home@100.96.188.28',
      key: process.env.NOVA_DOCTOR_SSH_KEY || path.join(os.homedir(), '.ssh', 'nova_coordinator'),
      funnel: process.env.NOVA_DOCTOR_FUNNEL || 'https://clientfinder.tail0a8fd0.ts.net:8443',
      dir: '~/nova-backend',
    },
  };
  return ctx;
}

/** All UE4 logs on disk, current and rotated, newest first. */
export function ue4LogFiles(ctx) {
  return listDir(ctx.paths.ue4Logs)
    .filter(e => e.isFile() && /^Fortnite.*\.log$/i.test(e.name))
    .map(e => path.join(ctx.paths.ue4Logs, e.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
