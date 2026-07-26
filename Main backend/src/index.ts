import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import fs from 'fs';
import path from 'path';
import { Config } from './config';
import { initDatabase } from './database';
import { authMiddleware } from './middleware/auth.middleware';
import { versionRouter } from './middleware/version-router';
import { authRoutes } from './services/auth/auth.routes';
import { launcherAuthRoutes } from './services/auth/launcher.routes';
import { mcpRoutes } from './services/mcp/mcp.routes';
import { lightswitchRoutes } from './services/lightswitch/lightswitch.routes';
import { storefrontRoutes } from './services/storefront/storefront.routes';
import { cloudstorageRoutes } from './services/cloudstorage/cloudstorage.routes';
import { matchmakingRoutes } from './services/matchmaking/matchmaking.routes';
import { socialRoutes } from './services/social/social.routes';
import { entitlementRoutes } from './services/entitlement/entitlement.routes';
import { statsRoutes } from './services/stats/stats.routes';
import { eosRoutes } from './services/eos/eos.routes';
import { startXmppServer, attachXmppWebSocket } from './services/xmpp/xmpp.server';
import { novaRoutes } from './services/nova/nova.routes';
import { anticheatRoutes } from './services/anticheat/anticheat.routes';
import { compatRoutes } from './services/compat/compat.routes';
import { installLogCapture } from './services/nova/logStore';

// Capture console output into a ring buffer so the launcher can stream live logs.
installLogCapture();

const AGENT_MODE_LABEL = process.env.NOVA_COORDINATOR
  ? `host-agent -> ${process.env.NOVA_COORDINATOR}`
  : 'standalone';

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       PROJECT NOVA — OGFN Backend        ║');
  console.log('║    Chapter 1 Season 7/8 Emulator         ║');
  console.log('║      Full EOS Translation Layer          ║');
  console.log('╚══════════════════════════════════════════╝');
  // Identify the build in the log itself.
  //
  // Every log shared for diagnosis so far has been silent about which launcher produced it, which
  // has meant repeatedly guessing whether a reported failure came from a build containing the
  // relevant fix. A log that cannot identify its own version wastes a round trip every time.
  console.log(`[Version] launcher ${process.env.NOVA_LAUNCHER_VERSION || '(unknown — started outside the launcher)'} · agent ${AGENT_MODE_LABEL}`);

  // Initialize directories and database
  Config.init();
  await initDatabase();

  // Load TLS certs if available
  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;
  const keyPath = path.join(Config.CERTS_DIR, 'server.key');
  const certPath = path.join(Config.CERTS_DIR, 'server.cert');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    console.log('[TLS] Self-signed certificates loaded.');
  } else {
    console.warn('[TLS] No certificates found. Run `npm run generate-certs` first.');
    console.warn('[TLS] Starting in HTTP-only mode on port', Config.HTTP_PORT);
  }

  async function buildApp(httpsOpts?: { key: Buffer; cert: Buffer }) {
    const app = Fastify({
      logger: false,
      ...(httpsOpts ? { https: httpsOpts } : {}),
      bodyLimit: 10 * 1024 * 1024, // 10MB
      trustProxy: true,
      maxParamLength: 10000,
      // The client sends several endpoints with a trailing slash (e.g.
      // /launcher/api/public/distributionpoints/). Express-based backends normalise these for free;
      // Fastify does not, so without this they fall through to the not-found handler and the client
      // gets {} where it expects a real payload.
      ignoreTrailingSlash: true,
    });

    // Fix Fastify's FST_ERR_CTP_EMPTY_JSON_BODY
    app.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
      try {
        if (!body || body === '') return done(null, {});
        const json = JSON.parse(body as string);
        done(null, json);
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    });

    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, function (req, body, done) {
      done(null, body);
    });

    app.addContentTypeParser('*', { parseAs: 'buffer' }, function (req, body, done) {
      done(null, body);
    });

    await app.register(cors, { origin: true, credentials: true });
    await app.register(formbody);
    app.addHook('onRequest', versionRouter);

    // Global request logger
    app.addHook('onRequest', async (request, reply) => {
      console.log(`[HTTP] ${request.method} ${request.url}`);
    });

    // Register all route modules
    await app.register(authRoutes);
    await app.register(launcherAuthRoutes);
    await app.register(mcpRoutes);
    await app.register(lightswitchRoutes);
    await app.register(storefrontRoutes);
    await app.register(cloudstorageRoutes);
    await app.register(matchmakingRoutes);
    await app.register(socialRoutes);
    await app.register(entitlementRoutes);
    await app.register(statsRoutes);
    await app.register(eosRoutes);
    await app.register(novaRoutes);
    await app.register(anticheatRoutes);
    await app.register(compatRoutes);

    // Not-found handler — return proper empty responses
    app.setNotFoundHandler(async (request, reply) => {
      console.log(`[UNHANDLED] ${request.method} ${request.url}`);
      if (request.method === 'GET') return reply.send({});
      return reply.status(204).send();
    });

    app.setErrorHandler((error, request, reply) => {
      // Respect an intended status code (e.g. 400/404) instead of masking everything as 500,
      // and don't leak internal error text on real server errors.
      const sc = (error as any).statusCode;
      const status = typeof sc === 'number' && sc >= 400 ? sc : 500;
      console.error(`[ERROR ${status}] ${request.method} ${request.url}:`, error.message);
      reply.status(status).send({
        errorCode: status < 500 ? 'errors.com.epicgames.common.bad_request' : 'errors.com.epicgames.common.server_error',
        errorMessage: status < 500 ? (error.message || 'Bad request') : 'Internal server error',
        messageVars: [],
        numericErrorCode: 1000,
        originatingService: 'nova-backend',
        intent: 'prod',
      });
    });

    return app;
  }

  // Start HTTP server
  let httpServer: any = null;
  try {
    const httpApp = await buildApp();
    await httpApp.listen({ host: Config.HOST, port: Config.HTTP_PORT });
    httpServer = httpApp.server;
    console.log(`\n[Server] Nova Backend (HTTP) running on http://${Config.HOST}:${Config.HTTP_PORT}`);
  } catch (err) {
    console.error('[Server] Failed to start HTTP:', err);
  }

  // Start HTTPS server
  if (httpsOptions) {
    try {
      const httpsApp = await buildApp(httpsOptions);
      await httpsApp.listen({ host: Config.HOST, port: Config.HTTPS_PORT });
      const httpsServer = httpsApp.server;
      console.log(`[Server] Nova Backend (HTTPS) running on https://${Config.HOST}:${Config.HTTPS_PORT}`);
      // Attach XMPP WebSocket to HTTPS too
      attachXmppWebSocket(httpsServer, 'HTTPS');
    } catch (err) {
      console.error('[Server] Failed to start HTTPS on port 443:', err);
    }
  }

  console.log('[Server] Target: Chapter 1 Season', Config.SEASON_NUMBER);
  console.log('[Server] All cosmetics: UNLOCKED');
  console.log('[Server] V-Bucks: 999,999');
  console.log('[Server] Waiting for game client connections...\n');

  // Attach XMPP WebSocket to the HTTP server (port 3551)
  // Cobalt redirects ALL traffic (incl XMPP WebSocket) to 127.0.0.1:3551
  if (httpServer) attachXmppWebSocket(httpServer, 'HTTP');

  // Also start standalone XMPP on port 80 as fallback
  startXmppServer();
}

main().catch(console.error);
