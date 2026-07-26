import { FastifyInstance } from 'fastify';
import { generateUUID } from '../../utils/uuid';
import { getFriends, addFriend, acceptFriend, removeFriend, blockUser, getAccount, logTelemetry } from '../../database';
import { Config } from '../../config';

/** Friends, Party, Social, and miscellaneous gameplay routes */
export async function socialRoutes(fastify: FastifyInstance): Promise<void> {

  // ═══════════════════════════════════════════════
  //  FRIENDS SERVICE (DB-backed)
  // ═══════════════════════════════════════════════

  /** Friends summary — returns categorized friend lists */
  fastify.get('/friends/api/v1/:accountId/summary', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const allFriends = getFriends(accountId);

    const friends = allFriends.filter(f => f.status === 'accepted').map(f => ({
      accountId: f.friend_id,
      groups: [],
      mutual: 0,
      alias: '',
      note: '',
      favorite: false,
      created: f.created_at,
    }));

    const incoming = allFriends.filter(f => f.status === 'pending' && f.direction === 'incoming').map(f => ({
      accountId: f.friend_id,
      created: f.created_at,
    }));

    const outgoing = allFriends.filter(f => f.status === 'pending' && f.direction === 'outgoing').map(f => ({
      accountId: f.friend_id,
      created: f.created_at,
    }));

    const blocklist = allFriends.filter(f => f.status === 'blocked').map(f => ({
      accountId: f.friend_id,
      created: f.created_at,
    }));

    return reply.send({
      friends,
      incoming,
      outgoing,
      suggested: [],
      blocklist,
      settings: { acceptInvites: 'public' },
    });
  });

  fastify.get('/friends/api/public/friends/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const allFriends = getFriends(accountId);
    return reply.send(allFriends.filter(f => f.status === 'accepted').map(f => ({
      accountId: f.friend_id,
      status: 'ACCEPTED',
      // Epic's enum is INBOUND/OUTBOUND. The DB stores 'incoming'/'outgoing', so toUpperCase()
      // emitted INCOMING/OUTGOING, which the client's friend deserialiser does not recognise.
      direction: f.direction === 'incoming' ? 'INBOUND' : 'OUTBOUND',
      created: f.created_at,
      favorite: false,
    })));
  });

  fastify.get('/friends/api/v1/:accountId/friends', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const allFriends = getFriends(accountId);
    return reply.send(allFriends.filter(f => f.status === 'accepted').map(f => ({
      accountId: f.friend_id,
      status: 'ACCEPTED',
      // Epic's enum is INBOUND/OUTBOUND. The DB stores 'incoming'/'outgoing', so toUpperCase()
      // emitted INCOMING/OUTGOING, which the client's friend deserialiser does not recognise.
      direction: f.direction === 'incoming' ? 'INBOUND' : 'OUTBOUND',
      created: f.created_at,
      favorite: false,
    })));
  });

  fastify.get('/friends/api/public/blocklist/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const allFriends = getFriends(accountId);
    return reply.send({
      blockedUsers: allFriends.filter(f => f.status === 'blocked').map(f => f.friend_id),
    });
  });

  fastify.get('/friends/api/v1/:accountId/blocklist', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const allFriends = getFriends(accountId);
    return reply.send(allFriends.filter(f => f.status === 'blocked').map(f => ({
      accountId: f.friend_id,
      created: f.created_at,
    })));
  });

  fastify.get('/friends/api/public/list/fortnite/:accountId/recentPlayers', async (request, reply) => {
    return reply.send([]);
  });

  fastify.get('/friends/api/v1/:accountId/recent/fortnite', async (request, reply) => {
    return reply.send([]);
  });

  fastify.get('/friends/api/v1/:accountId/settings', async (request, reply) => {
    return reply.send({ acceptInvites: 'public' });
  });

  // Friends CRUD — DB-backed
  fastify.post('/friends/api/v1/:accountId/friends/:friendId', async (request, reply) => {
    const { accountId, friendId } = request.params as { accountId: string; friendId: string };
    // Check if the other side already sent a request (auto-accept)
    const theirFriends = getFriends(friendId);
    const existingRequest = theirFriends.find(f => f.friend_id === accountId && f.status === 'pending');
    if (existingRequest) {
      acceptFriend(accountId, friendId);
      console.log(`[Friends] ${accountId} accepted friend request from ${friendId}`);
    } else {
      addFriend(accountId, friendId, 'pending');
      console.log(`[Friends] ${accountId} sent friend request to ${friendId}`);
    }
    reply.status(204).send();
  });

  fastify.delete('/friends/api/v1/:accountId/friends/:friendId', async (request, reply) => {
    const { accountId, friendId } = request.params as { accountId: string; friendId: string };
    removeFriend(accountId, friendId);
    console.log(`[Friends] ${accountId} removed ${friendId}`);
    reply.status(204).send();
  });

  fastify.post('/friends/api/v1/:accountId/blocklist/:blockedId', async (request, reply) => {
    const { accountId, blockedId } = request.params as { accountId: string; blockedId: string };
    blockUser(accountId, blockedId);
    console.log(`[Friends] ${accountId} blocked ${blockedId}`);
    reply.status(204).send();
  });

  fastify.delete('/friends/api/v1/:accountId/blocklist/:blockedId', async (request, reply) => {
    const { accountId, blockedId } = request.params as { accountId: string; blockedId: string };
    removeFriend(accountId, blockedId); // Unblock = remove the blocked entry
    reply.status(204).send();
  });

  // ═══════════════════════════════════════════════
  //  PARTY SERVICE
  // ═══════════════════════════════════════════════

  /** GET user parties */
  fastify.get('/party/api/v1/Fortnite/user/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    return reply.send({
      current: [],
      pending: [],
      invites: [],
      pings: [],
    });
  });

  /**
   * Undelivered ping/invite counts, and privacy settings.
   *
   * 7.40 is a party-V1 build: its party system is XMPP-only and it makes no /party HTTP calls at all
   * (the string `party/api` does not appear in the client binary). These two stubs exist because
   * backends targeting old builds ship them anyway — a 404 here is worth avoiding and costs nothing.
   * The party itself is NOT served over HTTP on this build; see the XMPP server.
   */
  fastify.get('/party/api/v1/Fortnite/user/:accountId/notifications/undelivered/count', async (_request, reply) => {
    return reply.send({ pings: 0, invites: 0 });
  });

  fastify.get('/party/api/v1/Fortnite/user/:accountId/settings/privacy', async (_request, reply) => {
    return reply.send({ current: [], pending: [], invites: [], pings: [] });
  });

  /** Create party */
  fastify.post('/party/api/v1/Fortnite/parties', async (request, reply) => {
    const partyId = generateUUID();
    const body = request.body as any;
    const now = new Date().toISOString();

    // The Fortnite client posts the creator as `join_info.connection` (carrying its XMPP JID), NOT a
    // `members` array. The old code read `body.members` — always absent — so the created party came
    // back with NO captain and no connection JID, breaking the client's own party state (member list,
    // invites, party-leader matchmaking readiness). Build the single CAPTAIN from join_info.
    const conn = body?.join_info?.connection || {};
    const connId = String(conn.id || '');
    const captainAccountId = (connId.includes('@') ? connId.split('@')[0] : connId) || 'nova-player';
    const members = [{
      account_id: captainAccountId,
      meta: body?.join_info?.meta || {},
      connections: [{
        id: connId,
        connected_at: now,
        updated_at: now,
        yield_leadership: false,
        meta: conn.meta || {},
      }],
      revision: 0,
      updated_at: now,
      joined_at: now,
      role: 'CAPTAIN',
    }];

    return reply.send({
      id: partyId,
      created_at: now,
      updated_at: now,
      config: {
        type: 'DEFAULT', joinability: 'OPEN', discoverability: 'ALL',
        sub_type: 'default', max_size: 16, invite_ttl: 14400,
        join_confirmation: false,
        intention_ttl: 60,
        ...(body?.config || {}),
      },
      members,
      applicants: [],
      meta: body?.meta || {},
      invites: [],
      revision: 0,
      intentions: [],
    });
  });

  /** PATCH party — update party config/meta */
  fastify.patch('/party/api/v1/Fortnite/parties/:partyId', async (request, reply) => {
    return reply.status(204).send();
  });

  /** PATCH party member meta */
  fastify.patch('/party/api/v1/Fortnite/parties/:partyId/members/:accountId/meta', async (request, reply) => {
    return reply.status(204).send();
  });

  /** POST join party */
  fastify.post('/party/api/v1/Fortnite/parties/:partyId/members/:accountId/join', async (request, reply) => {
    return reply.send({ status: 'JOINED', party_id: (request.params as any).partyId });
  });

  /** DELETE leave party */
  fastify.delete('/party/api/v1/Fortnite/parties/:partyId/members/:accountId', async (request, reply) => {
    reply.status(204).send();
  });

  /** POST promote party member */
  fastify.post('/party/api/v1/Fortnite/parties/:partyId/members/:accountId/promote', async (request, reply) => {
    reply.status(204).send();
  });

  /** POST party invite */
  fastify.post('/party/api/v1/Fortnite/parties/:partyId/invites/:accountId', async (request, reply) => {
    reply.status(204).send();
  });

  /** POST party pings */
  fastify.post('/party/api/v1/Fortnite/user/:accountId/pings/:pingerId', async (request, reply) => {
    return reply.send({
      sent_by: (request.params as any).pingerId,
      sent_to: (request.params as any).accountId,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      meta: {},
    });
  });

  /** DELETE party pings */
  fastify.delete('/party/api/v1/Fortnite/user/:accountId/pings/:pingerId', async (request, reply) => {
    reply.status(204).send();
  });

  // ═══════════════════════════════════════════════
  //  PRESENCE SERVICE
  // ═══════════════════════════════════════════════

  fastify.get('/presence/api/v1/_/:accountId/settings/subscriptions', async (request, reply) => {
    return reply.send([]);
  });

  fastify.post('/presence/api/v1/_/:accountId/settings/subscriptions', async (request, reply) => {
    reply.status(204).send();
  });

  fastify.get('/presence/api/v1/_/:accountId/last-online', async (request, reply) => {
    return reply.send([]);
  });

  // ═══════════════════════════════════════════════
  //  FORTNITE GAMEPLAY ENDPOINTS
  // ═══════════════════════════════════════════════

  /** Enabled features */
  fastify.get('/fortnite/api/game/v2/enabled_features', async (_, reply) => reply.send([]));

  /** Twitch linking */
  fastify.get('/fortnite/api/game/v2/twitch/:accountId', async (_, reply) => reply.send({}));

  /** Receipts */
  fastify.get('/fortnite/api/receipts/v1/account/:accountId/receipts', async (_, reply) => reply.send([]));

  /** Privacy settings */
  fastify.get('/fortnite/api/game/v2/privacy/account/:accountId', async (request, reply) => {
    return reply.send({ accountId: (request.params as any).accountId, optOutOfPublicLeaderboards: false });
  });

  fastify.post('/fortnite/api/game/v2/privacy/account/:accountId', async (request, reply) => {
    return reply.send({ accountId: (request.params as any).accountId, optOutOfPublicLeaderboards: false });
  });

  /** Try play on platform — must return true (text/plain) */
  fastify.all('/fortnite/api/game/v2/tryPlayOnPlatform/account/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    console.log(`[SOCIAL] tryPlayOnPlatform hit for ${accountId}`);
    reply.header('Content-Type', 'text/plain');
    return reply.send('true');
  });

  /** Grant access — allows game to launch */
  fastify.post('/fortnite/api/game/v2/grant_access/:accountId', async (request, reply) => {
    reply.status(204).send();
  });

  /** Profile Token Verify — prevents "Fortnite was not started correctly" kick */
  fastify.all('/fortnite/api/game/v2/profileToken/verify/:accountId', async (request, reply) => {
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════
  //  EVENTS & TOURNAMENTS
  // ═══════════════════════════════════════════════

  fastify.get('/api/v1/events/Fortnite/download/:accountId', async (request, reply) => {
    return reply.send({
      player: { accountId: (request.params as any).accountId, tokens: [], teamId: null, pendingPayouts: [], pendingPenalties: {}, persistentScores: {} },
      events: [],
      templates: [],
    });
  });

  fastify.get('/api/v1/leaderboards/Fortnite/:eventId/:windowId/:accountId', async (request, reply) => {
    return reply.send({ entries: [], maxSize: 1000 });
  });

  // ═══════════════════════════════════════════════
  //  EULA, TELEMETRY, WAITING ROOM
  // ═══════════════════════════════════════════════

  /** Eulatracking — must return 204 or client loops */
  fastify.post('/eulatracking/api/public/agreements/fn/account/:accountId', async (_, reply) => reply.status(204).send());
  fastify.get('/eulatracking/api/public/agreements/fn/account/:accountId', async (_, reply) => reply.status(204).send());
  fastify.put('/eulatracking/api/shared/agreements/fn', async (_, reply) => reply.status(204).send());

  /** Datarouter — telemetry sink, stores events for analytics */
  fastify.post('/datarouter/api/v1/public/data', async (request, reply) => {
    try {
      const body = request.body as any;
      if (body && typeof body === 'object') {
        const events = body.Events || body.events || [];
        if (Array.isArray(events)) {
          for (const event of events.slice(0, 50)) { // Cap at 50 events per batch
            logTelemetry(
              event.AccountId || event.accountId || null,
              event.EventName || event.eventName || 'unknown',
              event
            );
          }
        } else {
          logTelemetry(null, 'raw_telemetry', { size: JSON.stringify(body).length });
        }
      }
    } catch {}
    // NOTE: do NOT flushDb() here. datarouter is the single highest-frequency endpoint the client
    // hits, and flushDb() bypasses the write debounce to do a SYNCHRONOUS full-DB export + writeFileSync,
    // stalling the event loop. On the coordinator (with Tailscale latency added) that stall can push a
    // concurrent oauth/verify or profile refresh past the client's timeout, which the client turns into
    // a "Fortnite was not started correctly" force-logout. Telemetry is bounded (5000 rows) and analytics-
    // only, so it does not need durable flushing — the debounced saveDb on real mutations + the exit hook
    // persist it opportunistically.
    return reply.status(204).send();
  });

  /** Affiliate validation */
  fastify.post('/affiliate/api/v2/affiliates/slug/validate', async (_, reply) => {
    return reply.send({ verified: true, id: 'nova', slug: 'nova', displayName: 'Nova', status: 'ACTIVE' });
  });

  // ═══════════════════════════════════════════════
  //  CONTENT PAGES & NEWS
  // ═══════════════════════════════════════════════

  /** Content pages (news, etc.) */
  fastify.get('/content/api/pages/fortnite-game', async (_, reply) => {
    const now = new Date().toISOString();
    return reply.send({
      _title: 'Fortnite Game',
      _activeDate: now,
      lastModified: now,
      _locale: 'en-US',
      battleroyalenews: {
        news: {
          _type: 'Battle Royale News',
          motds: [{
            entryType: 'Text', image: '', tileImage: '', hidden: false,
            tabTitleOverride: 'Nova', _type: 'CommonUI Simple Message MOTD',
            title: 'Welcome to Project Nova', body: 'Chapter 1 Season 7/8 Backend Emulator',
            spotlight: false, id: 'nova-motd-1',
          }],
        },
      },
      emergencynotice: { news: { _type: 'CommonUI Simple Message Base', messages: [] } },
      emergencynoticeoverride: {},
      subgameinfo: {
        battleroyale: {
          _type: 'CommonUI Simple Message Base',
          message: { image: '', _type: 'CommonUI Simple Message', title: 'Battle Royale', body: 'Project Nova' },
        },
        savetheworld: {
          _type: 'CommonUI Simple Message Base',
          message: { image: '', _type: 'CommonUI Simple Message', title: 'Save the World', body: '' },
        },
        creative: {
          _type: 'CommonUI Simple Message Base',
          message: { image: '', _type: 'CommonUI Simple Message', title: 'Creative', body: '' },
        },
      },
      savetheworldnews: { news: { _type: 'CommonUI Simple Message Base', messages: [] } },
      loginmessage: { loginmessage: { _type: 'CommonUI Simple Message Base', message: { image: '', _type: 'CommonUI Simple Message', title: 'Project Nova', body: 'Welcome.' } } },
      survivalmessage: { overrideablemessage: { _type: 'CommonUI Simple Message Base', message: { image: '', _type: 'CommonUI Simple Message', title: '', body: '' } } },
      athenamessage: { overrideablemessage: { _type: 'CommonUI Simple Message Base', message: { image: '', _type: 'CommonUI Simple Message', title: '', body: '' } } },
      tournamentinformation: { tournament_info: { tournaments: [] } },
      dynamicbackgrounds: {
        backgrounds: {
          backgrounds: [
            { stage: 'defaultnotifications', _type: 'DynamicBackground', key: 'lobby' },
            // Season-driven so the lobby background matches the season the timeline advertises (and
            // the build the client is on). Hardcoding season 8 gave a 7.40 (S7) client a stage it has
            // no assets for → blank lobby background.
            { stage: `lobbyseason${Config.SEASON_NUMBER}`, _type: 'DynamicBackground', key: 'lobby' },
          ],
        },
      },
      playlistinformation: {
        frontend_matchmaking_header_style: 'None',
        frontend_matchmaking_header_text: '',
        playlist_info: {
          playlists: [
            { image: '', playlist_name: 'Playlist_DefaultSolo', hidden: false, _type: 'FortPlaylistInfo' },
            { image: '', playlist_name: 'Playlist_DefaultDuo', hidden: false, _type: 'FortPlaylistInfo' },
            { image: '', playlist_name: 'Playlist_DefaultSquad', hidden: false, _type: 'FortPlaylistInfo' },
            { image: '', playlist_name: 'Playlist_ShowdownAlt_Solo', hidden: false, _type: 'FortPlaylistInfo' },
            { image: '', playlist_name: 'Playlist_ShowdownAlt_Duos', hidden: false, _type: 'FortPlaylistInfo' },
          ],
        },
      },
    });
  });

  // ═══════════════════════════════════════════════
  //  WAITING ROOM & VERSION CHECK
  // ═══════════════════════════════════════════════

  /** Waitingroom — must say disabled or client waits forever */
  fastify.get('/waitingroom/api/waitingroom', async (_, reply) => reply.status(204).send());

  /** Version check */
  fastify.get('/fortnite/api/v2/versioncheck/:platform', async (_, reply) => {
    return reply.send({ type: 'NO_UPDATE' });
  });
  fastify.get('/fortnite/api/versioncheck', async (_, reply) => {
    return reply.send({ type: 'NO_UPDATE' });
  });

  // ═══════════════════════════════════════════════
  //  CALENDAR / TIMELINE
  // ═══════════════════════════════════════════════

  /** Calendar / timeline — critical for season configuration */
  fastify.get('/fortnite/api/calendar/v1/timeline', async (request, reply) => {
    const now = new Date().toISOString();
    // Advertise the season the CLIENT is actually on (parsed from its build by versionRouter), so a
    // 7.40 client gets S7 and an 8.x client gets S8 — the "S7/S8" project can serve both at once.
    // Falls back to Config.SEASON_NUMBER only when the build can't be parsed.
    const season = Number((request as any).gameVersion?.season) || Config.SEASON_NUMBER;

    // Base season flags plus that season's limited-time-mode / event flags, so the LTM tiles and
    // in-lobby event decorations for S7 (14 Days of Fortnite, Frostnite, Festivus, …) / S8 (Spring
    // 2019, High Stakes, Booty Bay, …) light up instead of only core Solo/Duo/Squad. (Ported from
    // the Reload reference's per-season flag lists.)
    const FAR = '9999-12-31T23:59:59.999Z';
    const SINCE = '2019-02-28T14:00:00Z';
    const seasonEventFlags: { eventType: string; activeUntil: string; activeSince: string }[] = [
      { eventType: `EventFlag.Season${season}`, activeUntil: FAR, activeSince: SINCE },
      { eventType: `EventFlag.LobbySeason${season}`, activeUntil: FAR, activeSince: SINCE },
    ];
    const LTM_FLAGS: Record<number, string[]> = {
      7: ['EventFlag.Frostnite', 'EventFlag.LTM_14DaysOfFortnite', 'EventFlag.LTE_Festivus', 'EventFlag.LTM_WinterDeimos', 'EventFlag.LTE_S7_OverTime'],
      8: ['EventFlag.Spring2019', 'EventFlag.Spring2019.Phase1', 'EventFlag.Spring2019.Phase2', 'EventFlag.LTM_Ashton', 'EventFlag.LTM_Goose', 'EventFlag.LTM_HighStakes', 'EventFlag.LTE_BootyBay'],
    };
    for (const flag of (LTM_FLAGS[season] || [])) {
      seasonEventFlags.push({ eventType: flag, activeUntil: FAR, activeSince: SINCE });
    }

    return reply.send({
      channels: {
        'standalone-store': {
          states: [{
            validFrom: '2019-01-01T00:00:00.000Z',
            activeEvents: [],
            state: {
              activePurchaseLimitingEventIds: [],
              storeDenyList: [],
              activeStorefronts: [],
              catalogVersion: 1,
              sectionStoreEnds: {},
              activateLoadoutPrivileges: [],
            },
          }],
          cacheExpire: '9999-12-31T23:59:59.999Z',
        },
        'client-matchmaking': {
          states: [{
            validFrom: '2019-01-01T00:00:00.000Z',
            activeEvents: [],
            state: {
              region: {
                NAE: { eventFlagsForceBinaryEqual: '', allowedPlatforms: 'Windows' },
                NAW: { eventFlagsForceBinaryEqual: '', allowedPlatforms: 'Windows' },
                EU: { eventFlagsForceBinaryEqual: '', allowedPlatforms: 'Windows' },
                OCE: { eventFlagsForceBinaryEqual: '', allowedPlatforms: 'Windows' },
                BR: { eventFlagsForceBinaryEqual: '', allowedPlatforms: 'Windows' },
                ASIA: { eventFlagsForceBinaryEqual: '', allowedPlatforms: 'Windows' },
                ME: { eventFlagsForceBinaryEqual: '', allowedPlatforms: 'Windows' },
              },
            },
          }],
          cacheExpire: '9999-12-31T23:59:59.999Z',
        },
        'client-events': {
          states: [{
            validFrom: '2019-01-01T00:00:00.000Z',
            activeEvents: seasonEventFlags,
            state: {
              seasonNumber: season,
              seasonTemplateId: `AthenaSeason:athenaseason${season}`,
              matchXpBonusPoints: 0,
              seasonBegin: '2019-02-28T14:00:00Z',
              seasonEnd: '9999-12-31T23:59:59.999Z',
              seasonDisplayedEnd: '9999-12-31T23:59:59.999Z',
              weeklyStoreEnd: '9999-12-31T23:59:59.999Z',
              stwEventStoreEnd: '9999-12-31T23:59:59.999Z',
              stwWeeklyStoreEnd: '9999-12-31T23:59:59.999Z',
              dailyStoreEnd: '9999-12-31T23:59:59.999Z',
              sectionStoreEnds: {},
            },
          }],
          cacheExpire: '9999-12-31T23:59:59.999Z',
        },
      },
      eventsTimeOffsetHrs: 0,
      cacheIntervalMins: 15,
      currentTime: now,
    });
  });

  // EOS SDK config, account lookup, and epic-settings are now
  // handled by the EOS translation layer in services/eos/eos.routes.ts.

  // ═══════════════════════════════════════════════
  //  MISC ENDPOINTS (from LawinServer main.js)
  //  Stats/feedback/world endpoints are in stats.routes.ts
  // ═══════════════════════════════════════════════

  fastify.post('/fortnite/api/game/v2/events/v2/setSubgroup/*', async (_, reply) => {
    return reply.status(204).send();
  });

  fastify.post('/fortnite/api/game/v2/chat/:accountId/recommendGeneralChatRooms/pc', async (_, reply) => {
    return reply.send({});
  });

  fastify.get('/fortnite/api/game/v2/leaderboards/cohort/*', async (_, reply) => {
    return reply.send([]);
  });

  fastify.get('/persona/api/public/account/lookup', async (_, reply) => {
    return reply.send({ id: 'unknown', displayName: 'Unknown', externalAuths: {} });
  });

  fastify.get('/api/v1/search/:accountId', async (_, reply) => {
    return reply.send([]);
  });

  // ═══════════════════════════════════════════════
  //  CHAT ROOMS (prevents [UNHANDLED] log spam)
  // ═══════════════════════════════════════════════

  /** Reserve general chat rooms — client expects a valid chatroom response */
  fastify.post('/fortnite/api/game/v2/chat/:accountId/reserveGeneralChatRooms/:subGame/:platform', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    return reply.send({
      globalChatRooms: [
        {
          roomName: `Fortnite_Nova_global_${accountId.substring(0, 8)}`,
          currentMembersCount: 1,
          maxMembersCount: 100,
          publicFacingShortName: 'Nova Global',
          ownerAccountId: accountId,
          locale: 'en',
          description: 'Nova General Chat',
          members: [],
        },
      ],
      foundationChatRooms: [],
    });
  });
}
