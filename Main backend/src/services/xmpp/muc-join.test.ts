/**
 * A chat-room join must always be answered.
 *
 * WHAT THIS PINS, AND WHY IT IS A REAL SOCKET TEST. Global chat did not work for an entire measured
 * session on 2026-09-06, and the reason was one `return` with nothing sent. The join handler saw the
 * account already listed in the room and treated that as "nothing to do" — but XMPP has no way to
 * express "nothing to do" for a join. The client had an outstanding request and waited on it
 * forever, logging `IsInChatRoom: 0` and
 *
 *   MUC: JoinPublicRoom failed. Another operation already pending for room Fortnite_Nova_global_…
 *
 * on every retry, while the chat manager re-queried the room list on a growing backoff — 159s, 216s,
 * 265s — for the whole match. The backend looked healthy the entire time: it had answered
 * `reserveGeneralChatRooms` with a perfectly good room.
 *
 * The stale membership came from the account being in the room twice. Occupancy was keyed by
 * ACCOUNT, and on this build one account routinely holds two connections: when a player hosts, the
 * client and the headless gameserver sign in as the same account with different resources. The
 * second one to join matched the first and got silence.
 *
 * So these drive a real WebSocket through a real handshake. The behaviour under test is what the
 * server SENDS, and a unit test of the membership array would have passed against the broken code —
 * the array was updated correctly; it was the response that was missing.
 *
 * Run: npm test
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const DB = path.join(os.tmpdir(), `nova-muc-${process.pid}.db`);

let server: http.Server;
let port: number;
let MUCs: Record<string, { members: { accountId: string; resource: string }[] }>;
let Clients: any[];

const ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'muc-test-token';
const ROOM = 'Fortnite_Nova_global_aaaaaaaa';
const MUC_HOST = 'muc.prod.ol.epicgames.com';

before(async () => {
  process.env.NOVA_DB_PATH = DB;
  // Dynamic import so NOVA_DB_PATH is set before config resolves it.
  const { initDatabase, ensureAccount, storeToken } = (await import('../../database')) as any;
  await initDatabase();
  ensureAccount(ACCOUNT, 'MucTester');
  storeToken(TOKEN, ACCOUNT, 'nova', 'password', new Date(Date.now() + 3600_000).toISOString());

  const xmpp = (await import('./xmpp.server')) as any;
  MUCs = xmpp.MUCs;
  Clients = xmpp.Clients;

  port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });

  server = http.createServer();
  xmpp.attachXmppWebSocket(server, 'TEST');
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
});

after(async () => {
  try { await new Promise<void>((r) => server.close(() => r())); } catch { /* already down */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* never existed */ }
  }
});

beforeEach(() => {
  for (const k of Object.keys(MUCs)) delete MUCs[k];
  Clients.length = 0;
});

/** One connected XMPP session, with everything received kept for assertions. */
interface Session {
  ws: WebSocket;
  received: string[];
  /** Wait until something matching `re` arrives, or resolve false on timeout. */
  waitFor(re: RegExp, ms?: number): Promise<boolean>;
  close(): void;
}

function connect(): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'xmpp');
    const received: string[] = [];
    ws.on('message', (d) => received.push(d.toString()));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        received,
        waitFor(re: RegExp, ms = 4000) {
          return new Promise<boolean>((res) => {
            const started = Date.now();
            const tick = setInterval(() => {
              if (received.some((m) => re.test(m))) { clearInterval(tick); res(true); return; }
              if (Date.now() - started > ms) { clearInterval(tick); res(false); }
            }, 25);
          });
        },
        close() { try { ws.close(); } catch { /* already closed */ } },
      }),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Full handshake: open → PLAIN auth → bind(resource) → session.
 *
 * `resource` is the parameter that matters here — it is what distinguishes a player's client from
 * the headless gameserver running on the same account.
 */
async function signIn(resource: string): Promise<Session> {
  const s = await connect();
  s.ws.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>`);
  assert.ok(await s.waitFor(/stream:features|<features/), 'no stream features');

  const sasl = Buffer.from(`\0${ACCOUNT}\0${TOKEN}`, 'utf-8').toString('base64');
  s.ws.send(`<auth mechanism="PLAIN" xmlns="urn:ietf:params:xml:ns:xmpp-sasl">${sasl}</auth>`);
  assert.ok(await s.waitFor(/<success/), `auth failed: ${s.received.join(' | ').slice(0, 300)}`);

  s.ws.send(
    `<iq id="_xmpp_bind1" type="set" xmlns="jabber:client">` +
    `<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${resource}</resource></bind></iq>`,
  );
  assert.ok(await s.waitFor(/_xmpp_bind1/), 'bind was not answered');

  s.ws.send(`<iq id="_xmpp_session1" type="set" xmlns="jabber:client"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>`);
  await s.waitFor(/_xmpp_session1/, 2000);
  await sleep(120); // let registration settle
  return s;
}

/** The MUC join stanza Fortnite sends. */
function joinRoom(s: Session, resource: string, room = ROOM): void {
  s.ws.send(
    `<presence to="${room}@${MUC_HOST}/MucTester:${ACCOUNT}:${resource}" xmlns="jabber:client">` +
    `<x xmlns="http://jabber.org/protocol/muc"/></presence>`,
  );
}

describe('joining a chat room', () => {
  test('a first join is confirmed', async () => {
    const s = await signIn('client-1');
    try {
      joinRoom(s, 'client-1');
      assert.ok(
        await s.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`)),
        `no join confirmation: ${s.received.join(' | ').slice(0, 400)}`,
      );
      assert.equal(MUCs[ROOM]?.members.length, 1);
    } finally { s.close(); }
  });

  test('THE REGRESSION: a repeat join is answered, not silently dropped', async () => {
    // This is the exact deadlock. The old code returned without sending, the client's join stayed
    // pending forever, and every later attempt failed with "Another operation already pending".
    const s = await signIn('client-1');
    try {
      joinRoom(s, 'client-1');
      assert.ok(await s.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`)), 'first join not confirmed');

      const before = s.received.length;
      joinRoom(s, 'client-1');
      await sleep(400);
      const after = s.received.slice(before);
      assert.ok(
        after.some((m) => new RegExp(`<presence[^>]*from="${ROOM}@`).test(m)),
        'a repeat join was answered with SILENCE — the client waits on it forever',
      );
      // …and it must not double-count the occupant.
      assert.equal(MUCs[ROOM].members.length, 1, 'the repeat join added a duplicate occupant');
    } finally { s.close(); }
  });

  test('THE CAUSE: a hosting player is two sessions on one account, and both get in', async () => {
    // When this PC hosts, the client and the headless gameserver sign in as the SAME account with
    // different resources. Occupancy keyed by account meant the second one matched the first and
    // was refused with silence — which is how a host ended up with no global chat at all.
    const client = await signIn('client-1');
    const gameserver = await signIn('server-1');
    try {
      joinRoom(client, 'client-1');
      assert.ok(await client.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`)), 'the client did not get in');

      joinRoom(gameserver, 'server-1');
      assert.ok(
        await gameserver.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`)),
        'the second session on the same account was refused with silence',
      );

      assert.equal(MUCs[ROOM].members.length, 2, 'both sessions must be occupants');
      const resources = MUCs[ROOM].members.map((m) => m.resource).sort();
      assert.deepEqual(resources, ['client-1', 'server-1']);
    } finally { client.close(); gameserver.close(); }
  });

  test('leaving removes only the session that left', async () => {
    const client = await signIn('client-1');
    const gameserver = await signIn('server-1');
    try {
      joinRoom(client, 'client-1');
      await client.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`));
      joinRoom(gameserver, 'server-1');
      await gameserver.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`));
      assert.equal(MUCs[ROOM].members.length, 2);

      // Only party rooms take the explicit unavailable path, so use one for this.
      const partyRoom = 'party-abc123';
      joinRoom(client, 'client-1', partyRoom);
      joinRoom(gameserver, 'server-1', partyRoom);
      await sleep(300);
      assert.equal(MUCs[partyRoom].members.length, 2, 'both should be in the party room');

      client.ws.send(
        `<presence to="${partyRoom}@${MUC_HOST}/MucTester:${ACCOUNT}:client-1" type="unavailable" xmlns="jabber:client"/>`,
      );
      await sleep(300);
      assert.equal(MUCs[partyRoom].members.length, 1, 'one leave removed both occupants');
      assert.equal(MUCs[partyRoom].members[0].resource, 'server-1', 'the wrong occupant was removed');
    } finally { client.close(); gameserver.close(); }
  });

  test('a disconnect frees the room for the next join', async () => {
    // The failure mode that made this permanent: a socket that dies without a clean leave used to
    // leave the account listed, and every later join was then answered with silence.
    const first = await signIn('client-1');
    joinRoom(first, 'client-1');
    assert.ok(await first.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`)), 'first join failed');
    first.ws.terminate();
    await sleep(500);

    const second = await signIn('client-2');
    try {
      joinRoom(second, 'client-2');
      assert.ok(
        await second.waitFor(new RegExp(`<presence[^>]*from="${ROOM}@`)),
        'a new session could not join after the previous one dropped',
      );
    } finally { second.close(); }
  });
});
