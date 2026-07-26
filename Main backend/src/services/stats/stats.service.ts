import { incrementPlayerStat, seedDefaultStats, setPlayerStat, getPlayerStats } from '../../database';
import { checkAchievements } from '../achievements/achievements.service';

/**
 * Stats Service — handles post-match stat updates and XP/level calculations.
 */

/** XP required per level (simplified curve) */
const XP_PER_LEVEL = 8000;
const MAX_LEVEL = 100;

/** Calculate level from total XP */
export function calculateLevel(totalXp: number): number {
  const level = Math.floor(totalXp / XP_PER_LEVEL) + 1;
  return Math.min(level, MAX_LEVEL);
}

/** Calculate XP earned from a match result */
export function calculateMatchXp(kills: number, placement: number, timeAliveSeconds: number): number {
  let xp = 0;

  // Base XP for playing
  xp += 50;

  // Kill XP (50 per kill)
  xp += kills * 50;

  // Placement XP
  if (placement === 1) xp += 300;
  else if (placement <= 3) xp += 200;
  else if (placement <= 5) xp += 150;
  else if (placement <= 10) xp += 100;
  else if (placement <= 25) xp += 50;

  // Survival time XP (1 XP per 10 seconds)
  xp += Math.floor(timeAliveSeconds / 10);

  return xp;
}

/** Map playlist ID to the stat key suffix */
function getPlaylistStatSuffix(playlistId: string): string {
  const lower = playlistId.toLowerCase();
  if (lower.includes('duo')) return 'playlist_defaultduo';
  if (lower.includes('squad')) return 'playlist_defaultsquad';
  return 'playlist_defaultsolo';
}

/** Get placement stat thresholds for a playlist */
function getPlacementThresholds(playlistSuffix: string): { stat: string; threshold: number }[] {
  if (playlistSuffix === 'playlist_defaultsolo') {
    return [
      { stat: 'br_placetop10', threshold: 10 },
      { stat: 'br_placetop25', threshold: 25 },
    ];
  } else if (playlistSuffix === 'playlist_defaultduo') {
    return [
      { stat: 'br_placetop5', threshold: 5 },
      { stat: 'br_placetop12', threshold: 12 },
    ];
  } else {
    return [
      { stat: 'br_placetop3', threshold: 3 },
      { stat: 'br_placetop6', threshold: 6 },
    ];
  }
}

export interface MatchResult {
  accountId: string;
  kills: number;
  placement: number;
  damageDealt: number;
  timeAliveSeconds: number;
  playlistId: string;
}

/**
 * Update all stats for a player after a match ends.
 * Returns the XP earned.
 */
export function updatePostMatchStats(result: MatchResult): number {
  const { accountId, kills, placement, timeAliveSeconds, playlistId } = result;

  // Ensure stats exist
  seedDefaultStats(accountId);

  const suffix = getPlaylistStatSuffix(playlistId);
  const inputDevice = 'keyboardmouse';
  const prefix = `${inputDevice}_m0_${suffix}`;

  // Increment matches played
  incrementPlayerStat(accountId, `br_matchesplayed_${prefix}`, 1);

  // Increment kills
  if (kills > 0) {
    incrementPlayerStat(accountId, `br_kills_${prefix}`, kills);
  }

  // Increment wins
  if (placement === 1) {
    incrementPlayerStat(accountId, `br_placetop1_${prefix}`, 1);
  }

  // Increment placement brackets
  const thresholds = getPlacementThresholds(suffix);
  for (const { stat, threshold } of thresholds) {
    if (placement <= threshold) {
      incrementPlayerStat(accountId, `${stat}_${prefix}`, 1);
    }
  }

  // Calculate and add XP/score
  const xpEarned = calculateMatchXp(kills, placement, timeAliveSeconds);
  incrementPlayerStat(accountId, `br_score_${prefix}`, xpEarned);

  // Update minutes played
  const minutesPlayed = Math.floor(timeAliveSeconds / 60);
  if (minutesPlayed > 0) {
    incrementPlayerStat(accountId, `br_minutesplayed_${prefix}`, minutesPlayed);
  }

  // Update last modified timestamp
  setPlayerStat(accountId, `br_lastmodified_${prefix}`, Math.floor(Date.now() / 1000));

  // Check achievements after stat updates
  const newAchievements = checkAchievements(accountId);
  if (newAchievements.length > 0) {
    console.log(`[Stats] ${accountId} unlocked ${newAchievements.length} achievement(s): ${newAchievements.join(', ')}`);
  }

  console.log(`[Stats] Updated stats for ${accountId}: +${kills} kills, placement #${placement}, +${xpEarned} XP`);
  return xpEarned;
}
