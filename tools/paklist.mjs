// List the file index of UE4 (v8, 4.22) pak files. Reads ONLY the footer + index -- never the payload.
// Usage: node paklist.mjs <paksDir> <hexKey> <regex> [maxPrint]
import { openSync, readSync, closeSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { join } from 'node:path';

const [,, dir, hexKey, pattern = '.', maxPrint = '400'] = process.argv;
const key = Buffer.from(hexKey, 'hex');
const re = new RegExp(pattern, 'i');
const MAGIC = 0x5a6f12e1;

function readAt(fd, off, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, b, got, len - got, off + got);
    if (n <= 0) break;
    got += n;
  }
  return b.subarray(0, got);
}

function footer(fd, size) {
  // v8 footer is 189 (4 compression names) or 221 (5 names); find the magic.
  for (const flen of [221, 189, 45, 61]) {
    const f = readAt(fd, size - flen, flen);
    // layout: guid(16) encryptedIndex(1) magic(4) version(4) indexOffset(8) indexSize(8) hash(20) [names]
    const magicAt = 16 + 1;
    if (f.length === flen && f.readUInt32LE(magicAt) === MAGIC) {
      return {
        guid: f.subarray(0, 16),
        encrypted: f[16] !== 0,
        version: f.readUInt32LE(magicAt + 4),
        indexOffset: Number(f.readBigInt64LE(magicAt + 8)),
        indexSize: Number(f.readBigInt64LE(magicAt + 16)),
      };
    }
  }
  return null;
}

function fstring(buf, pos) {
  const len = buf.readInt32LE(pos); pos += 4;
  if (len === 0) return { s: '', pos };
  if (len < 0) { const n = -len; const s = buf.toString('utf16le', pos, pos + n * 2 - 2); return { s, pos: pos + n * 2 }; }
  const s = buf.toString('latin1', pos, pos + len - 1);
  return { s, pos: pos + len };
}

function parseIndex(buf, version) {
  let pos = 0;
  const mp = fstring(buf, pos); pos = mp.pos;
  const num = buf.readInt32LE(pos); pos += 4;
  const names = [];
  for (let i = 0; i < num; i++) {
    const fn = fstring(buf, pos); pos = fn.pos;
    // FPakEntry
    pos += 8 + 8 + 8;                        // Offset, Size, UncompressedSize
    const method = buf.readInt32LE(pos); pos += 4;   // CompressionMethodIndex (v8) / CompressionMethod
    pos += 20;                               // Hash
    if (version >= 3) {
      if (method !== 0) { const nb = buf.readInt32LE(pos); pos += 4 + nb * 16; }
      pos += 1;                              // Flags
      pos += 4;                              // CompressionBlockSize
    }
    names.push(fn.s);
  }
  return { mount: mp.s, num, names };
}

const out = [];
let totalEntries = 0, paks = 0, skipped = [];
for (const file of readdirSync(dir).filter(f => f.endsWith('.pak')).sort()) {
  const p = join(dir, file);
  const size = statSync(p).size;
  const fd = openSync(p, 'r');
  try {
    const ft = footer(fd, size);
    if (!ft) { skipped.push(`${file}: no footer magic`); continue; }
    const zeroGuid = ft.guid.every(b => b === 0);
    if (ft.encrypted && !zeroGuid) { skipped.push(`${file}: secondary key ${ft.guid.toString('hex')}`); continue; }
    let idx = readAt(fd, ft.indexOffset, ft.indexSize);
    if (ft.encrypted) {
      const d = createDecipheriv('aes-256-ecb', key, null); d.setAutoPadding(false);
      idx = Buffer.concat([d.update(idx), d.final()]);
    }
    const { mount, num, names } = parseIndex(idx, ft.version);
    paks++; totalEntries += num;
    for (const n of names) { const full = mount + n; if (re.test(full)) out.push(full); }
    console.error(`${file}: v${ft.version} ${num} entries, mount=${mount}`);
  } catch (e) { skipped.push(`${file}: ${e.message}`); }
  finally { closeSync(fd); }
}
console.log(`# ${paks} pak(s), ${totalEntries} entries, ${out.length} match /${pattern}/i`);
for (const s of skipped) console.log(`# skipped ${s}`);
out.sort();
writeFileSync(join(process.env.OUT_DIR || '.', 'paklist-matches.txt'), out.join('\n'));
for (const l of out.slice(0, Number(maxPrint))) console.log(l);
if (out.length > Number(maxPrint)) console.log(`... ${out.length - Number(maxPrint)} more in paklist-matches.txt`);
