import jwt from 'jsonwebtoken';
import { Config } from '../../config';
import { generateUUID } from '../../utils/uuid';

export interface TokenPayload {
  sub: string;        // account id
  dn: string;         // display name
  am: string;         // auth method
  clid: string;       // client id
  t: string;          // token type: 'eg1' (access) or 'eg1~r' (refresh)
  ic: boolean;        // is client token
  exp: number;        // expiry timestamp
  iat: number;        // issued at
  jti: string;        // unique token id
}

/**
 * Generate an eg1 access token matching Epic's format
 */
export function generateAccessToken(accountId: string, displayName: string, clientId: string, grantType: string): {
  token: string;
  expiresAt: string;
  expiresIn: number;
  tokenId: string;
} {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = Config.TOKEN_EXPIRY_HOURS * 3600;
  const tokenId = generateUUID();

  const payload: TokenPayload = {
    sub: accountId,
    dn: displayName,
    am: grantType,
    clid: clientId,
    t: 'eg1',
    ic: false,
    exp: now + expiresIn,
    iat: now,
    jti: tokenId,
  };

  const token = `eg1~${jwt.sign(payload, Config.JWT_SECRET, { algorithm: 'HS256' })}`;

  const expiresAtDate = new Date((now + expiresIn) * 1000);

  return {
    token,
    expiresAt: expiresAtDate.toISOString(),
    expiresIn,
    tokenId,
  };
}

/**
 * Generate a refresh token
 */
export function generateRefreshToken(accountId: string, clientId: string): {
  token: string;
  expiresAt: string;
  expiresIn: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 24 * 3600; // 24h

  const payload = {
    sub: accountId,
    t: 'eg1~r',
    clid: clientId,
    exp: now + expiresIn,
    iat: now,
    jti: generateUUID(),
  };

  const token = `eg1~${jwt.sign(payload, Config.JWT_SECRET, { algorithm: 'HS256' })}`;

  return {
    token,
    expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
    expiresIn,
  };
}

/**
 * Generate a client_credentials token (no user context)
 */
export function generateClientToken(clientId: string): {
  token: string;
  expiresAt: string;
  expiresIn: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 4 * 3600;

  const payload = {
    sub: clientId,
    t: 'eg1',
    clid: clientId,
    ic: true,
    exp: now + expiresIn,
    iat: now,
    jti: generateUUID(),
  };

  const token = `eg1~${jwt.sign(payload, Config.JWT_SECRET, { algorithm: 'HS256' })}`;

  return {
    token,
    expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
    expiresIn,
  };
}

/**
 * Verify and decode an eg1 token
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const rawJwt = token.startsWith('eg1~') ? token.slice(4) : token;
    return jwt.verify(rawJwt, Config.JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}
