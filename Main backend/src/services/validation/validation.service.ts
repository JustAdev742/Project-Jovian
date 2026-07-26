/**
 * Validation Service — anti-tamper checks for P2P match results.
 * Since matches are host-authoritative, the host reports results.
 * We validate sanity bounds to catch obvious tampering.
 */

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  sanitized: {
    kills: number;
    placement: number;
    damageDealt: number;
    timeAliveSeconds: number;
  };
}

/**
 * Validate a single participant's match result.
 * Returns sanitized values clamped to sane bounds.
 */
export function validateMatchResult(
  accountId: string,
  kills: number,
  placement: number,
  damageDealt: number,
  timeAliveSeconds: number,
  totalPlayers: number
): ValidationResult {
  const warnings: string[] = [];

  // Kill sanity: can't exceed total players minus 1
  let sanitizedKills = Math.max(0, Math.floor(kills || 0));
  if (sanitizedKills > totalPlayers - 1) {
    warnings.push(`Kills (${sanitizedKills}) exceeds max possible (${totalPlayers - 1})`);
    sanitizedKills = Math.min(sanitizedKills, totalPlayers - 1);
  }
  if (sanitizedKills > 50) {
    warnings.push(`Suspiciously high kill count: ${sanitizedKills}`);
    sanitizedKills = Math.min(sanitizedKills, 50);
  }

  // Placement sanity: must be 1-100
  let sanitizedPlacement = Math.max(1, Math.min(Math.floor(placement || 100), 100));

  // Damage sanity: reasonable cap per match
  let sanitizedDamage = Math.max(0, Math.floor(damageDealt || 0));
  if (sanitizedDamage > 99999) {
    warnings.push(`Damage (${sanitizedDamage}) exceeds maximum`);
    sanitizedDamage = 99999;
  }

  // Time alive: max 2 hours (7200 seconds)
  let sanitizedTime = Math.max(0, Math.floor(timeAliveSeconds || 0));
  if (sanitizedTime > 7200) {
    warnings.push(`Time alive (${sanitizedTime}s) exceeds maximum`);
    sanitizedTime = 7200;
  }

  // Cross-validation: if placement=1 but kills=0 and time<60s, suspicious
  if (sanitizedPlacement === 1 && sanitizedKills === 0 && sanitizedTime < 60) {
    warnings.push('Win with 0 kills and <60s survival time is suspicious');
  }

  // Damage vs kills ratio check (avg 100 damage per kill is reasonable, 500+ per kill is suspicious)
  if (sanitizedKills > 0 && sanitizedDamage / sanitizedKills > 500) {
    warnings.push(`High damage/kill ratio: ${Math.round(sanitizedDamage / sanitizedKills)}`);
  }

  return {
    valid: warnings.length === 0,
    warnings,
    sanitized: {
      kills: sanitizedKills,
      placement: sanitizedPlacement,
      damageDealt: sanitizedDamage,
      timeAliveSeconds: sanitizedTime,
    },
  };
}

/**
 * Validate currency tampering: check if reported currency matches DB state.
 */
export function validateCurrencyIntegrity(
  reportedBalance: number,
  actualBalance: number
): { valid: boolean; warning?: string } {
  if (Math.abs(reportedBalance - actualBalance) > 100) {
    return {
      valid: false,
      warning: `Currency mismatch: reported=${reportedBalance}, actual=${actualBalance}`,
    };
  }
  return { valid: true };
}

/**
 * Rate-limit stat updates per account to prevent rapid-fire abuse.
 * Returns true if the update should be allowed.
 */
const recentUpdates = new Map<string, number[]>();

export function rateLimitStatUpdate(accountId: string, maxPerMinute: number = 10): boolean {
  const now = Date.now();
  const timestamps = recentUpdates.get(accountId) || [];

  // Remove entries older than 1 minute
  const recent = timestamps.filter(t => now - t < 60000);
  recent.push(now);
  recentUpdates.set(accountId, recent);

  if (recent.length > maxPerMinute) {
    console.warn(`[Validation] Rate limit exceeded for ${accountId}: ${recent.length} updates in 60s`);
    return false;
  }
  return true;
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [accountId, timestamps] of recentUpdates) {
    const recent = timestamps.filter(t => now - t < 60000);
    if (recent.length === 0) {
      recentUpdates.delete(accountId);
    } else {
      recentUpdates.set(accountId, recent);
    }
  }
}, 5 * 60 * 1000);
