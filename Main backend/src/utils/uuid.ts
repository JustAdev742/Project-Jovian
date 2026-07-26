import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

/**
 * Generates a UUID v4
 */
export function generateUUID(): string {
  return uuid();
}

/**
 * Generates a hex string of given byte length.
 *
 * Must be crypto-grade: every call site is a credential (EOS id_token, bearer tokens, product user
 * ids). Math.random is xorshift128+ with recoverable internal state, so an attacker who collects a
 * handful of issued tokens can predict the next ones.
 */
export function generateHex(bytes: number = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generates a random item GUID for MCP items
 */
export function generateItemGuid(): string {
  return uuid().replace(/-/g, '');
}

/**
 * Generates a DETERMINISTIC GUID from a seed string.
 * Critical: MCP item GUIDs must be stable across QueryProfile calls
 * or the client will desync/crash when cached GUIDs change.
 */
export function buildDeterministicGuid(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return hash.substring(0, 32);
}
