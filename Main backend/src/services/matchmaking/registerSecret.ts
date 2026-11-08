/**
 * The gameserver-registration secret — what the coordinator ISSUES, kept apart from what it ENFORCES.
 *
 * WHY THE TWO ARE SEPARATE (2026-11-08). There used to be one value, `Config.REGISTER_SECRET`
 * (NOVA_REGISTER_SECRET), doing both jobs. Setting it made `GET /nova/api/register-secret` hand it
 * out AND made the register gate refuse every registration without it, in the same instant. So the
 * only way to start issuing the secret was to lock every launcher older than 1.6.5 out of hosting.
 * The standing rule became "NOVA_REGISTER_SECRET stays unset on the coordinator", and step one of
 * `gameserver-register-unauthenticated` (KNOWN_ISSUES.md) therefore never ran: every launcher asked,
 * got HTTP 503, and registered without a secret. The pipeline was built end to end and carried
 * nothing.
 *
 * NOW:
 *
 *   ISSUED    NOVA_REGISTER_SECRET when it is set (then issued and enforced are the same value, as
 *             before). Otherwise a random value generated on the first authenticated request and
 *             kept in `data/register-secret`, so it survives restarts. Always available.
 *
 *   ENFORCED  Only when NOVA_REGISTER_SECRET is set — exactly the old gate, nothing tighter.
 *
 * So the coordinator can hand out a secret and COUNT who sends it back, without refusing anyone.
 * Every new registration is logged with `auth=signed|unsigned|wrong`. Step two — making the gate
 * fail closed — is then a decision taken on that evidence rather than a guess about how much of the
 * field has updated.
 *
 * The secret is never logged, by this file or by the route that serves it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../config';

let cached: string | null = null;

/** Length-independent comparison, so a wrong secret cannot be narrowed down by timing it. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function readStored(): string | null {
  try {
    const v = fs.readFileSync(Config.REGISTER_SECRET_FILE, 'utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The issued secret if one already exists — NEVER creates one.
 *
 * The register path uses this, not `issuedRegisterSecret`, so that a registration arriving before
 * any launcher has asked for the secret does not write a file as a side effect.
 */
export function peekIssuedRegisterSecret(): string | null {
  if (Config.REGISTER_SECRET) return Config.REGISTER_SECRET;
  if (cached) return cached;
  cached = readStored();
  return cached;
}

/**
 * The secret to hand to an authenticated launcher, creating and storing it on first use.
 * Throws only if the file cannot be written — the caller turns that into a 503, which launchers
 * already treat as "register without a secret".
 */
export function issuedRegisterSecret(): string {
  const existing = peekIssuedRegisterSecret();
  if (existing) return existing;

  const fresh = crypto.randomBytes(32).toString('base64url');
  const file = Config.REGISTER_SECRET_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // 'wx' = create, fail if it exists. Two first requests racing must end up with ONE secret, or a
    // launcher would be handed a value that is overwritten a millisecond later.
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600, flag: 'wx' });
    cached = fresh;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    cached = readStored();
    if (!cached) throw e;
  }
  return cached;
}

export type RegistrationAuth = 'signed' | 'unsigned' | 'wrong';

/**
 * What a registration carried, for the log. Purely descriptive: nothing is refused on this.
 *
 * `wrong` is not refused in step one on purpose. A host agent outlives its launcher, so after the
 * stored secret is replaced an agent can keep sending the old one for hours. That is worth seeing,
 * not worth an outage.
 */
export function classifyRegistration(supplied: unknown): RegistrationAuth {
  if (typeof supplied !== 'string' || supplied.length === 0) return 'unsigned';
  const issued = peekIssuedRegisterSecret();
  return issued && sameSecret(supplied, issued) ? 'signed' : 'wrong';
}

/**
 * Whether the register/unregister gate refuses this request. Byte-for-byte the old rule: it can only
 * refuse when NOVA_REGISTER_SECRET is set, which it is not on the coordinator. An issued-but-not-
 * enforced secret never makes this return true.
 */
export function registerGateRefuses(supplied: unknown): boolean {
  if (!Config.REGISTER_SECRET) return false;
  return !(typeof supplied === 'string' && sameSecret(supplied, Config.REGISTER_SECRET));
}

/** Forget the in-memory copy, as a restart would. Tests only. */
export function _forgetCachedRegisterSecret(): void {
  cached = null;
}
