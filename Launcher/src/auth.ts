// src/auth.ts
// Launcher accounts: sign up, sign in, session persistence.
//
// Where these calls go matters. Sign-in happens BEFORE anything has pressed Play, which is before
// nova-proxy exists — so http://127.0.0.1:3551 isn't listening yet and anything sent there fails.
// Accounts are also global rather than per-machine: the account you make here has to be the same
// account on any other PC. Both facts point the same way, so in P2P mode auth talks to the
// coordinator directly, and only a single-PC setup uses the local backend.
import axios from "axios";
import { BACKEND, COORDINATOR, p2pMode } from "./novaApi";

export function authBase(): string {
  return p2pMode() ? COORDINATOR : BACKEND;
}

/** The signed-in player. `accountId` is the FORTNITE account — what the game is launched with. */
export type Session = {
  accountId: string;
  launcherId: string;
  username: string;
  displayName: string;
  email: string;
  token: string;
  refreshToken: string;
  expiresAt: string;
};

/** Which input was wrong, so the form can mark that field rather than showing one generic banner. */
export type AuthError = {
  field: "username" | "email" | "password" | "login" | "network";
  message: string;
};

export type AuthResult = { ok: true; session: Session } | { ok: false; error: AuthError };

const SESSION_KEY = "user";

/**
 * Persisted session, or null. Anything malformed OR EXPIRED is discarded rather than half-trusted.
 *
 * The expiry check is not optional. Without it a token from days ago still looks like a valid
 * session: the launcher shows you signed in, greets you by name, and then every authenticated call
 * quietly fails — V-Bucks and level read as zero, the account page is empty — with nothing anywhere
 * saying "your session ran out". Being sent to the sign-in screen is a worse-looking but far more
 * honest outcome.
 */
export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.accountId || !s?.token || !s?.username) return null;

    if (s.expiresAt) {
      const expires = new Date(s.expiresAt).getTime();
      // A minute of slack so a token about to lapse doesn't expire mid-launch. An unparseable date
      // is treated as fine — a bad timestamp shouldn't sign someone out of a working session.
      if (Number.isFinite(expires) && expires < Date.now() + 60_000) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
    }
    return s as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** Shared shape for the two POSTs below — both return either a session or a field-tagged error. */
async function post(path: string, body: unknown): Promise<AuthResult> {
  try {
    const { data } = await axios.post(`${authBase()}${path}`, body, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });
    if (data?.ok) return { ok: true, session: data as Session };
    return { ok: false, error: { field: data?.field || "login", message: data?.message || "That didn't work." } };
  } catch (e: any) {
    // A 4xx carries the real, field-specific reason — surface it instead of "Request failed with
    // status code 409", which tells a person nothing about which box to fix.
    const d = e?.response?.data;
    if (d?.message) return { ok: false, error: { field: d.field || "login", message: d.message } };
    return {
      ok: false,
      error: {
        field: "network",
        message: p2pMode()
          ? "Couldn’t reach the Nova servers — check your internet connection."
          : "Couldn’t reach the local Nova backend.",
      },
    };
  }
}

export async function register(username: string, email: string, password: string): Promise<AuthResult> {
  return post("/nova/api/launcher/register", { username, email, password });
}

export async function login(loginId: string, password: string): Promise<AuthResult> {
  return post("/nova/api/launcher/login", { login: loginId, password });
}

/** Live "is this taken" for the sign-up form, so it's known before pressing the button. */
export type Availability = { available: boolean; message?: string };

export async function checkAvailability(
  q: { username?: string; email?: string },
): Promise<{ username?: Availability; email?: Availability }> {
  try {
    const { data } = await axios.get(`${authBase()}/nova/api/launcher/available`, {
      params: q,
      timeout: 6000,
    });
    return data || {};
  } catch {
    // Offline: say nothing rather than claiming a name is free. Registration re-checks server-side,
    // so a missed hint here can't create a duplicate.
    return {};
  }
}

/** Profile for the account page. */
export type Profile = {
  ok: boolean;
  launcherId: string;
  username: string;
  email: string;
  accountId: string;
  displayName: string;
  createdAt?: string;
  lastLogin?: string;
  banned?: boolean;
};

/**
 * Your own profile.
 *
 * The account is identified by the TOKEN, not by an id in the query string. It used to pass
 * `?accountId=` to an unauthenticated endpoint, which meant anyone could read anyone's email by
 * supplying their id — and ids are on display in this very screen.
 */
export async function getProfile(token: string): Promise<Profile | null> {
  try {
    const { data } = await axios.get(`${authBase()}/nova/api/launcher/me`, {
      headers: { Authorization: `bearer ${token}` },
      timeout: 8000,
    });
    return data?.ok ? (data as Profile) : null;
  } catch {
    return null;
  }
}

export async function changePassword(
  loginId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const { data } = await axios.post(
      `${authBase()}/nova/api/launcher/password`,
      { login: loginId, currentPassword, newPassword },
      { timeout: 15000 },
    );
    return { ok: !!data?.ok };
  } catch (e: any) {
    return { ok: false, message: e?.response?.data?.message || "Couldn’t change your password." };
  }
}
