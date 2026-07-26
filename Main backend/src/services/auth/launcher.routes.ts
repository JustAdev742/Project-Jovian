import { FastifyInstance } from 'fastify';
import {
  createLauncherAccount,
  authenticateLauncher,
  getLauncherAccountByUsername,
  getLauncherAccountByEmail,
  getLauncherAccountByFortniteId,
  claimExistingAccount,
  setLauncherPassword,
  getAccount,
} from '../../database';
import { generateAccessToken, generateRefreshToken, verifyToken } from './token.service';
import { storeToken } from '../../database';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  LAUNCHER ACCOUNTS — sign up, sign in, manage
//
//  Separate from /account/api/oauth/token on purpose. That endpoint speaks Fortnite's OAuth dialect
//  and has to keep accepting what the GAME sends; this one is the launcher's own, and can therefore
//  do the things a real account system needs — reject a duplicate email, verify a password, tell you
//  which field was wrong.
//
//  Every failure names the field that caused it, because "registration failed" tells a person
//  nothing about what to change.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Deliberately permissive: letters, numbers, underscore, dot, hyphen. It becomes the in-game name. */
const USERNAME_RE = /^[A-Za-z0-9._-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface FieldError { field: 'username' | 'email' | 'password' | 'login'; message: string }

function validateRegistration(username: string, email: string, password: string): FieldError | null {
  if (!username || !USERNAME_RE.test(username)) {
    return { field: 'username', message: 'Usernames are 3-20 characters, using letters, numbers, dots, hyphens or underscores.' };
  }
  if (!email || !EMAIL_RE.test(email)) {
    return { field: 'email', message: 'That does not look like an email address.' };
  }
  if (!password || password.length < 8) {
    return { field: 'password', message: 'Passwords need to be at least 8 characters.' };
  }
  return null;
}

/** What the launcher gets back on a successful sign-in or sign-up. */
function sessionFor(launcher: { id: string; username: string; email: string; fortnite_account_id: string }) {
  const fnId = launcher.fortnite_account_id;
  const access = generateAccessToken(fnId, launcher.username, 'nova-launcher', 'launcher');
  const refresh = generateRefreshToken(fnId, 'nova-launcher');
  storeToken(access.token, fnId, 'nova-launcher', 'launcher', access.expiresAt);
  return {
    accountId: fnId,          // the Fortnite account the game will use
    launcherId: launcher.id,  // the person
    username: launcher.username,
    displayName: launcher.username,
    email: launcher.email,
    token: access.token,
    refreshToken: refresh.token,
    expiresAt: access.expiresAt,
  };
}

/* ── Throttle ───────────────────────────────────────────────────────────────────────────────────
   Password guessing was unlimited. scrypt makes each attempt cost something, but "slow" is not
   "bounded" — an attacker with a wordlist and patience still gets through, and every attempt also
   burns coordinator CPU that the people actually playing need.

   Keyed by login rather than by IP on purpose: every player reaches the coordinator through the
   Tailscale funnel, so from the server's side they ALL share one source address. An IP-keyed
   limiter would lock out the whole player base the moment one person fat-fingered a password.

   Deliberately small and in-process. A shared store would be better with more than one backend;
   there is one, and an in-memory counter that works today beats a Redis dependency that doesn't
   exist yet. */
const FAILS = new Map<string, { n: number; until: number }>();
const MAX_FAILS = 8;
const LOCKOUT_MS = 10 * 60_000;

function throttleKey(login: string) { return login.toLowerCase().trim(); }

/** Returns remaining lockout ms, or 0 if the caller may proceed. */
function lockedFor(login: string): number {
  const e = FAILS.get(throttleKey(login));
  if (!e) return 0;
  if (Date.now() > e.until) { FAILS.delete(throttleKey(login)); return 0; }
  return e.n >= MAX_FAILS ? e.until - Date.now() : 0;
}

function noteFailure(login: string) {
  const k = throttleKey(login);
  const e = FAILS.get(k);
  // Each failure pushes the window out, so a slow drip can't reset the count by waiting.
  if (e && Date.now() <= e.until) { e.n += 1; e.until = Date.now() + LOCKOUT_MS; }
  else FAILS.set(k, { n: 1, until: Date.now() + LOCKOUT_MS });
}

function clearFailures(login: string) { FAILS.delete(throttleKey(login)); }

export async function launcherAuthRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * POST /nova/api/launcher/register  { username, email, password }
   * Creates the launcher account AND its linked Fortnite account in one step, so a player can never
   * end up with one without the other.
   */
  fastify.post('/nova/api/launcher/register', async (request, reply) => {
    const b = (request.body || {}) as any;
    const username = String(b.username || '').trim();
    const email = String(b.email || '').trim();
    const password = String(b.password || '');

    const invalid = validateRegistration(username, email, password);
    if (invalid) return reply.status(400).send({ ok: false, ...invalid });

    const result = createLauncherAccount(username, email, password);
    if (!result.ok) {
      // Field-specific, so the UI can highlight the offending input rather than shrugging.
      return reply.status(409).send(result.error === 'username-taken'
        ? { ok: false, field: 'username', message: 'This username is already in use.' }
        : { ok: false, field: 'email', message: 'This email is already registered.' });
    }

    console.log(`[Launcher] registered ${username} <${email}> -> fortnite account ${result.account.fortnite_account_id}`);
    return reply.send({ ok: true, ...sessionFor(result.account) });
  });

  /** POST /nova/api/launcher/login  { login, password } — login is a username OR an email. */
  fastify.post('/nova/api/launcher/login', async (request, reply) => {
    const b = (request.body || {}) as any;
    const login = String(b.login || b.username || b.email || '').trim();
    const password = String(b.password || '');

    if (!login) return reply.status(400).send({ ok: false, field: 'login', message: 'Enter your username or email.' });
    if (!password) return reply.status(400).send({ ok: false, field: 'password', message: 'Enter your password.' });

    const wait = lockedFor(login);
    if (wait > 0) {
      const mins = Math.max(1, Math.ceil(wait / 60000));
      return reply.status(429).send({
        ok: false, field: 'password',
        message: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      });
    }

    const acct = authenticateLauncher(login, password);
    if (!acct) {
      noteFailure(login);
      // One message for both cases on purpose: saying "no such user" would let anyone enumerate who
      // has an account here.
      return reply.status(401).send({ ok: false, field: 'password', message: 'Incorrect username or password.' });
    }

    clearFailures(login);
    const fn = getAccount(acct.fortnite_account_id);
    if (fn?.banned) return reply.status(403).send({ ok: false, field: 'login', message: 'This account has been banned.' });

    return reply.send({ ok: true, ...sessionFor(acct) });
  });

  /**
   * GET /nova/api/launcher/available?username=&email=
   * Live "is this taken" for the sign-up form, so someone learns it before submitting.
   */
  fastify.get('/nova/api/launcher/available', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const out: Record<string, unknown> = {};
    if (q.username !== undefined) {
      const u = q.username.trim();
      out.username = USERNAME_RE.test(u)
        ? { available: !getLauncherAccountByUsername(u) }
        : { available: false, message: 'Usernames are 3-20 characters, using letters, numbers, dots, hyphens or underscores.' };
    }
    if (q.email !== undefined) {
      const e = q.email.trim();
      out.email = EMAIL_RE.test(e)
        ? { available: !getLauncherAccountByEmail(e) }
        : { available: false, message: 'That does not look like an email address.' };
    }
    return reply.send(out);
  });

  /**
   * POST /nova/api/launcher/claim  { accountId, username, email, password }
   * Header: x-nova-admin-key
   *
   * Migration path: put a launcher login on a Fortnite account that predates launcher accounts, so
   * its locker, stats and V-Bucks carry over instead of starting again.
   *
   * ── WHY THIS NEEDS AN ADMIN KEY ────────────────────────────────────────────────────────────────
   * It shipped open, and that was an account-takeover hole. The only thing it asked for was the
   * target accountId, and an accountId is not a secret — the launcher shows you your own with a
   * Copy button, and it travels in query strings. Anyone holding one could bind their own
   * username/email/password to that account and inherit its locker, V-Bucks and stats.
   *
   * There is no way to prove ownership of a pre-accounts account from the outside: those accounts
   * never had a password, and the old login flow issued tokens to anyone who asked for a name. So
   * possession of a token proves nothing either, and the honest answer is that claiming is an
   * operator action, not a self-service one. NOVA_ADMIN_KEY must be set for this route to work at
   * all; unset means claiming is simply off.
   */
  fastify.post('/nova/api/launcher/claim', async (request, reply) => {
    const adminKey = process.env.NOVA_ADMIN_KEY;
    const presented = request.headers['x-nova-admin-key'];
    if (!adminKey || typeof presented !== 'string' || presented !== adminKey) {
      // Deliberately vague and identical whether the key is unset or wrong — a different message
      // for each would tell a prober which of the two it is.
      return reply.status(404).send({ ok: false, message: 'Not found.' });
    }

    const b = (request.body || {}) as any;
    const accountId = String(b.accountId || '').trim();
    const username = String(b.username || '').trim();
    const email = String(b.email || '').trim();
    const password = String(b.password || '');

    const invalid = validateRegistration(username, email, password);
    if (invalid) return reply.status(400).send({ ok: false, ...invalid });

    const result = claimExistingAccount(accountId, username, email, password);
    if (!result.ok) {
      const map: Record<string, { field: FieldError['field']; message: string }> = {
        'username-taken': { field: 'username', message: 'This username is already in use.' },
        'email-taken': { field: 'email', message: 'This email is already registered.' },
        'already-claimed': { field: 'login', message: 'That account already has a launcher login.' },
        'no-such-account': { field: 'login', message: 'No such account.' },
      };
      const m = map[result.error];
      return reply.status(409).send({ ok: false, ...m });
    }
    console.log(`[Launcher] ${username} claimed existing account ${accountId}`);
    return reply.send({ ok: true, ...sessionFor(result.account) });
  });

  /**
   * GET /nova/api/launcher/me — profile for the account-management page.
   * Header: Authorization: bearer <access token>
   *
   * The account comes from the TOKEN, never from a query parameter. It used to take
   * `?accountId=`, unauthenticated, and hand back that account's email address, creation date and
   * last-login time to anyone who asked — and account ids are not secret. That was an email
   * harvester with a REST interface.
   */
  fastify.get('/nova/api/launcher/me', async (request, reply) => {
    const header = request.headers.authorization || '';
    const token = header.replace(/^bearer\s+/i, '').trim();
    const claims = token ? verifyToken(token) : null;
    if (!claims?.sub) {
      return reply.status(401).send({ ok: false, message: 'Sign in to view your account.' });
    }
    // Whatever the caller asked for is irrelevant — you get your own profile or nothing.
    const acct = getLauncherAccountByFortniteId(claims.sub);
    if (!acct) return reply.status(404).send({ ok: false, message: 'No launcher account for that id.' });
    const fn = getAccount(acct.fortnite_account_id);
    return reply.send({
      ok: true,
      launcherId: acct.id,
      username: acct.username,
      email: acct.email,
      accountId: acct.fortnite_account_id,
      displayName: fn?.display_name ?? acct.username,
      createdAt: acct.created_at,
      lastLogin: acct.last_login,
      banned: !!fn?.banned,
    });
  });

  /** POST /nova/api/launcher/password  { login, currentPassword, newPassword } */
  fastify.post('/nova/api/launcher/password', async (request, reply) => {
    const b = (request.body || {}) as any;
    const login = String(b.login || '');
    const wait = lockedFor(login);
    if (wait > 0) {
      const mins = Math.max(1, Math.ceil(wait / 60000));
      return reply.status(429).send({ ok: false, field: 'password', message: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }
    const acct = authenticateLauncher(login, String(b.currentPassword || ''));
    if (!acct) {
      noteFailure(login);
      return reply.status(401).send({ ok: false, field: 'password', message: 'Current password is incorrect.' });
    }
    clearFailures(login);
    const next = String(b.newPassword || '');
    if (next.length < 8) return reply.status(400).send({ ok: false, field: 'password', message: 'Passwords need to be at least 8 characters.' });
    setLauncherPassword(acct.id, next);
    return reply.send({ ok: true });
  });
}
