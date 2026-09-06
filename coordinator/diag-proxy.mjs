#!/usr/bin/env node
/**
 * A path allowlist in front of the Nova backend, so the diagnostics dashboard can be public without
 * the rest of the backend being public with it.
 *
 * ── WHY THIS EXISTS RATHER THAN TUNNELLING 3551 DIRECTLY ─────────────────────────────────────────
 *
 * `cloudflared tunnel --url http://127.0.0.1:3551` is a blind proxy: it would publish EVERY route
 * the backend serves. That includes `POST /nova/api/gameserver/register`, whose gate is
 * `if (Config.REGISTER_SECRET && ...)` with the secret deliberately left unset — see
 * `gameserver-register-unauthenticated` in KNOWN_ISSUES. It is accepted-open only because the
 * backend binds loopback and nothing fronts it; that endpoint decides the address every player is
 * routed to, so publishing it would convert an accepted local risk into a remote one.
 *
 * It also publishes the MCP profile routes, the auth routes, and the whole EOS translation layer.
 * None of that is what "put the dashboard online" asked for.
 *
 * So: forward exactly the three read-only admin views and refuse everything else. The backend's own
 * admin gate still applies on top — this proxy adds no authentication and removes none. Two
 * independent things now have to be true for a request to reach data: the path is on this list, and
 * the caller has the admin secret.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────────
 *
 * No auth of its own. Putting a second secret here would mean two places to rotate and a false sense
 * that the proxy is the security boundary. It is not; `adminOk()` in diagnostics.routes.ts is.
 *
 * USAGE
 *   node diag-proxy.mjs            # listens on 127.0.0.1:3560, forwards to 127.0.0.1:3551
 *   PORT=3560 UPSTREAM=3551 node diag-proxy.mjs
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 3560);
const UPSTREAM = Number(process.env.UPSTREAM || 3551);

/**
 * Exactly what may cross. All read-only, all already behind the backend's admin gate.
 *
 * `/nova/api/incidents/<id>` is the one parameterised entry; it is matched with a strict pattern
 * rather than a prefix, because a prefix match on `/nova/api/incidents` would also admit anything
 * someone later hangs off that path.
 */
const EXACT = new Set([
  '/nova/api/dashboard',
  '/nova/api/diagnostics',
  '/nova/api/incidents',
  // The live SSE tail. Omitted from the first version of this list, which is why the dashboard's
  // stream 404ed through the tunnel while working perfectly on the box — the allowlist did its job
  // and blocked a path nobody had told it about. Adding a route to the backend is not enough; it
  // has to be added here too, and that is the intended friction.
  '/nova/api/diagnostics/stream',
  // The SSE fallback. Cloudflare's free tunnel buffers event streams to nothing, so the dashboard
  // reads the same events by sequence number instead when the stream stays silent.
  '/nova/api/diagnostics/since',
]);
const INCIDENT_ID = /^\/nova\/api\/incidents\/[A-Za-z0-9_-]{1,64}$/;

const allowed = (pathname) => EXACT.has(pathname) || INCIDENT_ID.test(pathname);

const server = http.createServer((req, res) => {
  // GET/HEAD only. Every allowed route is a read; accepting POST here would let a request body
  // through to a route that never expects one.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' });
    return res.end(JSON.stringify({ error: 'method not allowed' }));
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'bad request' }));
  }

  if (!allowed(pathname)) {
    // 404 rather than 403: there is nothing here, and saying "forbidden" would confirm the backend
    // serves that path to anyone probing the tunnel.
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: UPSTREAM,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      // pipe() streams, which is what an event stream needs — nothing here waits for the response
      // to end. Buffering the body would turn the live tail into a connection that delivers
      // everything at once when it finally closes, i.e. never.
      up.pipe(res);
    },
  );

  upstream.on('error', (e) => {
    // The backend being down must not take the proxy down with it.
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'backend unavailable', detail: String(e.message || e) }));
  });

  req.pipe(upstream);
});

// Loopback only. cloudflared runs on this machine and connects here; nothing else should be able to.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[diag-proxy] 127.0.0.1:${PORT} -> 127.0.0.1:${UPSTREAM}`);
  console.log(`[diag-proxy] allowing: ${[...EXACT].join(', ')}, /nova/api/incidents/<id>`);
  console.log('[diag-proxy] everything else: 404. The backend admin secret is still required.');
});
