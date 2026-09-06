/**
 * Drive the real 7.40 session flow against a real backend and report what breaks.
 *
 * Not a test — a probe. It boots every route family the way index.ts does and replays the request
 * sequence VERSION_COMPATIBILITY.md §2 records the client actually making, in order, with a real
 * token from a real login. Tests assert what we already believe; this is for finding what we do not.
 *
 * Run: npx tsx e2e-probe.ts
 */
import os from 'node:os';
import path from 'node:path';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-e2e-${process.pid}.db`);

const UA = 'Fortnite/++Fortnite+Release-7.40-CL-5046157 Windows/10.0.17763.1.256.64bit';
/** basic base64("ec684b8c687f479fadea3cb2ad83f5c6:e1f31c211f28413186262d37a13fc84d") — the real PC client. */
const BASIC =
  'basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ=';

(async () => {
  const Fastify = (await import('fastify')).default;
  const formbody = (await import('@fastify/formbody')).default;
  const dbm = await import('./src/database');
  await dbm.initDatabase();

  const app = Fastify({
    // MIRRORS index.ts buildApp(). Getting these wrong makes the probe lie:
    // maxParamLength defaults to 100 in Fastify, and 7.40 puts a 365-char eg1~ token in the PATH,
    // so a probe without it reports a 404 that the real server does not produce.
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
    maxParamLength: 10000,
    ignoreTrailingSlash: true,
  });
  await app.register(formbody);
  const { versionRouter } = (await import('./src/middleware/version-router')) as any;
  app.addHook('onRequest', versionRouter);

  const families: [string, string][] = [
    ['auth', './src/services/auth/auth.routes'],
    ['mcp', './src/services/mcp/mcp.routes'],
    ['social', './src/services/social/social.routes'],
    ['cloudstorage', './src/services/cloudstorage/cloudstorage.routes'],
    ['storefront', './src/services/storefront/storefront.routes'],
    ['lightswitch', './src/services/lightswitch/lightswitch.routes'],
    ['matchmaking', './src/services/matchmaking/matchmaking.routes'],
    ['eos', './src/services/eos/eos.routes'],
  ];
  for (const [name, mod] of families) {
    try {
      const m: any = await import(mod);
      const fn = Object.values(m).find(
        (v) => typeof v === 'function' && /Routes$/.test((v as any).name),
      );
      if (fn) await app.register(fn as any);
      else console.log(`  (no *Routes export found in ${name})`);
    } catch (e: any) {
      console.log(`  FAILED to register ${name}: ${e?.message}`);
    }
  }
  await app.ready();

  let token = '';
  let account = '';
  const results: string[] = [];

  const step = async (label: string, opts: any, check?: (r: any) => string | null) => {
    const res = await app.inject({
      ...opts,
      headers: { 'user-agent': UA, ...(opts.headers || {}) },
    });
    let note = '';
    if (check) {
      try {
        note = check(res) || '';
      } catch (e: any) {
        note = `check threw: ${e.message}`;
      }
    }
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    results.push(`${ok ? ' ' : 'x'} ${String(res.statusCode).padEnd(3)} ${label.padEnd(50)} ${note}`);
    return res;
  };

  await step(
    'POST /account/api/oauth/token (password)',
    {
      method: 'POST',
      url: '/account/api/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: BASIC },
      payload: 'grant_type=password&username=e2e&password=x',
    },
    (r) => {
      const b = r.json();
      token = b.access_token;
      account = b.account_id;
      return token ? '' : 'NO TOKEN RETURNED';
    },
  );

  const A = () => ({ authorization: `bearer ${token}` });
  const J = () => ({ ...A(), 'content-type': 'application/json' });

  await step('GET  /account/api/oauth/verify', { method: 'GET', url: '/account/api/oauth/verify', headers: A() });
  await step('GET  /account/api/public/account', { method: 'GET', url: '/account/api/public/account', headers: A() });

  await step(
    'GET  /lightswitch/api/service/bulk/status',
    { method: 'GET', url: '/lightswitch/api/service/bulk/status', headers: A() },
    (r) => {
      const b = r.json();
      return Array.isArray(b) && b[0]?.status === 'UP' ? '' : 'NOT UP';
    },
  );

  await step('GET  /fortnite/api/v2/versioncheck/Windows', { method: 'GET', url: '/fortnite/api/v2/versioncheck/Windows', headers: A() });

  await step(
    'GET  /fortnite/api/cloudstorage/system',
    { method: 'GET', url: '/fortnite/api/cloudstorage/system', headers: A() },
    (r) => {
      const b = r.json();
      return Array.isArray(b) ? `${b.length} hotfix files` : 'NOT AN ARRAY';
    },
  );

  await step('GET  /content/api/pages/fortnite-game', { method: 'GET', url: '/content/api/pages/fortnite-game', headers: A() });

  await step(
    'GET  /fortnite/api/calendar/v1/timeline',
    { method: 'GET', url: '/fortnite/api/calendar/v1/timeline', headers: A() },
    (r) => {
      const s = r.json()?.channels?.['client-events']?.states?.[0]?.state?.seasonNumber;
      return s === 7 ? '' : `seasonNumber=${s} (expected 7)`;
    },
  );

  await step('GET  /fortnite/api/game/v2/enabled_features', { method: 'GET', url: '/fortnite/api/game/v2/enabled_features', headers: A() });

  await step(
    'GET  /fortnite/api/storefront/v2/keychain',
    { method: 'GET', url: '/fortnite/api/storefront/v2/keychain', headers: A() },
    (r) => {
      const b = r.json();
      return Array.isArray(b) ? `${b.length} keys` : 'NOT AN ARRAY';
    },
  );

  await step('GET  /fortnite/api/storefront/v2/catalog', { method: 'GET', url: '/fortnite/api/storefront/v2/catalog', headers: A() });

  await step(
    'POST MCP QueryProfile (athena)',
    {
      method: 'POST',
      url: `/fortnite/api/game/v2/profile/${account}/client/QueryProfile?profileId=athena&rvn=-1`,
      headers: J(),
      payload: {},
    },
    (r) => {
      const c = r.json().profileChanges?.[0];
      return c?.profile ? `${Object.keys(c.profile.items).length} items` : 'NO fullProfileUpdate';
    },
  );

  await step('POST MCP QueryProfile (common_core)', {
    method: 'POST',
    url: `/fortnite/api/game/v2/profile/${account}/client/QueryProfile?profileId=common_core&rvn=-1`,
    headers: J(),
    payload: {},
  });

  await step(
    'POST MCP ClientQuestLogin (athena)',
    {
      method: 'POST',
      url: `/fortnite/api/game/v2/profile/${account}/client/ClientQuestLogin?profileId=athena&rvn=-1`,
      headers: J(),
      payload: {},
    },
    (r) => {
      const c = r.json().profileChanges?.[0];
      if (!c?.profile) return '';
      const quests = Object.keys(c.profile.items).filter((k) => /Quest|Challenge/i.test(k));
      return `${quests.length} quest items`;
    },
  );

  await step(
    'POST MCP EquipBattleRoyaleCustomization',
    {
      method: 'POST',
      url: `/fortnite/api/game/v2/profile/${account}/client/EquipBattleRoyaleCustomization?profileId=athena&rvn=1`,
      headers: J(),
      payload: { slotName: 'Character', itemToSlot: 'AthenaCharacter:CID_002_Athena_Commando_F_Default', indexWithinSlot: -1, variantUpdates: [] },
    },
    (r) => {
      const ch = r.json().profileChanges;
      return Array.isArray(ch) && ch.length ? '' : 'NO CHANGES EMITTED';
    },
  );

  await step('GET  /friends/api/public/friends/{acct}', { method: 'GET', url: `/friends/api/public/friends/${account}`, headers: A() });
  await step('GET  /friends/api/v1/{acct}/settings', { method: 'GET', url: `/friends/api/v1/${account}/settings`, headers: A() });
  await step('GET  /friends/api/public/blocklist/{acct}', { method: 'GET', url: `/friends/api/public/blocklist/${account}`, headers: A() });

  await step('GET  chat/reserveGeneralChatRooms', {
    method: 'GET',
    url: `/fortnite/api/game/v2/chat/${account}/reserveGeneralChatRooms/Athena/pc`,
    headers: A(),
  });

  await step('GET  matchmaking ticket (player)', {
    method: 'GET',
    url: `/fortnite/api/game/v2/matchmakingservice/ticket/player/${account}?bucketId=Windows:1:1:1&partyPlayerIds=${account}`,
    headers: A(),
  });

  await step('POST /datarouter/api/v1/public/data', {
    method: 'POST',
    url: '/datarouter/api/v1/public/data?SessionID=x&AppID=y',
    headers: J(),
    payload: { Events: [] },
  });

  await step('DELETE oauth/sessions/kill/{token}', {
    method: 'DELETE',
    url: `/account/api/oauth/sessions/kill/${token}`,
    headers: A(),
  });

  console.log('\n──── 7.40 SESSION FLOW ────');
  for (const r of results) console.log(r);
  const bad = results.filter((r) => r.startsWith('x'));
  console.log(`\n${results.length - bad.length}/${results.length} returned 2xx`);
  if (bad.length) {
    console.log('\nNON-2xx:');
    for (const b of bad) console.log('  ' + b);
  }
  process.exit(0);
})();
