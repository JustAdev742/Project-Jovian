/**
 * Just enough of the Windows minidump format to answer "what crashed, where, and which build".
 *
 * UE4's CrashContext.runtime-xml does NOT carry the exception code, and its log copy is often the
 * wrong process's log (13 of 18 gameserver crashes on the dev PC held the CLIENT's log). The dump is
 * the only record of the code, the faulting address and the exact module builds loaded.
 *
 * Layouts (minidumpapiset.h): MINIDUMP_HEADER, MINIDUMP_DIRECTORY, MINIDUMP_EXCEPTION_STREAM (type 6),
 * MINIDUMP_MODULE_LIST (type 4, 108-byte MINIDUMP_MODULE entries).
 */
import fs from 'node:fs';

const MDMP = 0x504d444d;

export function parseMinidump(buf) {
  if (!buf || buf.length < 32 || buf.readUInt32LE(0) !== MDMP) return null;
  const count = buf.readUInt32LE(8);
  const dir = buf.readUInt32LE(12);
  const streams = {};
  for (let i = 0; i < count; i++) {
    const o = dir + i * 12;
    if (o + 12 > buf.length) break;
    streams[buf.readUInt32LE(o)] = { size: buf.readUInt32LE(o + 4), rva: buf.readUInt32LE(o + 8) };
  }

  let exception = null;
  const ex = streams[6];
  if (ex && ex.rva + 8 + 152 <= buf.length) {
    const er = ex.rva + 8;                           // skip ThreadId + alignment
    const nparams = Math.min(buf.readUInt32LE(er + 24), 15);
    const params = [];
    for (let k = 0; k < nparams; k++) params.push(buf.readBigUInt64LE(er + 32 + k * 8));
    exception = {
      threadId: buf.readUInt32LE(ex.rva),
      code: buf.readUInt32LE(er),
      address: buf.readBigUInt64LE(er + 16),
      params,
    };
  }

  const modules = [];
  const ml = streams[4];
  if (ml && ml.rva + 4 <= buf.length) {
    const n = buf.readUInt32LE(ml.rva);
    for (let k = 0; k < n; k++) {
      const m = ml.rva + 4 + k * 108;
      if (m + 108 > buf.length) break;
      const nameRva = buf.readUInt32LE(m + 20);
      let name = '';
      if (nameRva + 4 <= buf.length) {
        const len = buf.readUInt32LE(nameRva);
        name = buf.toString('utf16le', nameRva + 4, Math.min(nameRva + 4 + len, buf.length));
      }
      modules.push({
        base: buf.readBigUInt64LE(m),
        size: buf.readUInt32LE(m + 8),
        timeDateStamp: buf.readUInt32LE(m + 16),
        path: name,
        name: name.split(/[\\/]/).pop(),
      });
    }
  }
  return { exception, modules };
}

export function readMinidump(path) {
  try { return parseMinidump(fs.readFileSync(path)); } catch { return null; }
}

/** Which module holds `addr`, and the RVA within it. */
export function locate(modules, addr) {
  for (const m of modules) {
    if (addr >= m.base && addr < m.base + BigInt(m.size)) return { module: m.name, rva: Number(addr - m.base), timeDateStamp: m.timeDateStamp };
  }
  return null;
}

/** The PE TimeDateStamp of a DLL on disk — matches MINIDUMP_MODULE.TimeDateStamp for the same build. */
export function peTimeDateStamp(path) {
  try {
    const fd = fs.openSync(path, 'r');
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, 4096, 0);
    fs.closeSync(fd);
    const pe = head.readUInt32LE(0x3c);
    if (head.readUInt32LE(pe) !== 0x00004550) return null;   // "PE\0\0"
    return head.readUInt32LE(pe + 8);
  } catch { return null; }
}

export const EXCEPTION_NAMES = {
  0xC0000005: 'ACCESS_VIOLATION', 0xC00000FD: 'STACK_OVERFLOW', 0xC0000409: 'STACK_BUFFER_OVERRUN',
  0xC000001D: 'ILLEGAL_INSTRUCTION', 0xC0000094: 'INT_DIVIDE_BY_ZERO', 0x80000003: 'BREAKPOINT',
  0xE06D7363: 'C++ EXCEPTION', 0x00004000: 'UE4 ASSERT',
};
