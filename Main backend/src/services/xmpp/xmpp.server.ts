import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Config } from '../../config';
import { verifyToken } from '../auth/token.service';
import { validateToken, getAccount } from '../../database';
import { hasLiveGameServer, matchmakingStarted, matchmakingEnded } from '../matchmaking/matchmaking.routes';

/**
 * XMPP Server — WebSocket on port 80.
 * Based on LawinServer's proven pattern:
 * - WebSocket.Server on port 80 (Cobalt redirects here)
 * - Protocol "xmpp" for XMPP, anything else for matchmaker
 * - Uses <open> framing (urn:ietf:params:xml:ns:xmpp-framing), NOT <stream:stream>
 */

const XMPP_DOMAIN = 'prod.ol.epicgames.com';
const MUC_DOMAIN = `muc.${XMPP_DOMAIN}`;

export interface XmppClient {
  ws: WebSocket;
  accountId: string;
  displayName: string;
  jid: string;
  resource: string;
  authenticated: boolean;
  clientExists: boolean;
  lastPresenceUpdate: { away: boolean; status: string };
  joinedMUCs: string[];
  ID: string;
}

/** Global client registry */
export const Clients: XmppClient[] = [];

/** MUC rooms */
export const MUCs: Record<string, { members: { accountId: string }[] }> = {};

function makeID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Minimal XML parser — extracts tag name, attributes, children, content */
function parseXml(xml: string): any {
  try {
    // Get root tag name
    const tagMatch = xml.match(/<([a-zA-Z0-9:_-]+)[\s/>]/);
    if (!tagMatch) return null;
    const name = tagMatch[1];

    // Get attributes
    const attributes: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9:_-]+)="([^"]*)"/g;
    let m;
    while ((m = attrRegex.exec(xml)) !== null) {
      attributes[m[1]] = m[2];
    }

    // Get children (simplified). NOTE: the element regexes tolerate ATTRIBUTES (`\b[^>]*>`) — a real
    // client can send `<body xml:lang="en">`, `<status ...>`, etc., and matching a bare `<body>` would
    // silently drop the whole stanza (a class of intermittent chat/party/presence failures).
    const children: any[] = [];
    // Find <body ...>...</body>
    const bodyMatch = xml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/);
    if (bodyMatch) children.push({ name: 'body', content: bodyMatch[1] });
    // Find <resource ...>...</resource>
    const resMatch = xml.match(/<resource\b[^>]*>([\s\S]*?)<\/resource>/);
    if (resMatch) children.push({ name: 'resource', content: resMatch[1] });
    // Find <bind ...>
    if (xml.includes('<bind')) children.push({ name: 'bind', children: resMatch ? [{ name: 'resource', content: resMatch[1] }] : [] });
    // Find <status ...>...</status>
    const statusMatch = xml.match(/<status\b[^>]*>([\s\S]*?)<\/status>/);
    if (statusMatch) children.push({ name: 'status', content: statusMatch[1] });
    // Find <show>...</show>
    if (xml.includes('<show>')) children.push({ name: 'show', content: 'away' });
    // Find muc:x or x xmlns="http://jabber.org/protocol/muc"
    if (xml.includes('protocol/muc') || xml.includes('muc:x') || xml.includes('<x ')) {
      children.push({ name: 'x' });
      children.push({ name: 'muc:x' });
    }

    // Get text content (for <auth>base64</auth>)
    const contentMatch = xml.match(new RegExp(`<${name}[^>]*>([^<]+)</${name}>`));
    const content = contentMatch ? contentMatch[1] : '';

    return { root: { name, attributes, children, content } };
  } catch {
    return null;
  }
}

function xmppError(ws: WebSocket): void {
  try {
    ws.send('<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>');
    ws.close();
  } catch { }
}

function getMUCmember(roomName: string, displayName: string, accountId: string, resource: string): string {
  // encodeURIComponent, NOT encodeURI: encodeURI leaves `&` intact, and display names are
  // user-controlled (auth.routes derives them from the username with no filtering). An unescaped
  // `&` inside these from=/nick= attributes is an undefined entity reference — a FATAL XML error
  // that tears down the XMPP stream of every other client in the party room.
  return `${roomName}@${MUC_DOMAIN}/${encodeURIComponent(displayName)}:${accountId}:${resource}`;
}

/** Escape a user-controlled string before putting it in an XMPP XML stanza (prevents another
 *  client injecting arbitrary stanzas via a crafted chat body). */
function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Reconnect handling: drop a stale connection for the SAME account AND SAME resource, so a genuine
 * reconnect of that endpoint succeeds instead of being refused until the old socket is reaped.
 *
 * MUST be resource-aware. An XMPP account is allowed multiple simultaneous resources — that is the
 * entire point of the resource part of a JID — and this setup relies on it: the launcher starts TWO
 * Fortnite processes (the visible client and the headless `-nullrhi` server) with the SAME
 * -AUTH_LOGIN/-AUTH_PASSWORD, so both log into XMPP as one account with different resources.
 *
 * Matching on the bare account made them evict each other in a loop, roughly every 4 seconds:
 *
 *     V2:Fortnite:WIN::AFED35C6…  loggedout
 *     V2:Fortnite:WIN::1EF5422B…  loggedin
 *     V2:Fortnite:WIN::1EF5422B…  loggedout      <- kicked by the other process
 *     V2:Fortnite:WIN::699A5DF3…  loggedin
 *
 * On 7.40 the party system is XMPP-only (the build has no /party HTTP service at all), so every
 * eviction tore the persistent party down — Active -> Disconnected -> CleanUp -> Active — which is
 * exactly what the client reports as "PARTY FUNCTIONALITY LIMITED / party services are currently
 * experiencing technical difficulties".
 */
function dropExistingClient(accountId: string, resource: string): void {
  const existing = Clients.find(c => c.accountId === accountId && c.resource === resource);
  if (!existing) return;
  try { existing.ws.close(); } catch { }
  // Reaping the MUC memberships HERE is required. removeClient() bails at `idx === -1` when the
  // stale socket finally emits 'close' (it is already spliced out of Clients by then), so its rooms
  // would never be cleaned up — and the reconnecting client is then refused its own party room by
  // the members.find() guard in the presence handler: no self-presence, no occupant roster, dead
  // party chat until a full restart.
  for (const roomName of existing.joinedMUCs) {
    const room = MUCs[roomName];
    if (!room) continue;
    const mi = room.members.findIndex(m => m.accountId === existing.accountId);
    if (mi !== -1) room.members.splice(mi, 1);
    if (room.members.length === 0) delete MUCs[roomName];
  }
  existing.joinedMUCs.length = 0;
  const i = Clients.indexOf(existing);
  if (i !== -1) Clients.splice(i, 1);
}

/**
 * Websocket paths the EOS SDK opens that are NOT the matchmaker.
 *
 * The client is handed these in sdkv1.json (lobby/notification/RTC endpoints) and dials them
 * whenever it feels like it — at login, in the lobby, on party changes. The matchmaker, by contrast,
 * lives at the root because that is what Config.MMS_URL points at. Anything not listed here still
 * falls through to the matchmaker, so an unknown-but-real MMS path keeps working.
 */
const EOS_SOCKET_PREFIXES = ['/lobby/', '/notifications/', '/cerberus-edge/', '/rtc', '/connect'];

function isEosSocket(url: string): boolean {
  const p = url.split('?')[0].toLowerCase();
  return EOS_SOCKET_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix));
}

/** Shared connection handler — used by both standalone and attached WebSocket servers */
function handleXmppConnection(ws: WebSocket, req: http.IncomingMessage): void {
  ws.on('error', () => { });

  // Route XMPP vs the MMS matchmaker. The old check read only `ws.protocol`, but the WebSocketServer
  // never echoed the client's subprotocol, so `ws.protocol` was ALWAYS '' → every XMPP socket was
  // misrouted to the matchmaker and never authenticated (proven: 19 upgrades, 0 XMPP auths). Now the
  // server echoes 'xmpp' (see attachXmppWebSocket handleProtocols) AND we also check the raw header,
  // in case the proxy passed the subprotocol through on the header but ws didn't negotiate it.
  const negotiated = (ws.protocol || '').toLowerCase();
  const rawHeader = String(req.headers['sec-websocket-protocol'] || '').toLowerCase();
  const isXmpp = negotiated === 'xmpp' || rawHeader.split(',').map(s => s.trim()).includes('xmpp');
  const url = String(req.url || '/');

  if (!isXmpp && isEosSocket(url)) {
    // An EOS socket, not matchmaking. These paths are advertised to the client in sdkv1.json, and
    // because this upgrade handler never looked at the path they were all being run through the MMS
    // state machine — each one registering a matchmaking waiter. That fabricated demand out of a
    // client that had not pressed Play, which in P2P mode is enough to make the coordinator elect a
    // host and spin up a gameserver for nobody. Hold the socket open (the client tolerates silence)
    // but keep it out of matchmaking entirely.
    console.log(`[XMPP-WS] connection: ${url} -> EOS socket (idle, not matchmaking)`);
    ws.on('message', () => { });
    return;
  }

  console.log(`[XMPP-WS] connection: ${url} negotiated="${negotiated}" rawSubprotocol="${rawHeader}" -> ${isXmpp ? 'XMPP' : 'matchmaker'}`);

  if (!isXmpp) {
    handleMatchmaker(ws);
    return;
  }

  console.log(`[XMPP] WebSocket client connected from ${req.socket.remoteAddress}`);

  let accountId = '';
  let displayName = '';
  let token = '';
  let jid = '';
  let resource = '';
  let ID = '';
  let authenticated = false;
  let clientExists = false;
  let connectionClosed = false;
  const joinedMUCs: string[] = [];

  ws.on('message', (rawMsg) => {
    const message = Buffer.isBuffer(rawMsg) ? rawMsg.toString() : String(rawMsg);
    if (!message || message.trim() === '') { try { ws.send(' '); } catch { } return; }

    const logData = message.length > 300 ? message.substring(0, 300) + '...' : message;
    console.log(`[XMPP RX] ${logData}`);

    const msg = parseXml(message);
    if (!msg?.root?.name) return;

    switch (msg.root.name) {
      case 'open': {
        if (!ID) ID = makeID();
        ws.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="${XMPP_DOMAIN}" id="${ID}" version="1.0" xml:lang="en"/>`);
        if (authenticated) {
          ws.send(
            `<stream:features xmlns:stream="http://etherx.jabber.org/streams">` +
            `<ver xmlns="urn:xmpp:features:rosterver"/>` +
            `<starttls xmlns="urn:ietf:params:xml:ns:xmpp-tls"/>` +
            `<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/>` +
            `<compression xmlns="http://jabber.org/features/compress"><method>zlib</method></compression>` +
            `<session xmlns="urn:ietf:params:xml:ns:xmpp-session"/>` +
            `</stream:features>`
          );
        } else {
          ws.send(
            `<stream:features xmlns:stream="http://etherx.jabber.org/streams">` +
            `<mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms>` +
            `<ver xmlns="urn:xmpp:features:rosterver"/>` +
            `<starttls xmlns="urn:ietf:params:xml:ns:xmpp-tls"/>` +
            `<compression xmlns="http://jabber.org/features/compress"><method>zlib</method></compression>` +
            `<auth xmlns="http://jabber.org/features/iq-auth"/>` +
            `</stream:features>`
          );
        }
        break;
      }
      case 'auth': {
        if (!ID || accountId) return;
        if (!msg.root.content) return xmppError(ws);
        try {
          const decoded = Buffer.from(msg.root.content, 'base64').toString('utf-8');
          if (!decoded.includes('\0')) return xmppError(ws);
          const parts = decoded.split('\0');
          const authToken = parts[2] || parts[1] || '';

          // Method 1: Token registry lookup (like LawinServer's global.accessTokens)
          const registryAccountId = authToken ? validateToken(authToken) : null;
          if (registryAccountId) {
            // NOTE: no dropExistingClient() here. The resource is not known until the bind
            // IQ arrives, and evicting on the bare account at auth time is what made the two
            // Fortnite processes (client + headless server, same account) kick each other in
            // a loop. Eviction now happens at bind, scoped to the same resource.
            const acct = getAccount(registryAccountId);
            accountId = registryAccountId;
            displayName = acct?.display_name || 'NovaPlayer';
            token = authToken;
            authenticated = true;
            console.log(`[XMPP] Authenticated via registry: ${displayName} (${accountId})`);
            ws.send(`<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>`);
            break;
          }

          // Method 2: JWT signature verification (fallback)
          const payload = authToken ? verifyToken(authToken) : null;
          if (payload) {
            // NOTE: no dropExistingClient() here. The resource is not known until the bind
            // IQ arrives, and evicting on the bare account at auth time is what made the two
            // Fortnite processes (client + headless server, same account) kick each other in
            // a loop. Eviction now happens at bind, scoped to the same resource.
            accountId = payload.sub;
            displayName = payload.dn || 'NovaPlayer';
            token = authToken;
            authenticated = true;
            console.log(`[XMPP] Authenticated via JWT: ${displayName} (${accountId})`);
            ws.send(`<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>`);
            break;
          }

          console.log(`[XMPP] Auth FAILED — token not found in registry and JWT verification failed`);
          return xmppError(ws);
        } catch (err) { console.log(`[XMPP] Auth exception:`, err); return xmppError(ws); }
        break;
      }
      case 'iq': {
        if (!ID) return;
        const iqId = msg.root.attributes.id || '';
        if (iqId === '_xmpp_bind1') {
          if (resource || !accountId) return;
          const resChild = msg.root.children.find((c: any) => c.name === 'resource');
          if (!resChild?.content) return;
          // Scoped to this exact resource: a genuine reconnect of the SAME endpoint replaces its own
          // stale session, while a different resource (the other Fortnite process on this account)
          // is left alone.
          dropExistingClient(accountId, resChild.content);
          resource = resChild.content;
          jid = `${accountId}@${XMPP_DOMAIN}/${resource}`;
          ws.send(
            `<iq to="${jid}" id="_xmpp_bind1" xmlns="jabber:client" type="result">` +
            `<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>${jid}</jid></bind></iq>`
          );
        } else if (iqId === '_xmpp_session1') {
          if (!clientExists) return xmppError(ws);
          ws.send(`<iq to="${jid}" from="${XMPP_DOMAIN}" id="_xmpp_session1" xmlns="jabber:client" type="result"/>`);
        } else {
          if (!clientExists) return xmppError(ws);
          ws.send(`<iq to="${jid}" from="${XMPP_DOMAIN}" id="${iqId}" xmlns="jabber:client" type="result"/>`);
        }
        break;
      }
      case 'message': {
        if (!clientExists) return;
        const bodyChild = msg.root.children.find((c: any) => c.name === 'body');
        if (!bodyChild?.content) return;
        const body = bodyChild.content;
        const msgType = msg.root.attributes.type || '';
        const msgTo = msg.root.attributes.to || '';
        if (msgType === 'chat') {
          if (!msgTo || body.length >= 300) return;
          const receiver = Clients.find(c => c.jid.split('/')[0] === msgTo);
          if (!receiver || receiver.accountId === accountId) return;
          receiver.ws.send(`<message to="${receiver.jid}" from="${jid}" xmlns="jabber:client" type="chat"><body>${escapeXml(body)}</body></message>`);
          return;
        }
        if (msgType === 'groupchat') {
          if (!msgTo || body.length >= 300) return;
          const roomName = msgTo.split('@')[0];
          const muc = MUCs[roomName];
          if (!muc || !muc.members.find(m => m.accountId === accountId)) return;
          muc.members.forEach(member => {
            const cd = Clients.find(c => c.accountId === member.accountId);
            if (!cd) return;
            cd.ws.send(`<message to="${cd.jid}" from="${getMUCmember(roomName, displayName, accountId, resource)}" xmlns="jabber:client" type="groupchat"><body>${escapeXml(body)}</body></message>`);
          });
          return;
        }
        try {
          const bodyJSON = JSON.parse(body);
          if (Array.isArray(bodyJSON) || typeof bodyJSON.type !== 'string') return;
          // V1 (Mcp) party control messages (com.epicgames.party.*). Relay to ANOTHER named member if
          // `to` resolves to one; otherwise — addressed to self, the party MUC, or an unresolved jid —
          // echo it back to the sender (the proven LawinServer V1 behaviour). The old code required an
          // `id` AND a resolvable receiver, so a config update addressed to the party MUC was dropped
          // and party config never took ("Failed to update config for party").
          const msgId = msg.root.attributes.id || makeID().replace(/-/g, '').toUpperCase();
          const other = msgTo
            ? Clients.find(c => (c.jid.split('/')[0] === msgTo || c.jid === msgTo) && c.accountId !== accountId)
            : undefined;
          if (other) {
            other.ws.send(`<message from="${jid}" id="${msgId}" to="${other.jid}" xmlns="jabber:client"><body>${escapeXml(body)}</body></message>`);
          } else {
            ws.send(`<message from="${jid}" id="${msgId}" to="${jid}" xmlns="jabber:client"><body>${escapeXml(body)}</body></message>`);
          }
        } catch { }
        break;
      }
      case 'presence': {
        if (!clientExists) return;
        if (msg.root.attributes.type === 'unavailable') {
          const to = msg.root.attributes.to || '';
          if (to.includes(`@${MUC_DOMAIN}`) && to.toLowerCase().startsWith('party-')) {
            const roomName = to.split('@')[0];
            if (!MUCs[roomName]) return;
            const idx = MUCs[roomName].members.findIndex(m => m.accountId === accountId);
            if (idx !== -1) {
              MUCs[roomName].members.splice(idx, 1);
              // splice(-1, 1) would delete the LAST element — i.e. drop an unrelated room the
              // client is still in — so guard the indexOf miss explicitly.
              const ji = joinedMUCs.indexOf(roomName);
              if (ji !== -1) joinedMUCs.splice(ji, 1);
              if (MUCs[roomName].members.length === 0) delete MUCs[roomName]; // don't leak empty rooms
            }
            ws.send(
              `<presence to="${jid}" from="${getMUCmember(roomName, displayName, accountId, resource)}" xmlns="jabber:client" type="unavailable">` +
              `<x xmlns="http://jabber.org/protocol/muc#user"><item nick="${encodeURIComponent(displayName)}:${accountId}:${resource}" jid="${jid}" role="none"/>` +
              `<status code="110"/><status code="100"/><status code="170"/></x></presence>`
            );
            return;
          }
        }
        const hasMucX = msg.root.children.find((c: any) => c.name === 'muc:x' || c.name === 'x');
        if (hasMucX && msg.root.attributes.to) {
          const roomName = msg.root.attributes.to.split('@')[0];
          if (!MUCs[roomName]) MUCs[roomName] = { members: [] };
          if (MUCs[roomName].members.find(m => m.accountId === accountId)) return;
          MUCs[roomName].members.push({ accountId });
          joinedMUCs.push(roomName);
          ws.send(
            `<presence to="${jid}" from="${getMUCmember(roomName, displayName, accountId, resource)}" xmlns="jabber:client">` +
            `<x xmlns="http://jabber.org/protocol/muc#user"><item nick="${encodeURIComponent(displayName)}:${accountId}:${resource}" jid="${jid}" role="participant" affiliation="none"/>` +
            `<status code="110"/><status code="100"/><status code="170"/><status code="201"/></x></presence>`
          );
          MUCs[roomName].members.forEach(member => {
            const cd = Clients.find(c => c.accountId === member.accountId);
            if (!cd) return;
            ws.send(`<presence from="${getMUCmember(roomName, cd.displayName, cd.accountId, cd.resource)}" to="${jid}" xmlns="jabber:client"><x xmlns="http://jabber.org/protocol/muc#user"><item nick="${encodeURIComponent(cd.displayName)}:${cd.accountId}:${cd.resource}" jid="${cd.jid}" role="participant" affiliation="none"/></x></presence>`);
            if (cd.accountId !== accountId) {
              cd.ws.send(`<presence from="${getMUCmember(roomName, displayName, accountId, resource)}" to="${cd.jid}" xmlns="jabber:client"><x xmlns="http://jabber.org/protocol/muc#user"><item nick="${encodeURIComponent(displayName)}:${accountId}:${resource}" jid="${jid}" role="participant" affiliation="none"/></x></presence>`);
            }
          });
          return;
        }
        const statusChild = msg.root.children.find((c: any) => c.name === 'status');
        if (!statusChild?.content) return;
        try { JSON.parse(statusChild.content); } catch { return; }
        const clientEntry = Clients.find(c => c.accountId === accountId);
        if (clientEntry) {
          clientEntry.lastPresenceUpdate.status = statusChild.content;
          clientEntry.lastPresenceUpdate.away = !!msg.root.children.find((c: any) => c.name === 'show');
          // Push the updated status (e.g. "in lobby", "in match") out to the other players.
          try { broadcastPresence(accountId, 'available', statusChild.content); } catch { }
          // AND echo the presence back to THIS client. In the V1 (Mcp) party system the client
          // publishes its party + homebase into its OWN presence (party.joininfodata / FortBasicInfo_j
          // in the status JSON) and relies on receiving that presence back to validate its local
          // party-member/homebase record. Without this self-echo the client logs "Got bad homebase
          // data" every tick and PublishPartyInfoToPresence never settles, which then blocks party
          // config updates (SendToParty / "Failed to update config for party").
          const showTag = clientEntry.lastPresenceUpdate.away ? '<show>away</show>' : '';
          try {
            ws.send(
              `<presence from="${jid}" to="${jid}" xmlns="jabber:client" type="available">` +
              `${showTag}<status>${statusChild.content}</status></presence>`
            );
          } catch { }
        }
        break;
      }
    }

    // Register client after all fields are set
    if (!clientExists && !connectionClosed && accountId && displayName && token && jid && ID && resource && authenticated) {
      Clients.push({
        ws, accountId, displayName, jid, resource,
        authenticated: true, clientExists: true,
        lastPresenceUpdate: { away: false, status: '{}' },
        joinedMUCs, ID,
      });
      clientExists = true;
      console.log(`[XMPP] Client registered: ${displayName} (${accountId})`);

      // PRESENCE: announce this client online to everyone, and replay everyone already online back
      // to it — otherwise friends only ever appear offline (broadcastPresence was never called).
      try {
        broadcastPresence(accountId, 'available', '{}');
        for (const other of Clients) {
          if (other.accountId === accountId || !other.authenticated) continue;
          ws.send(`<presence from="${other.jid}" to="${jid}" xmlns="jabber:client" type="available"><status>${other.lastPresenceUpdate.status || '{}'}</status></presence>`);
        }
      } catch { }
    }
  });

  ws.on('close', () => {
    connectionClosed = true;
    clientExists = false;
    // Only announce offline if THIS socket is still the registered client. On a reconnect the stale
    // entry was already spliced out by dropExistingClient(), and `ws` waits up to 30s (closeTimeout)
    // before emitting 'close' on a dead peer — by which point the NEW session is live and
    // broadcastPresence() would resolve the from-JID to it, marking an online player offline for
    // every friend until their next presence tick.
    const wasRegistered = Clients.some(c => c.ws === ws);
    removeClient(ws, accountId, joinedMUCs);
    if (wasRegistered && accountId) { try { broadcastPresence(accountId, 'unavailable'); } catch { } }
  });
}

/**
 * Attach XMPP WebSocket to an existing HTTP/HTTPS server.
 * Cobalt redirects ALL traffic to port 3551, so XMPP WebSocket
 * upgrades arrive on that port, not a separate one.
 */
export function attachXmppWebSocket(server: http.Server, label: string): void {
  const wss = new WebSocketServer({
    noServer: true,
    // ECHO the 'xmpp' subprotocol so ws.protocol reflects an XMPP client. Without this, ws never
    // selects a subprotocol and ws.protocol is '' for everyone — which is why XMPP was misrouted to
    // the matchmaker. The MMS matchmaker offers no 'xmpp' subprotocol, so it gets `false` here and
    // stays '', still routing to the matchmaker. `protocols` is a Set (newer ws) or array (older).
    handleProtocols: (protocols: Set<string> | string[]) => {
      const list = Array.isArray(protocols) ? protocols : Array.from(protocols);
      return list.map(p => p.toLowerCase()).includes('xmpp') ? 'xmpp' : false;
    },
  });

  server.on('upgrade', (request: http.IncomingMessage, socket: any, head: Buffer) => {
    console.log(`[XMPP-WS] ${label} upgrade: url=${request.url} subprotocol="${request.headers['sec-websocket-protocol'] || ''}"`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, req) => handleXmppConnection(ws, req));
  console.log(`[XMPP-WS] WebSocket handler attached to ${label} server`);
}

/** Start standalone XMPP WebSocket server (LawinServer pattern).
 *  Port is configurable via NOVA_XMPP_PORT (default 80); disable entirely with
 *  NOVA_DISABLE_STANDALONE_XMPP=1. The primary XMPP WS is already attached to the HTTP
 *  server (3551), so this standalone listener is only a fallback — a listen failure
 *  (EACCES on privileged port 80 as a non-root user, or EADDRINUSE) must NOT crash the
 *  process. */
export function startXmppServer(): void {
  if (process.env.NOVA_DISABLE_STANDALONE_XMPP === '1') {
    console.log('[XMPP] Standalone server disabled (NOVA_DISABLE_STANDALONE_XMPP=1).');
    return;
  }
  const port = parseInt(process.env.NOVA_XMPP_PORT || '80', 10);
  const app = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/clients') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ amount: Clients.length, clients: Clients.map(c => c.displayName) }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const wss = new WebSocketServer({ server: app });
  wss.on('connection', (ws, req) => handleXmppConnection(ws, req));

  // The listen error must be handled on BOTH the http server AND the WebSocketServer —
  // otherwise `ws` re-emits it as an unhandled 'error' event and crashes the process.
  const onErr = (err: any) => {
    if (err && err.code === 'EADDRINUSE') console.warn(`[XMPP] Port ${port} in use — skipping standalone server.`);
    else if (err && err.code === 'EACCES') console.warn(`[XMPP] Port ${port} needs privilege (non-root) — skipping standalone server.`);
    else console.warn('[XMPP] Standalone server error — skipping:', err?.message || err);
  };
  wss.on('error', onErr);
  app.on('error', onErr);

  app.listen(port, Config.HOST, () => {
    console.log(`[XMPP] Standalone WebSocket server listening on ${Config.HOST}:${port}`);
  });
}

/** Pull the partyId out of a client's last presence status JSON — Properties["party.joininfo*"].partyId. */
function extractPartyId(statusJson?: string): string | null {
  if (!statusJson) return null;
  try {
    const props = JSON.parse(statusJson)?.Properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props)) {
        if (key.toLowerCase().startsWith('party.joininfo')) {
          const v = props[key];
          if (v && typeof v === 'object' && typeof v.partyId === 'string') return v.partyId;
        }
      }
    }
  } catch { }
  return null;
}

function removeClient(ws: WebSocket, accountId: string, joinedMUCs: string[]): void {
  const idx = Clients.findIndex(c => c.ws === ws);
  if (idx === -1) return;
  const client = Clients[idx];

  // Clean up MUC rooms
  for (const roomName of joinedMUCs) {
    if (MUCs[roomName]) {
      const mi = MUCs[roomName].members.findIndex(m => m.accountId === client.accountId);
      if (mi !== -1) MUCs[roomName].members.splice(mi, 1);
      if (MUCs[roomName].members.length === 0) delete MUCs[roomName]; // don't leak empty rooms
    }
  }

  // If this client was in a party, tell the other members it exited. Without this, an UNGRACEFUL
  // disconnect (crash / hard socket close, i.e. no clean party-leave over HTTP) leaves the player as
  // a "ghost" in everyone else's party UI, which can stall the party from re-matchmaking until an
  // unrelated timeout. Graceful leaves are already handled elsewhere; this covers the crash path.
  try {
    const partyId = extractPartyId(client.lastPresenceUpdate?.status);
    if (partyId) {
      const body = JSON.stringify({
        type: 'com.epicgames.party.memberexited',
        payload: { partyId, memberId: client.accountId, wasKicked: false },
        timestamp: new Date().toISOString(),
      });
      for (const other of Clients) {
        if (other.accountId === client.accountId || !other.authenticated) continue;
        try {
          other.ws.send(`<message id="${makeID().replace(/-/g, '').toUpperCase()}" from="${client.jid}" to="${other.jid}" xmlns="jabber:client"><body>${escapeXml(body)}</body></message>`);
        } catch { }
      }
    }
  } catch { }

  Clients.splice(idx, 1);
  console.log(`[XMPP] Client disconnected: ${client.displayName} (${client.accountId})`);
}

function handleMatchmaker(ws: WebSocket): void {
  console.log(`[Matchmaker] WebSocket client connected`);

  // This socket opening IS the in-game Play press, and it closing is the player leaving
  // matchmaking. Recording both is what lets the launcher start a gameserver on demand and shut it
  // down again, instead of running one for the launcher's entire lifetime.
  const waiterId = matchmakingStarted();

  // State machine: Connecting → Waiting → Queued → SessionAssignment → Play
  // The client only LEAVES the matchmaking screen (then fetches session info and connects to
  // the game server) when it receives the FINAL frame named "Play".
  // matchId/sessionId are minted ONCE so SessionAssignment and Play agree.
  const matchId = makeID();
  const sessionId = makeID();

  // ONE ticket id for the whole matchmaking session. Every StatusUpdate must repeat this exact
  // value: the client latches onto the first ticket it is given and rejects any later frame
  // carrying a different one with "HandleQueuedStatusUpdate - Ticket ID mismatch", which surfaces
  // as an UnknownError and dumps the player out of matchmaking. Minting a fresh id per keepalive
  // (as this used to) only looked fine because Play usually arrived before the first keepalive.
  const ticketId = 'nova-ticket-' + makeID();

  let done = false;

  const send = (obj: any) => { try { ws.send(JSON.stringify(obj)); } catch { } };

  // Intro UI frames (keep the client on the matchmaking screen). Kept short so that when a
  // server is already live we can send Play immediately after, in-order.
  setTimeout(() => send({ payload: { state: 'Connecting' }, name: 'StatusUpdate' }), 200);
  setTimeout(() => send({ payload: { state: 'Waiting', totalPlayers: 1, connectedPlayers: 1 }, name: 'StatusUpdate' }), 700);
  setTimeout(() => send({ payload: { state: 'Queued', ticketId, queuedPlayers: 0, estimatedWaitSec: 0, status: {} }, name: 'StatusUpdate' }), 1200);

  // The final "Play" frame is what actually sends the client into the match. Without it the
  // client sits on the matchmaking screen forever.
  const sendPlay = () => {
    if (done) return;
    done = true;
    send({ payload: { state: 'SessionAssignment', matchId }, name: 'StatusUpdate' });
    console.log(`[Matchmaker] Sent: SessionAssignment (matchId: ${matchId})`);
    setTimeout(() => {
      send({ payload: { matchId, sessionId, joinDelaySec: 1 }, name: 'Play' });
      console.log(`[Matchmaker] Sent: Play (matchId: ${matchId}, sessionId: ${sessionId})`);
    }, 800);
  };

  let poll: NodeJS.Timeout | undefined;

  if (Config.HOST_ELECTION) {
    // P2P mode: don't send Play until a live gameserver (the elected host's Reboot server) exists,
    // so joiners don't try to connect before it's up. Keep the client Queued while we wait.
    const startWait = Date.now();
    let ticks = 0;
    poll = setInterval(() => {
      if (done) { if (poll) clearInterval(poll); return; }
      ticks++;
      if (hasLiveGameServer()) {
        if (poll) clearInterval(poll);
        console.log(`[Matchmaker] Live gameserver detected — proceeding to Play`);
        sendPlay();
      } else if (Date.now() - startWait > Config.HOST_ELECTION_WAIT_MS) {
        if (poll) clearInterval(poll);
        console.log(`[Matchmaker] Timed out waiting for a gameserver — closing the socket so the client leaves matchmaking instead of hanging forever.`);
        // CRITICAL FIX: no host came up in time. Close the socket so the client shows a
        // matchmaking error and returns to the lobby, rather than spinning on the screen forever.
        try { ws.close(1013, 'no host available'); } catch { }
      } else if (ticks % 5 === 0) {
        // keepalive every ~10s so the client stays on the matchmaking screen during host boot
        send({ payload: { state: 'Queued', ticketId, queuedPlayers: 0, estimatedWaitSec: 15, status: {} }, name: 'StatusUpdate' });
      }
    }, 2000);
  } else {
    // Simple mode (single-PC / LAN / manual setups): fixed timing, unchanged behaviour.
    setTimeout(sendPlay, 5000);
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[Matchmaker] Client message:`, JSON.stringify(msg));
    } catch { }
  });

  ws.on('close', () => {
    if (poll) clearInterval(poll);
    matchmakingEnded(waiterId);
    console.log(`[Matchmaker] WebSocket client disconnected`);
  });
}

/** Send XMPP message to a specific account */
export function sendXmppMessage(toAccountId: string, body: string, type: string = 'chat'): void {
  const client = Clients.find(c => c.accountId === toAccountId);
  if (!client?.authenticated) return;
  try {
    client.ws.send(`<message to="${client.jid}" type="${type}" xmlns="jabber:client"><body>${escapeXml(body)}</body></message>`);
  } catch { }
}

/** Broadcast presence to all clients */
export function broadcastPresence(fromAccountId: string, presenceType: string = 'available', statusJson?: string): void {
  const fromClient = Clients.find(c => c.accountId === fromAccountId);
  const fromJid = fromClient?.jid || `${fromAccountId}@${XMPP_DOMAIN}`;

  for (const client of Clients) {
    // Deliberately NOT skipping the sender. On this build the party system publishes itself through
    // presence: FOnlinePartySystemMcp::PublishPartyInfoToPresence writes `party.joininfodata.<id>_j`
    // only if the client's OWN presence is already cached —
    //
    //     if (GetPresenceInterface()->GetCachedPresence(LocalUserId, Presence) == Success)
    //
    // and that cache is populated from presence the SERVER sends back. Skipping the sender meant the
    // client never cached its own presence, so publishing always failed, the party was never
    // advertised, and nobody (including the player) could see or join it. LawinServer — the working
    // V1 reference — relays presence to every client, sender included.
    if (!client.authenticated) continue;
    try {
      if (presenceType === 'unavailable') {
        client.ws.send(`<presence from="${fromJid}" to="${client.jid}" xmlns="jabber:client" type="unavailable"/>`);
      } else {
        const status = statusJson || '{}';
        client.ws.send(`<presence from="${fromJid}" to="${client.jid}" xmlns="jabber:client" type="available"><status>${status}</status></presence>`);
      }
    } catch { }
  }
}
