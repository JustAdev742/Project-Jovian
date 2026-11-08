/**
 * The crash-report readers: the minidump parser on a synthetic dump built to the documented layout,
 * and the UE4CC PCallStack format exactly as the real reports write it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMinidump, locate, peTimeDateStamp } from '../lib/minidump.mjs';
import { parsePCallStack, readCrash } from '../modules/runtime.mjs';

/** Build a minimal MDMP: header, 2 directory entries, one exception stream, one module. */
function synthDump({ code = 0xC0000005, address = 0x180000000n + 0x2e453n, access = [0n, 0x0n] } = {}) {
  const buf = Buffer.alloc(2048);
  buf.writeUInt32LE(0x504d444d, 0);           // MDMP
  buf.writeUInt32LE(2, 8);                    // NumberOfStreams
  buf.writeUInt32LE(32, 12);                  // StreamDirectoryRva
  // directory
  buf.writeUInt32LE(6, 32); buf.writeUInt32LE(168, 36); buf.writeUInt32LE(100, 40);   // exception
  buf.writeUInt32LE(4, 44); buf.writeUInt32LE(112, 48); buf.writeUInt32LE(400, 52);   // module list
  // exception stream @100: ThreadId, align, MINIDUMP_EXCEPTION
  buf.writeUInt32LE(4242, 100);
  const er = 108;
  buf.writeUInt32LE(code, er);
  buf.writeBigUInt64LE(address, er + 16);
  buf.writeUInt32LE(access.length, er + 24);
  access.forEach((v, i) => buf.writeBigUInt64LE(v, er + 32 + i * 8));
  // module list @400: one module, name at 700
  buf.writeUInt32LE(1, 400);
  const m = 404;
  buf.writeBigUInt64LE(0x180000000n, m);
  buf.writeUInt32LE(0xC4000, m + 8);
  buf.writeUInt32LE(0x66EB1234, m + 16);      // TimeDateStamp
  buf.writeUInt32LE(700, m + 20);
  const name = Buffer.from('C:\\x\\Project Reboot.dll', 'utf16le');
  buf.writeUInt32LE(name.length, 700);
  name.copy(buf, 704);
  return buf;
}

test('the exception code, faulting module and RVA come out of the dump', () => {
  const d = parseMinidump(synthDump());
  assert.equal(d.exception.code, 0xC0000005);
  assert.equal(d.exception.threadId, 4242);
  assert.equal(d.modules[0].name, 'Project Reboot.dll');
  assert.equal(d.modules[0].timeDateStamp, 0x66EB1234);
  const where = locate(d.modules, d.exception.address);
  assert.equal(where.module, 'Project Reboot.dll');
  assert.equal(where.rva, 0x2e453);
});

test('an address outside every module is not mis-attributed', () => {
  const d = parseMinidump(synthDump({ address: 0x7ff700000000n }));
  assert.equal(locate(d.modules, d.exception.address), null);
});

test('a non-dump file is refused rather than misread', () => {
  assert.equal(parseMinidump(Buffer.from('not a minidump at all, definitely not')), null);
});

test('PCallStack: module names with spaces, in the real format', () => {
  const f = parsePCallStack('Project Reboot 0x00000000ca9b0000 + 2e453 Project Reboot 0x00000000ca9b0000 + 7a29d FortniteClient-Win64-Shipping 0x00007ff778270000 + 2f3433');
  assert.deepEqual(f.map(x => x.module), ['Project Reboot', 'Project Reboot', 'FortniteClient-Win64-Shipping']);
  assert.deepEqual(f.map(x => x.rva), [0x2e453, 0x7a29d, 0x2f3433]);
});

test('role comes from the recorded command line, not the log copy beside it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-doctor-crash-'));
  fs.writeFileSync(path.join(dir, 'CrashContext.runtime-xml'), `<FGenericCrashContext><RuntimeProperties>
    <CommandLine>-epicapp=Fortnite -nullrhi -nosound -unattended</CommandLine>
    <GameStateName>FortGameStateFrontEnd</GameStateName><SecondsSinceStart>45</SecondsSinceStart>
    <PCallStack>Project Reboot 0x0000000180000000 + 2e453 Project Reboot 0x0000000180000000 + 7a29d</PCallStack>
    <TimeOfCrash>639253297152830000</TimeOfCrash></RuntimeProperties></FGenericCrashContext>`);
  fs.writeFileSync(path.join(dir, 'UE4Minidump.dmp'), synthDump());
  fs.writeFileSync(path.join(dir, 'FortniteGame.log'), 'LogInit: Filtered Command Line: -epicapp=Fortnite -nosplash\n'); // the CLIENT's log, as UE4 copies it
  const c = readCrash(dir);
  assert.equal(c.role, 'gameserver');
  assert.equal(c.uptime, 45);
  assert.equal(c.exception.name, 'ACCESS_VIOLATION');
  assert.equal(c.signature, 'Reboot+0x2e453 ← Reboot+0x7a29d');
  assert.equal(c.rebootStamp, 0x66EB1234);
  assert.match(c.time, /^2026-/);
});

test('PE TimeDateStamp is read from a real DLL header layout', () => {
  const buf = Buffer.alloc(512);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt32LE(0x66EB1234, 0x88);
  const p = path.join(os.tmpdir(), `nova-doctor-pe-${process.pid}.dll`);
  fs.writeFileSync(p, buf);
  assert.equal(peTimeDateStamp(p), 0x66EB1234);
});
