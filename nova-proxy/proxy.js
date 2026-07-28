// ═══════════════════════════════════════════════════════════════════════════
//  Nova local proxy
//  Cobalt redirects the game to http://127.0.0.1:3551 (hard-coded). This tiny proxy
//  listens there and forwards everything — HTTP API, XMPP and the MMS matchmaker
//  WebSocket — up to the shared global coordinator (over TLS), so every player using
//  their own machine ends up on the SAME backend without touching Cobalt.
//
//  Two things must NOT go to the coordinator, and are sent to the local host agent instead:
//
//    /nova/api/host/*   Host control. The coordinator decides WHO hosts, but the server process runs
//                       HERE — the coordinator is a Linux box and cannot run Fortnite. Forwarding the
//                       launcher's host config upstream (which is what used to happen, because the
//                       launcher and the game share this one address) handed a Windows exe path to
//                       Linux, where it could only ever fail, while the machine that could actually
//                       host was never told anything at all.
//
//    /nova/api/logs*    This machine's logs, incl. what Cobalt posts from inside the game. Sending
//                       them upstream would leave the launcher's Logs tab showing the SERVER's logs
//                       and none of the player's own.
//
//  Env:
//    NOVA_PROXY_PORT   local port to listen on   (default 3551)
//    NOVA_PROXY_HOST   local bind address        (default 127.0.0.1)
//    NOVA_COORDINATOR  upstream coordinator URL  (default the Tailscale Funnel URL)
//    NOVA_LOCAL_AGENT  local host agent URL      (default http://127.0.0.1:3552)
// ═══════════════════════════════════════════════════════════════════════════
const http = require('http');
const httpProxy = require('http-proxy');
const { Readable, PassThrough } = require('stream');

const PORT = parseInt(process.env.NOVA_PROXY_PORT || '3551', 10);
const HOST = process.env.NOVA_PROXY_HOST || '127.0.0.1';
const TARGET = process.env.NOVA_COORDINATOR || 'https://clientfinder.tail0a8fd0.ts.net:8443';
const AGENT = process.env.NOVA_LOCAL_AGENT || 'http://127.0.0.1:3552';

/** Paths served by the local host agent rather than the coordinator (see the header). */
const LOCAL_PREFIXES = ['/nova/api/host/', '/nova/api/logs', '/nova/api/components'];

function isLocal(url) {
  const path = (url || '/').split('?')[0].toLowerCase();
  // should-i-serve is the coordinator's answer TO the agent, not a local endpoint. The agent asks the
  // coordinator directly, but keep it upstream here too so it can never be short-circuited to us.
  if (path === '/nova/api/host/should-i-serve') return false;
  return LOCAL_PREFIXES.some((p) => path === p || path.startsWith(p));
}

const toCoordinator = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true, // rewrite Host to the coordinator so Tailscale Funnel routes correctly
  secure: true,       // verify the coordinator's (valid) TLS cert
  ws: true,           // proxy WebSocket upgrades (XMPP + MMS matchmaker) too
  xfwd: false,
  proxyTimeout: 30000,
});

const toAgent = httpProxy.createProxyServer({
  target: AGENT,
  changeOrigin: false,
  ws: false,
  xfwd: false,
  proxyTimeout: 15000,
});

function fail(label, err, req, res) {
  const where = req && req.url ? req.url : '(ws)';
  console.error(`[nova-proxy] ${label} error for ${where}: ${err.message}`);
  try {
    if (res && res.writeHead && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `nova-proxy ${label} error`, detail: err.message }));
    } else if (res && res.destroy) {
      res.destroy();
    }
  } catch { /* ignore */ }
}

toCoordinator.on('error', (err, req, res) => fail('upstream', err, req, res));
toAgent.on('error', (err, req, res) => fail('local agent', err, req, res));

/* ── Retrying a connection that never landed ─────────────────────────────────────────────────────
   A single transient hiccup on the way to the coordinator used to end the player's session. The
   game saw:

     HTTP 502 {"error":"nova-proxy upstream error",
               "detail":"Client network socket disconnected before secure TLS connection was established"}

   and turned it into "Login Failed — Profile Query Failed", because QueryProfile is not optional:
   fail it once during sign-in and the client gives up entirely.

   That specific error is worth reading carefully. The socket died BEFORE the TLS handshake finished,
   which means the request was never delivered — the coordinator never saw it, never parsed it, never
   ran it. So replaying it cannot double-apply anything, even though these are POSTs. That is what
   makes retrying safe here, and it is the only reason a blanket POST retry is defensible: we retry
   exclusively on connection-level failures raised before any response byte arrived.

   Not retried: anything the coordinator actually answered (it made a decision — respect it), and
   anything that failed after we had already begun writing a response to the game. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [120, 400];
/** Bodies above this are streamed straight through without buffering, so they cannot be replayed. */
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_STREAM_PREMATURE_CLOSE',
]);

function isRetryable(err) {
  if (!err) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  // Node raises the mid-handshake reset with no useful code — only this message.
  return /socket disconnected before secure TLS connection/i.test(err.message || '');
}

function sendUpstream(req, res, body, attempt) {
  // `buffer` makes http-proxy pipe THIS instead of `req` — which is what allows a replay at all,
  // since `req` itself has already been consumed by the time the first attempt fails.
  const opts = body === null ? {} : { buffer: Readable.from(body.length ? [body] : []) };
  toCoordinator.web(req, res, opts, (err) => {
    if (!err) return;
    const canRetry = attempt < MAX_ATTEMPTS && body !== null && isRetryable(err) && !res.headersSent;
    if (canRetry) {
      const delay = RETRY_DELAYS_MS[attempt - 1] || 400;
      console.warn(`[nova-proxy] upstream ${err.code || 'reset'} for ${req.url} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      setTimeout(() => sendUpstream(req, res, body, attempt + 1), delay);
      return;
    }
    fail('upstream', err, req, res);
  });
}

const server = http.createServer((req, res) => {
  if (isLocal(req.url)) {
    toAgent.web(req, res);
    return;
  }
  // Buffer the body so a failed attempt can be replayed. These are small JSON payloads.
  //
  // Anything large is forwarded as a plain stream and simply isn't retried — but it MUST still be
  // forwarded intact. Discarding buffered chunks and falling back to piping `req` would silently
  // truncate the body, because by then `req` has already been read.
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_REPLAY_BYTES) {
    sendUpstream(req, res, null, MAX_ATTEMPTS); // stream through, no replay
    return;
  }

  const chunks = [];
  let size = 0;
  let overflow = null; // a PassThrough carrying everything, once we know we can't replay
  req.on('data', (c) => {
    if (overflow) return; // already piping straight through
    size += c.length;
    chunks.push(c);
    if (size > MAX_REPLAY_BYTES) {
      // Chunked body with no content-length that turned out to be huge. Replay what we've read into
      // a passthrough and let the rest flow into it, so the upstream still receives every byte.
      overflow = new PassThrough();
      for (const b of chunks) overflow.write(b);
      chunks.length = 0;
      req.pipe(overflow);
      toCoordinator.web(req, res, { buffer: overflow }, (err) => { if (err) fail('upstream', err, req, res); });
    }
  });
  req.on('end', () => { if (!overflow) sendUpstream(req, res, Buffer.concat(chunks), 1); });
  req.on('error', (err) => fail('upstream', err, req, res));
});

// WebSocket upgrades (the XMPP socket + the MMS matchmaker socket both arrive here). These are the
// game talking to the shared world, so they always go upstream — the local agent serves no clients.
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { /* swallow abrupt client disconnects */ });
  toCoordinator.ws(req, socket, head);
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

// A failure to take the port is the single most damaging thing that can happen here, and it used to
// happen silently: the process died, something else kept answering on 3551, and the game carried on
// talking to a backend that knew nothing about anyone else — no shared matchmaking, no hosting, no
// obvious symptom. Say so loudly and exit with a code the launcher can recognise.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[nova-proxy] FATAL: ${HOST}:${PORT} is already in use.`);
    console.error('[nova-proxy] Something else — most likely a standalone Nova backend — is holding');
    console.error('[nova-proxy] the port the game connects to. Stop it and launch again, or turn off');
    console.error('[nova-proxy] P2P mode in the launcher to play on that local backend instead.');
    process.exit(3);
  }
  console.error(`[nova-proxy] FATAL: could not listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[nova-proxy] listening on http://${HOST}:${PORT}  (HTTP + WebSocket)`);
  console.log(`[nova-proxy]   game + shared world  ->  ${TARGET}`);
  console.log(`[nova-proxy]   host control + logs  ->  ${AGENT}`);
});

process.on('SIGINT', () => { console.log('[nova-proxy] shutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
