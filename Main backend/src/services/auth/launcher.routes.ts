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
import { generateAccessToken, generateRefreshToken } from './token.service';
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

    const acct = authenticateLauncher(login, password);
    if (!acct) {
      // One message for both cases on purpose: saying "no such user" would let anyone enumerate who
      // has an account here.
      return reply.status(401).send({ ok: false, field: 'password', message: 'Incorrect username or password.' });
    }

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
   * Migration path: put a launcher login on a Fortnite account that predates launcher accounts, so
   * its locker, stats and V-Bucks carry over instead of starting again.
   */
  fastify.post('/nova/api/launcher/claim', async (request, reply) => {
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

  /** GET /nova/api/launcher/me?accountId= — profile for the account-management page. */
  fastify.get('/nova/api/launcher/me', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const acct = q.accountId ? getLauncherAccountByFortniteId(q.accountId) : undefined;
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
    const acct = authenticateLauncher(String(b.login || ''), String(b.currentPassword || ''));
    if (!acct) return reply.status(401).send({ ok: false, field: 'password', message: 'Current password is incorrect.' });
    const next = String(b.newPassword || '');
    if (next.length < 8) return reply.status(400).send({ ok: false, field: 'password', message: 'Passwords need to be at least 8 characters.' });
    setLauncherPassword(acct.id, next);
    return reply.send({ ok: true });
  });
}
