/**
 * The UE4 log grammar, ported rule for rule from Launcher/src-tauri/src/ue4log.rs (`parse_line`,
 * `normalise_message`, `Header::from_text`). The doctor and the launcher must read a log the SAME
 * way, or the two will disagree about what is an error — so this is a port, not a reinterpretation,
 * and test/ue4log.test.mjs pins it with the launcher's own cases.
 *
 * The one rule that matters most: verbosity is read POSITIONALLY from
 * `[stamp][frame]Category: Verbosity: message`. A line at the default `Log` level is never an error
 * however its text reads — 27 lines in one real session contained "Error:" without being errors,
 * including a LogFortChat line reporting success (DIAGNOSTIC_COVERAGE.md).
 */

export const ALL_VERBOSITY = ['Fatal', 'Error', 'Warning', 'Display', 'Verbose', 'VeryVerbose'];
export const BAD_VERBOSITY = ['Fatal', 'Error', 'Warning'];

/** The 14 log categories Nova is responsible for (ue4log.rs SUBSYSTEMS) → subsystem. */
export const SUBSYSTEMS = {
  LogOnline: 'auth', LogOnlineAccount: 'auth', LogOnlineIdentity: 'auth',
  LogOnlineSession: 'matchmaking', LogBeacon: 'matchmaking', LogNet: 'matchmaking',
  LogOnlineParty: 'social', LogParty: 'social', LogOnlineChat: 'social', LogFortChat: 'social', LogXmpp: 'social',
  LogFortQuest: 'mcp', LogFort: 'mcp',
  LogHttp: 'other',
};

// Rust char::is_whitespace: JS \s minus U+FEFF, plus U+0085. Built from escapes so this file stays ASCII.
const RUST_WHITESPACE = new RegExp("[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+");
const STAMP_CHARS = /^[0-9.\-: ]+$/;
const CATEGORY = /^[A-Za-z0-9_]+$/;

/**
 * Parse one line. Returns { stamp, frame, category, verbosity, message } or null.
 * `stamp` is the first bracket (UE4's `2026.09.19-02.14.17:384`), `frame` the second, when present.
 */
export function parseLine(raw) {
  let line = String(raw).replace(/^\uFEFF/, '').replace(/[\s]+$/u, '');
  const brackets = [];
  while (line.startsWith('[')) {
    const close = line.indexOf(']');
    if (close < 0) return null;                       // an unclosed bracket fails the whole line
    const inner = line.slice(1, close).trim();
    if (inner.length && STAMP_CHARS.test(inner)) {
      brackets.push(inner);
      line = line.slice(close + 1).replace(/^\s+/, '');
    } else break;                                     // not a stamp/frame: leave it in place
  }
  const sep = line.indexOf(': ');
  if (sep < 0) return null;
  const category = line.slice(0, sep);
  if (!category || !CATEGORY.test(category)) return null;
  let rest = line.slice(sep + 2);
  let verbosity = 'Log';
  const sep2 = rest.indexOf(': ');
  if (sep2 >= 0 && ALL_VERBOSITY.includes(rest.slice(0, sep2))) {
    verbosity = rest.slice(0, sep2);
    rest = rest.slice(sep2 + 2);
  }
  return { stamp: brackets[0] ?? null, frame: brackets[1] ?? null, category, verbosity, message: rest.trim() };
}

const isHex = c => /^[0-9a-fA-F]$/.test(c);
const isDigit = c => c >= '0' && c <= '9';
const isAlnum = c => /^[A-Za-z0-9]$/.test(c);
const isPathChar = c => /^[A-Za-z0-9/._-]$/.test(c);

/** Collapse the parts of a message that vary between occurrences, so repeats aggregate. */
export function normaliseMessage(msg) {
  const ch = Array.from(String(msg));
  let out = '';
  let i = 0;
  while (i < ch.length) {
    const c = ch[i];
    // 1. 0x… addresses
    if (c === '0' && (ch[i + 1] === 'x' || ch[i + 1] === 'X') && ch[i + 2] && isHex(ch[i + 2])) {
      let j = i + 2;
      while (j < ch.length && isHex(ch[j])) j++;
      out += '{addr}'; i = j; continue;
    }
    // 2. runs of 16+ hex characters (GUIDs, hashes) — checked before digits on purpose
    if (isHex(c)) {
      let j = i;
      while (j < ch.length && isHex(ch[j])) j++;
      if (j - i >= 16) { out += '{hex}'; i = j; continue; }
    }
    // 3. numbers, with at most one decimal part
    if (isDigit(c)) {
      let j = i;
      while (j < ch.length && isDigit(ch[j])) j++;
      if (ch[j] === '.' && ch[j + 1] && isDigit(ch[j + 1])) {
        j++;
        while (j < ch.length && isDigit(ch[j])) j++;
        out += '{f}';
      } else out += '{n}';
      i = j; continue;
    }
    // 4. paths
    if (c === '/' && ch[i + 1] && isAlnum(ch[i + 1])) {
      let j = i + 1;
      while (j < ch.length && isPathChar(ch[j])) j++;
      out += '{path}'; i = j; continue;
    }
    out += c; i++;
  }
  // Rust's split_whitespace does not treat U+FEFF as whitespace; JS \s does. Match Rust.
  return out.split(RUST_WHITESPACE).filter(Boolean).join(" ").slice(0, 200);
}

/**
 * Who wrote a log, and which build. A property of the FILE, resolved from its head: the command
 * line sits around byte 12,752, past any small read window (ue4log.rs Header, test at 931).
 */
export function readHeader(text) {
  const head = String(text).slice(0, 65536);
  let source = 'CLIENT';
  let build = null;
  let commandLine = null;
  for (const line of head.split(/\r?\n/)) {
    if (line.includes('Filtered Command Line:')) {
      if (!commandLine) commandLine = line.slice(line.indexOf('Filtered Command Line:') + 22).trim();
      if (line.includes('-nullrhi')) source = 'HOST';
    }
    if (!build) {
      const at = line.indexOf('LogInit: Build: ');
      if (at >= 0) build = line.slice(at + 16).trim().slice(0, 80);
    }
  }
  return { source, build, commandLine };
}
