import { getPlayerStats, unlockAchievement, getAchievements } from '../../database';
import { sendXmppMessage } from '../xmpp/xmpp.server';

/**
 * Achievements Service — checks and unlocks achievements based on player stats.
 */

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  /** Stat name to check */
  statName: string;
  /** Threshold value to unlock */
  threshold: number;
  /** XP reward for unlocking */
  xpReward: number;
}

/** Achievement catalog — add more as needed */
export const ACHIEVEMENT_CATALOG: AchievementDef[] = [
  // Kill milestones
  { id: 'ach_first_kill', name: 'First Blood', description: 'Get your first elimination', statName: 'br_kills_keyboardmouse_m0_playlist_defaultsolo', threshold: 1, xpReward: 100 },
  { id: 'ach_100_kills', name: 'Century Slayer', description: 'Get 100 eliminations', statName: 'br_kills_keyboardmouse_m0_playlist_defaultsolo', threshold: 100, xpReward: 500 },
  { id: 'ach_500_kills', name: 'Unstoppable', description: 'Get 500 eliminations', statName: 'br_kills_keyboardmouse_m0_playlist_defaultsolo', threshold: 500, xpReward: 1000 },
  { id: 'ach_1000_kills', name: 'Legendary Warrior', description: 'Get 1,000 eliminations', statName: 'br_kills_keyboardmouse_m0_playlist_defaultsolo', threshold: 1000, xpReward: 2000 },

  // Win milestones
  { id: 'ach_first_win', name: 'Victory Royale!', description: 'Win your first match', statName: 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo', threshold: 1, xpReward: 500 },
  { id: 'ach_10_wins', name: 'Champion', description: 'Win 10 matches', statName: 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo', threshold: 10, xpReward: 1000 },
  { id: 'ach_50_wins', name: 'Legend', description: 'Win 50 matches', statName: 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo', threshold: 50, xpReward: 2500 },
  { id: 'ach_100_wins', name: 'Mythic Victor', description: 'Win 100 matches', statName: 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo', threshold: 100, xpReward: 5000 },

  // Match milestones
  { id: 'ach_first_match', name: 'Rookie', description: 'Play your first match', statName: 'br_matchesplayed_keyboardmouse_m0_playlist_defaultsolo', threshold: 1, xpReward: 50 },
  { id: 'ach_100_matches', name: 'Veteran', description: 'Play 100 matches', statName: 'br_matchesplayed_keyboardmouse_m0_playlist_defaultsolo', threshold: 100, xpReward: 500 },
  { id: 'ach_500_matches', name: 'Dedicated', description: 'Play 500 matches', statName: 'br_matchesplayed_keyboardmouse_m0_playlist_defaultsolo', threshold: 500, xpReward: 1500 },

  // Duo milestones
  { id: 'ach_duo_first_win', name: 'Dynamic Duo', description: 'Win a duo match', statName: 'br_placetop1_keyboardmouse_m0_playlist_defaultduo', threshold: 1, xpReward: 500 },

  // Squad milestones
  { id: 'ach_squad_first_win', name: 'Squad Goals', description: 'Win a squad match', statName: 'br_placetop1_keyboardmouse_m0_playlist_defaultsquad', threshold: 1, xpReward: 500 },

  // Score milestones
  { id: 'ach_score_10k', name: 'Rising Star', description: 'Earn 10,000 score', statName: 'br_score_keyboardmouse_m0_playlist_defaultsolo', threshold: 10000, xpReward: 500 },
  { id: 'ach_score_100k', name: 'All-Star', description: 'Earn 100,000 score', statName: 'br_score_keyboardmouse_m0_playlist_defaultsolo', threshold: 100000, xpReward: 2000 },
];

/**
 * Check all achievements for a player and unlock any newly earned ones.
 * Returns an array of newly unlocked achievement IDs.
 */
export function checkAchievements(accountId: string): string[] {
  const stats = getPlayerStats(accountId);
  const existing = getAchievements(accountId);
  const existingIds = new Set(existing.map(a => a.achievement_id));
  const newlyUnlocked: string[] = [];

  for (const ach of ACHIEVEMENT_CATALOG) {
    // Skip already unlocked
    if (existingIds.has(ach.id)) continue;

    // Check if threshold is met
    const statValue = stats[ach.statName] || 0;
    if (statValue >= ach.threshold) {
      const wasNew = unlockAchievement(accountId, ach.id);
      if (wasNew) {
        newlyUnlocked.push(ach.id);
        console.log(`[Achievements] ${accountId} unlocked: ${ach.name} (${ach.id})`);

        // Send XMPP notification
        try {
          sendXmppMessage(accountId, JSON.stringify({
            type: 'com.epicgames.achievement.unlocked',
            achievementId: ach.id,
            achievementName: ach.name,
            description: ach.description,
            xpReward: ach.xpReward,
            timestamp: new Date().toISOString(),
          }));
        } catch {}
      }
    }
  }

  return newlyUnlocked;
}

/** Get achievement progress for a player */
export function getAchievementProgress(accountId: string): { id: string; name: string; description: string; unlocked: boolean; progress: number; threshold: number }[] {
  const stats = getPlayerStats(accountId);
  const existing = getAchievements(accountId);
  const existingIds = new Set(existing.map(a => a.achievement_id));

  return ACHIEVEMENT_CATALOG.map(ach => ({
    id: ach.id,
    name: ach.name,
    description: ach.description,
    unlocked: existingIds.has(ach.id),
    progress: Math.min(stats[ach.statName] || 0, ach.threshold),
    threshold: ach.threshold,
  }));
}
