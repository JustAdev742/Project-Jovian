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

function onError(label) {
  return (err, req, res) => {
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
  };
}

toCoordinator.on('error', onError('upstream'));
toAgent.on('error', onError('local agent'));

const server = http.createServer((req, res) => {
  if (isLocal(req.url)) {
    toAgent.web(req, res);
  } else {
    toCoordinator.web(req, res);
  }
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
