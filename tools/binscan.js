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
} else {
  console.error('mode must be "count" or "regex"');
  process.exit(2);
}
