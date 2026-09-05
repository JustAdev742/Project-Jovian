/**
 * Scan a binary for literal strings in both ASCII and UTF-16LE.
 *
 * UE4 stores FString / TEXT() literals as UTF-16LE, while char* literals (URLs handed to curl,
 * for example) are ASCII. Searching only one encoding gives a false negative — which is exactly
 * how "acceptInvites: 0 occurrences" nearly became "7.40 does not use this field".
 *
 * Usage:  node binscan.js <file> count  <needle> [needle...]
 *         node binscan.js <file> regex  <ascii-regex>          (extracts matches, ASCII only)
 */
const fs = require('fs');

const [, , file, mode, ...args] = process.argv;
const buf = fs.readFileSync(file);

function utf16le(s) {
  return Buffer.from(s, 'utf16le');
}

function countOccurrences(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle, 0);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}

if (mode === 'count') {
  for (const needle of args) {
    const a = countOccurrences(buf, Buffer.from(needle, 'latin1'));
    const w = countOccurrences(buf, utf16le(needle));
    const verdict = a + w > 0 ? 'PRESENT' : 'ABSENT ';
    console.log(
      `  ${verdict}  ${needle.padEnd(38)} ascii=${String(a).padStart(4)}  utf16=${String(w).padStart(4)}`,
    );
  }
} else if (mode === 'regex') {
  // ASCII pass
  const re = new RegExp(args[0], 'g');
  const found = new Set();
  const text = buf.toString('latin1');
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[0]);

  // UTF-16LE pass: strip the interleaved NULs, then run the same regex.
  const wide = Buffer.alloc(Math.floor(buf.length / 2));
  for (let i = 0, j = 0; i + 1 < buf.length; i += 2, j++) {
    wide[j] = buf[i + 1] === 0 ? buf[i] : 0;
  }
  const wtext = wide.toString('latin1');
  const re2 = new RegExp(args[0], 'g');
  while ((m = re2.exec(wtext)) !== null) found.add(m[0]);

  for (const s of [...found].sort()) console.log(s);
} else if (mode === 'enclosing') {
  // WHY THIS MODE EXISTS. `count` answers "is this literal here", which is the wrong question for
  // anything path-shaped. The client stores path FRAGMENTS and prepends the service base URL at
  // runtime, so no full path is ever contiguous: `fortnite/api/game/v2` counts ZERO in 7.40, a
  // build that calls it 229 times a session. Searching for a whole path and finding nothing is the
  // single easiest way to produce a confident wrong answer with this tool.
  //
  // `enclosing` takes a SHORT distinctive needle and prints the complete string it sits inside, so
  // you see the fragment the build actually stores — e.g. needle "/settings" yields
  // "/api/v1/`id/settings", which is what reconciles with the observed request log.
  const out = new Set();
  for (const needle of args) {
    // UTF-16LE: strings are NUL-NUL delimited on even offsets.
    const pat = utf16le(needle);
    for (let i = buf.indexOf(pat, 0); i !== -1; i = buf.indexOf(pat, i + 2)) {
      let a = i, b = i;
      while (a >= 2 && !(buf[a - 2] === 0 && buf[a - 1] === 0)) a -= 2;
      while (b + 1 < buf.length && !(buf[b] === 0 && buf[b + 1] === 0)) b += 2;
      out.add('utf16  ' + JSON.stringify(buf.slice(a, b).toString('utf16le')));
    }
    // ASCII: single-NUL delimited.
    const apat = Buffer.from(needle, 'latin1');
    for (let i = buf.indexOf(apat, 0); i !== -1; i = buf.indexOf(apat, i + 1)) {
      let a = i, b = i;
      while (a > 0 && buf[a - 1] >= 0x20 && buf[a - 1] < 0x7f) a--;
      while (b < buf.length && buf[b] >= 0x20 && buf[b] < 0x7f) b++;
      if (b - a >= needle.length) out.add('ascii  ' + JSON.stringify(buf.slice(a, b).toString('latin1')));
    }
  }
  if (out.size === 0) console.log('  (no enclosing string found — check the needle and see the traps in README.md)');
  for (const line of [...out].sort()) console.log('  ' + line);
} else {
  console.error('mode must be "count", "regex" or "enclosing"');
  process.exit(2);
}
