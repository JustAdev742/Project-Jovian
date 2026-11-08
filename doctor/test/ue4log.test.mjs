/**
 * The doctor's UE4 log grammar must agree with the launcher's (Launcher/src-tauri/src/ue4log.rs).
 * Every input below is copied from the launcher's own tests, which were copied from real 7.40 logs.
 * If one of these fails, the two readers disagree about what is an error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, normaliseMessage, readHeader, BAD_VERBOSITY, SUBSYSTEMS } from '../lib/ue4log.mjs';

test('a real error line parses', () => {
  const l = parseLine('[2026.09.06-02.05.28:384][699]LogFort: Error: AFortPlayerController::GetAthenaLoadoutWithOverrides(): MCP is enabled but we were unable to load AthenaProfile');
  assert.equal(l.category, 'LogFort');
  assert.equal(l.verbosity, 'Error');
  assert.ok(l.message.startsWith('AFortPlayerController::'));
  assert.equal(l.stamp, '2026.09.06-02.05.28:384');
  assert.equal(l.frame, '699');
});

test('a success line containing "Error:" is not an error', () => {
  const l = parseLine('[2026.09.06-02.05.28:585][710]LogFortChat: *!* UFortChatManager::HandleReserveChatRoomsComplete - Result Succeded: 1, Error: , Num Global Rooms: 1');
  assert.equal(l.verbosity, 'Log');
  assert.ok(!BAD_VERBOSITY.includes(l.verbosity));
});

test('a CVar named ...Warning is not a warning', () => {
  const l = parseLine('[2026.09.06-02.04.57:501][  0]LogConfig: Setting CVar [[r.PrecomputedVisibilityWarning:0]]');
  assert.equal(l.category, 'LogConfig');
  assert.equal(l.verbosity, 'Log');
});

test('a warning whose message contains "Error:" keeps its real verbosity', () => {
  const l = parseLine('[2026.09.06-02.05.11:988][  0]LogGfeSDK: Warning: 2026-09-06T12:05:11.989[E] GAME CoreCInterface.cpp:79 Error: failed initializing SDK -1022');
  assert.equal(l.verbosity, 'Warning');
});

test('a line written before timestamps start still parses', () => {
  const l = parseLine('LogPakFile: Display: Mounting pak file ../../../FortniteGame/Content/Paks/pakchunk9-WindowsClient.pak.');
  assert.equal(l.category, 'LogPakFile');
  assert.equal(l.verbosity, 'Display');
  assert.equal(l.stamp, null);
});

test('the header line is not mistaken for a category', () => {
  assert.equal(parseLine('Log file open, 09/06/26 12:04:56'), null);
});

test('an unclosed bracket fails the line', () => {
  assert.equal(parseLine('[2026.09.06-02.05.28:384 LogFort: Error: x'), null);
});

test('stack frame addresses collapse to one key', () => {
  const keys = new Set(['0x00007ffca813fb74', '0x00007ffca590c1ae', '0x00007ff61a673c97'].map(normaliseMessage));
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], '{addr}');
});

test('timings aggregate across different durations', () => {
  const a = normaliseMessage('Took 245.85ms to ProcessLoadedPackages');
  const b = normaliseMessage('Took 1213.00ms to ProcessLoadedPackages');
  assert.equal(a, b);
  assert.equal(a, 'Took {f}ms to ProcessLoadedPackages');
});

test('aligned whitespace does not split a row', () => {
  assert.equal(
    normaliseMessage("Hitch detected on gamethread (frame hasn't finished for   504.51ms):"),
    normaliseMessage("Hitch detected on gamethread (frame hasn't finished for 12.00ms):"));
});

test('GUIDs and paths are collapsed', () => {
  assert.equal(
    normaliseMessage('AFortQuickBars::AddItemInternal could not find Item with GUID 8F3A2B1C9D4E5F60'),
    'AFortQuickBars::AddItemInternal could not find Item with GUID {hex}');
  assert.equal(
    normaliseMessage("Couldn't find file for package /Game/Items/Datatables/LootQuotaData requested"),
    "Couldn't find file for package {path} requested");
});

test('Win64 keeps its rule: digits become {n}', () => {
  assert.equal(normaliseMessage('Win64'), 'Win{n}');
});

test('the 14 Nova-owned categories are exactly the launcher list', () => {
  assert.equal(Object.keys(SUBSYSTEMS).length, 14);
  assert.equal(SUBSYSTEMS.LogNet, 'matchmaking');
  assert.equal(SUBSYSTEMS.LogHttp, 'other');
});

test('the gameserver is told apart by -nullrhi, even past the first 12 KB', () => {
  const pad = 'LogInit: Display: padding\n'.repeat(600); // ~15 KB of preamble, like a real log
  const host = readHeader(`${pad}LogInit: Build: ++Fortnite+Release-7.40-CL-5046157\nLogInit: Filtered Command Line: -epicapp=Fortnite -nullrhi -nosound\n`);
  assert.equal(host.source, 'HOST');
  assert.equal(host.build, '++Fortnite+Release-7.40-CL-5046157');
  const client = readHeader(`${pad}LogInit: Filtered Command Line: -epicapp=Fortnite -nosplash\n`);
  assert.equal(client.source, 'CLIENT');
});
