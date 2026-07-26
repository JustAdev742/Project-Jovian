import { insertAnticheatFlag, getAnticheatRisk, setAccountBanned, getAccount } from '../../database';
import { Config } from '../../config';

/**
 * Anti-cheat detection engine.
 *
 * WHAT THIS CAN AND CANNOT DO — read before trusting it:
 *
 *  It CAN detect: results that are physically impossible for the game to produce, players
 *  reporting results for matches they were not in, hosts reporting on other people's sessions,
 *  duplicate/replayed reports, request flooding, and injected modules that a careless cheater
 *  did not bother to rename.
 *
 *  It CANNOT detect a competent client-side cheat. Aimbot and ESP read the game's own memory and
 *  never talk to us; there is no server-side signal at all unless the cheat changes results enough
 *  to trip a plausibility rule. Module attestation is reported BY the launcher, so a modified
 *  launcher can simply lie. This raises the cost of cheating; it does not stop it.
 *
 *  A specific complication for Project Nova: the game only works BECAUSE we inject DLLs (Cobalt to
 *  redirect the backend, Reboot to host the match). "Any injection is a cheat" would flag every
 *  legitimate player, so the rule is "anything outside the known-good set is worth a look".
 *
 * Detections are appended to anticheat_flags as an audit trail, each with a severity. Enforcement
 * acts on the 24h severity total, so one odd match doesn't ban anyone but a pattern does.
 */

export interface Detection {
  rule: string;
  severity: number; // 1 (curiosity) … 10 (impossible without tampering)
  detail: string;
}

/** Modules we expect to see inside a healthy Nova client. Matched case-insensitively as substrings. */
const ALLOWED_MODULE_PATTERNS = [
  // Nova's own required injections
  'gfsdk_aftermath_lib.x64.dll', // Cobalt ships under this name (DLL hijack)
  'cobalt', 'project reboot.dll', 'reboot.dll',
  // The game and the platform
  'fortniteclient-win64-shipping.exe', 'ntdll.dll', 'kernel32.dll', 'kernelbase.dll', 'user32.dll',
  'gdi32.dll', 'advapi32.dll', 'ws2_32.dll', 'crypt32.dll', 'ole32.dll', 'shell32.dll',
  'msvcp', 'vcruntime', 'ucrtbase', 'combase.dll', 'rpcrt4.dll', 'bcrypt', 'winhttp.dll',
  'd3d11.dll', 'd3d12.dll', 'dxgi.dll', 'd3dcompiler', 'opengl32.dll', 'vulkan-1.dll',
  'xinput', 'xaudio2', 'dsound.dll', 'openal', 'amsi.dll',
  // Vendor overlays and drivers that legitimately inject
  'nvidia', 'nvwgf2um', 'nvapi', 'amdihk', 'atiumd', 'igd', 'igdumd',
  'discord', 'steam', 'gameoverlayrenderer', 'rtsshooks', 'msiafterburner',
  'obs', 'graphics-hook', 'nvcamera', 'medal', 'overwolf',
];

/** Substrings that a lazy cheat/loader leaves in a module name. Catches the careless only. */
const SUSPICIOUS_NAME_PATTERNS = [
  'cheat', 'hack', 'aimbot', 'esp', 'wallhack', 'triggerbot', 'injector', 'inject.exe',
  'xenos', 'manualmap', 'extremeinjector', 'processhacker', 'cheatengine', 'speedhack',
  'unknowncheats', 'skinchanger', 'spoofer', 'bypass',
];

function isAllowedModule(name: string): boolean {
  const n = name.toLowerCase();
  return ALLOWED_MODULE_PATTERNS.some((p) => n.includes(p));
}

function suspiciousName(name: string): string | null {
  const n = name.toLowerCase();
  return SUSPICIOUS_NAME_PATTERNS.find((p) => n.includes(p)) || null;
}

/**
 * Rule A — module attestation. The launcher enumerates modules loaded into the game process and
 * sends the list. Self-reported, so treat it as a smoke detector, not a lock.
 */
export function analyzeAttestation(modules: string[]): Detection[] {
  const out: Detection[] = [];
  const unknown: string[] = [];

  for (const raw of modules.slice(0, 500)) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const hit = suspiciousName(name);
    if (hit) {
      out.push({
        rule: 'attestation.suspicious_module',
        severity: 7,
        detail: `module "${name}" matches the pattern "${hit}"`,
      });
      continue;
    }
    if (!isAllowedModule(name)) unknown.push(name);
  }

  // Unknown modules are common and usually innocent (antivirus, capture tools, RGB software), so
  // this is deliberately low severity and reported once in aggregate rather than per module.
  if (unknown.length > 0) {
    out.push({
      rule: 'attestation.unknown_modules',
      severity: 1,
      detail: `${unknown.length} unrecognised module(s): ${unknown.slice(0, 12).join(', ')}${unknown.length > 12 ? ', …' : ''}`,
    });
  }
  return out;
}

export interface MatchReport {
  accountId: string;
  matchId: string;
  playersInMatch: number;
  kills: number;
  damage: number;
  placement: number;
  durationSec: number;
  score?: number;
}

/**
 * Rule B — result plausibility. These bounds are set where the game's own physics make a value
 * impossible, not where a value merely looks impressive, so a genuinely great match is not flagged.
 */
export function analyzeMatchReport(r: MatchReport): Detection[] {
  const out: Detection[] = [];
  const players = Math.max(1, Math.min(r.playersInMatch || 100, 100));
  const minutes = Math.max(r.durationSec || 0, 1) / 60;

  if (r.kills < 0 || r.damage < 0 || r.placement < 1) {
    out.push({ rule: 'match.negative_values', severity: 8, detail: `kills=${r.kills} damage=${r.damage} placement=${r.placement}` });
  }
  // You cannot kill more players than were in the match (minus yourself).
  if (r.kills > players - 1) {
    out.push({ rule: 'match.kills_exceed_players', severity: 9, detail: `${r.kills} kills in a ${players}-player match` });
  }
  // 4 kills/minute sustained across a whole match is beyond human; short bursts are not, hence the
  // 3-minute floor before the rule applies.
  if (minutes >= 3 && r.kills / minutes > 4) {
    out.push({ rule: 'match.kill_rate', severity: 6, detail: `${r.kills} kills in ${Math.round(minutes)} min (${(r.kills / minutes).toFixed(1)}/min)` });
  }
  // Max health+shield is 200; 1000 damage per kill allows for heavy missed fire and heals.
  if (r.kills > 0 && r.damage / r.kills > 1000) {
    out.push({ rule: 'match.damage_per_kill', severity: 4, detail: `${r.damage} damage across ${r.kills} kills` });
  }
  // A 100-player match cannot be won in under two minutes.
  if (r.placement === 1 && players > 20 && r.durationSec < 120) {
    out.push({ rule: 'match.impossible_duration', severity: 7, detail: `won a ${players}-player match in ${r.durationSec}s` });
  }
  if (r.placement > players) {
    out.push({ rule: 'match.placement_exceeds_players', severity: 6, detail: `placement ${r.placement} of ${players}` });
  }
  return out;
}

/**
 * Rule C — authority. Results are reported by the HOST's machine, which is another player's PC, so
 * the report itself is untrusted input. These checks make sure a report can only affect the match
 * it belongs to.
 */
export function analyzeReportAuthority(opts: {
  reporterAccountId: string;
  claimedHostAccountId: string | null;
  participants: string[];
  subjectAccountId: string;
  alreadyReported: boolean;
}): Detection[] {
  const out: Detection[] = [];
  if (opts.claimedHostAccountId && opts.reporterAccountId !== opts.claimedHostAccountId) {
    out.push({
      rule: 'report.not_the_host',
      severity: 8,
      detail: `${opts.reporterAccountId} reported results for a session hosted by ${opts.claimedHostAccountId}`,
    });
  }
  if (opts.participants.length > 0 && !opts.participants.includes(opts.subjectAccountId)) {
    out.push({
      rule: 'report.subject_not_in_match',
      severity: 8,
      detail: `results submitted for ${opts.subjectAccountId}, who was not in the match`,
    });
  }
  if (opts.alreadyReported) {
    out.push({ rule: 'report.duplicate', severity: 4, detail: 'results for this match were already submitted' });
  }
  return out;
}

/**
 * Rule D — request-rate anomaly. Cheap in-memory sliding window; catches scripted clients hammering
 * an endpoint (profile-grant spam, matchmaking replay) without touching the DB on every request.
 */
const requestWindows = new Map<string, number[]>();
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 120; // per account per window across anti-cheat-sensitive routes

export function noteRequest(accountId: string): Detection[] {
  if (!accountId) return [];
  const now = Date.now();
  const win = (requestWindows.get(accountId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  win.push(now);
  requestWindows.set(accountId, win);
  // Keep the map from growing without bound on a long-running server.
  if (requestWindows.size > 5000) {
    for (const [k, v] of requestWindows) {
      if (v.length === 0 || now - v[v.length - 1] > RATE_WINDOW_MS * 6) requestWindows.delete(k);
    }
  }
  if (win.length > RATE_LIMIT) {
    return [{ rule: 'rate.flood', severity: 3, detail: `${win.length} requests in ${RATE_WINDOW_MS / 1000}s` }];
  }
  return [];
}

/**
 * Rule E — economy tampering. Anything the client asks to be granted that only the server should
 * decide. Call this from MCP paths that accept client-supplied amounts.
 */
export function analyzeEconomyRequest(field: string, requested: number, allowedMax: number): Detection[] {
  if (!Number.isFinite(requested)) {
    return [{ rule: 'economy.non_numeric', severity: 5, detail: `${field}=${requested}` }];
  }
  if (requested > allowedMax) {
    return [{
      rule: 'economy.excessive_grant',
      severity: 7,
      detail: `client asked for ${field}=${requested}, server maximum is ${allowedMax}`,
    }];
  }
  return [];
}

/**
 * Record detections and apply enforcement. Returns the account's 24h risk total and whether it was
 * banned by this call.
 *
 * Auto-ban is OFF unless NOVA_AC_AUTOBAN_AT is set: on a small private server a false positive that
 * locks out a friend is worse than a cheater who gets reviewed a day late.
 */
export function applyDetections(accountId: string, detections: Detection[], matchId?: string): {
  flagged: number; risk: number; banned: boolean;
} {
  if (!accountId || detections.length === 0) {
    return { flagged: 0, risk: accountId ? getAnticheatRisk(accountId) : 0, banned: false };
  }
  for (const d of detections) {
    insertAnticheatFlag(accountId, d.rule, d.severity, d.detail, matchId);
    console.log(`[AntiCheat] ${accountId} · ${d.rule} (sev ${d.severity}) · ${d.detail}`);
  }
  const risk = getAnticheatRisk(accountId);
  let banned = false;
  const threshold = Config.AC_AUTOBAN_AT;
  if (threshold > 0 && risk >= threshold) {
    const acct = getAccount(accountId);
    if (acct && acct.banned !== 1) {
      setAccountBanned(accountId, true);
      banned = true;
      console.log(`[AntiCheat] BANNED ${accountId} — 24h risk ${risk} reached the threshold ${threshold}`);
    }
  }
  return { flagged: detections.length, risk, banned };
}
