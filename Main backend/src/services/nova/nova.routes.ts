import { FastifyInstance } from 'fastify';
import { getLogs, clearLogs, ingestLogs, getComponentStatuses } from './logStore';
import { getNews } from './news';
import { getLeaderboard, getAccount, getAccountIdByDisplayName } from '../../database';
import { getEquippedCharacterId, getEquippedCosmetics } from '../mcp/profiles/athena';
import { noteServerOutput } from '../matchmaking/hostRunner';
import { Config } from '../../config';

const START_TIME = Date.now();

/**
 * Project Nova extra endpoints — launcher-facing helpers (logs, news, server info,
 * leaderboards) plus the plain /fortnite/api/version the client polls at startup.
 */
export async function novaRoutes(fastify: FastifyInstance): Promise<void> {
  // Live backend log stream for the launcher's log viewer.
  fastify.get('/nova/api/logs', async (request, reply) => {
    const limit = parseInt((request.query as any)?.limit || '250', 10);
    return reply.send({ logs: getLogs(isNaN(limit) ? 250 : limit), statuses: getComponentStatuses() });
  });

  /**
   * POST /nova/api/logs/ingest — log sink for Nova components that run in ANOTHER process.
   *
   * Cobalt lives inside the Fortnite client and used to AllocConsole() a second console window to
   * print to. It now batches its lines here instead, so everything shows up in the launcher's Logs
   * tab next to the backend's own output, tagged with its source.
   *
   * Unauthenticated on purpose: the game process holds no user token, and this is reachable only
   * from the local machine. logStore bounds everything it accepts (known sources only, capped batch
   * size, truncated messages) so it cannot be used to exhaust memory.
   */
  fastify.post('/nova/api/logs/ingest', async (request, reply) => {
    const body = (request.body || {}) as any;
    const entries = body.entries || [];
    const accepted = ingestLogs(body.source, entries, body.status);

    // This stream is also how we learn the gameserver has finished starting. Its output arrives here
    // because Cobalt forwards it, and one of those lines is the server announcing that its lobby is
    // open — a far better signal than assuming it was ready the moment the DLL loaded.
    if (Array.isArray(entries)) {
      for (const e of entries) {
        const msg = typeof e === 'string' ? e : e?.msg;
        if (typeof msg === 'string') noteServerOutput(msg);
      }
    }
    return reply.send({ accepted });
  });

  /** Current status line per component, so the launcher can show what is running. */
  fastify.get('/nova/api/components', async (_request, reply) => {
    return reply.send({ components: getComponentStatuses() });
  });

  fastify.delete('/nova/api/logs', async (_request, reply) => {
    clearLogs();
    return reply.send({ ok: true });
  });

  // Editable news feed (data/news.json).
  fastify.get('/nova/api/news', async (_request, reply) => {
    return reply.send({ news: getNews() });
  });

  // Server info card for the launcher.
  fastify.get('/nova/api/info', async (_request, reply) => {
    return reply.send({
      name: 'Project Nova',
      season: Config.SEASON_NUMBER,
      chapter: Config.CHAPTER_NUMBER,
      build: '7.40',
      version: '4.12.0-2870186',
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      startedAt: new Date(START_TIME).toISOString(),
    });
  });

  // Simple leaderboard (default: wins). ?stat=br_placetop1_...&limit=100
  fastify.get('/nova/api/leaderboard', async (request, reply) => {
    const q = request.query as any;
    const stat = q?.stat || 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo';
    const limit = Math.min(parseInt(q?.limit || '50', 10) || 50, 200);
    const rows = getLeaderboard(stat, limit).map((r, i) => ({
      rank: i + 1,
      accountId: r.accountId,
      displayName: getAccount(r.accountId)?.display_name || 'Player',
      value: r.value,
    }));
    return reply.send({ stat, entries: rows });
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  LOCKER LOOKUP FOR THE GAMESERVER
  //  A private gameserver cannot resolve a player's cosmetics itself: the game's own
  //  AFortPlayerController::GetAthenaLoadoutWithOverrides() needs the player's AthenaProfile
  //  downloaded server-side, which never happens here, so CustomizationLoadout.Character stays
  //  null and Reboot falls back to a RANDOM skin. The Reboot DLL therefore asks us instead,
  //  keyed on the display name it reads out of the joining client's connect URL.
  //
  //  Plain text out, not JSON — the DLL has no parser on this path and one bare CID name
  //  ("CID_386_Athena_Commando_M_StreetOpsStealth") is all it needs to match against the
  //  AthenaCharacterItemDefinition objects already loaded in the game process.
  //  Empty body = "unknown player", which the DLL treats as "leave cosmetics alone".
  fastify.get('/nova/api/locker/character', async (request, reply) => {
    const name = String((request.query as any)?.name || '').trim();
    reply.type('text/plain; charset=utf-8');
    if (!name) return reply.send('');

    const accountId = getAccountIdByDisplayName(name);
    if (!accountId) return reply.send('');

    // Resolves both storage formats (templateId for untouched defaults, item GUID once the player
    // has equipped something) and always yields a real character, so someone who has never opened
    // the locker still gets the season default rather than a random skin.
    return reply.send(getEquippedCharacterId(accountId));
  });

  // FULL loadout for the gameserver: character + backpack + pickaxe + glider + contrail.
  // Plain-text `key=value` lines (the DLL parses without a JSON library). Empty value = that slot
  // has nothing to apply. Same display-name keying as the character endpoint, so it works for any
  // player in the match, not just the host.
  fastify.get('/nova/api/locker/loadout', async (request, reply) => {
    const name = String((request.query as any)?.name || '').trim();
    reply.type('text/plain; charset=utf-8');
    if (!name) return reply.send('');

    const accountId = getAccountIdByDisplayName(name);
    if (!accountId) return reply.send('');

    const c = getEquippedCosmetics(accountId);
    const body = Object.entries(c).map(([k, v]) => `${k}=${v}`).join('\n');
    return reply.send(body);
  });

  // Plain version endpoint (the reference serves this; Nova only had versioncheck).
  fastify.get('/fortnite/api/version', async (_request, reply) => {
    return reply.send({
      app: 'fortnite',
      serverDate: new Date().toISOString(),
      overridePropertiesVersion: 'unknown',
      cln: '5046157',
      build: '444',
      moduleName: 'Fortnite-Core',
      buildDate: '2019-02-14T00:00:00.000Z',
      version: '7.40',
      branch: 'Release-7.40',
      modules: {},
    });
  });
}
