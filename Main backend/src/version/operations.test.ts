/**
 * What MCP operations Nova claims to handle.
 *
 * WHY THIS EXISTS. "Nova handles 34 MCP operations" reads like coverage and is not. Measured
 * 2026-09-06 against the 7.40 shipping client (all 149 operation names in the endpoint corpus,
 * controls both ways): 84 of them exist in that build, Nova handles 34, and the two sets overlap
 * only partly in BOTH directions. KNOWN_ISSUES.md carries the full audit.
 *
 * This test does not read the binary — the client is not in the repo. It pins the SWITCH, so that
 * adding or removing a handler has to be a deliberate act that updates the audit with it. The
 * failure message is the point: it tells you which side moved.
 *
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES = path.join(__dirname, '..', 'services', 'mcp', 'mcp.routes.ts');

/** The operation names in the handler switch, read from source rather than by booting the app. */
function handledOperations(): string[] {
  const src = fs.readFileSync(ROUTES, 'utf8');
  const body = src.slice(src.indexOf('switch (operation)'));
  return [...new Set([...body.matchAll(/case '([A-Za-z0-9_]+)':/g)].map((m) => m[1]))].sort();
}

/** Audited 2026-09-06. Changing this list means the audit in KNOWN_ISSUES.md needs changing too. */
const AUDITED = [
  'ApplyConsumable', 'AssignGadgetToLoadout', 'AthenaPinQuest', 'ClaimLoginReward', 'ClaimMfaEnabled',
  'ClientQuestLogin', 'CompletePlayerSurvey', 'CopyCosmeticLoadout', 'DeleteCosmeticLoadout',
  'EquipBattleRoyaleCustomization', 'FortRerollDailyQuest', 'GetMcpTimeForLogin', 'GiftCatalogEntry',
  'IncrementNamedCounterStat', 'MarkItemSeen', 'MarkNewQuestNotificationSent', 'PopulatePrerolledOffers',
  'PurchaseCatalogEntry', 'QueryProfile', 'RefreshExpeditions', 'RefundMtxPurchase', 'RemoveGiftBox',
  'SetAffiliateName', 'SetBattleRoyaleBanner', 'SetCosmeticLockerBanner', 'SetCosmeticLockerSlot',
  'SetHardcoreModifier', 'SetItemFavoriteStatus', 'SetItemFavoriteStatusBatch', 'SetMCPEnabled',
  'SetMatchmakingBans', 'SetPinnedQuests', 'SetReceiveGiftsEnabled', 'VerifyRealMoneyPurchase',
].sort();

/**
 * Of the 34 operations Nova handles, which ones the 7.40 client actually contains. Every name below
 * was scanned directly against the shipping binary on 2026-09-06 — this is measured, not derived by
 * set arithmetic against the corpus, because the corpus turned out to be modern-biased and does not
 * document EquipBattleRoyaleCustomization or SetBattleRoyaleBanner at all despite both being in 7.40.
 */
const IN_740 = new Set([
  'AssignGadgetToLoadout', 'ClaimLoginReward', 'ClaimMfaEnabled', 'ClientQuestLogin',
  'EquipBattleRoyaleCustomization', 'FortRerollDailyQuest', 'GiftCatalogEntry', 'MarkItemSeen',
  'MarkNewQuestNotificationSent', 'PopulatePrerolledOffers', 'PurchaseCatalogEntry', 'QueryProfile',
  'RefreshExpeditions', 'RefundMtxPurchase', 'RemoveGiftBox', 'SetAffiliateName',
  'SetBattleRoyaleBanner', 'SetItemFavoriteStatus', 'SetItemFavoriteStatusBatch', 'SetPinnedQuests',
  'SetReceiveGiftsEnabled', 'VerifyRealMoneyPurchase',
]);

/**
 * Handled by Nova, ABSENT from 7.40. Not a defect — a backend may answer more than one era, and
 * SetCosmeticLockerSlot / SetCosmeticLockerBanner are exactly that. Recorded so the distinction
 * between 'we serve this' and 'this build can ask for it' stays visible.
 */
const NOT_IN_740 = new Set([
  'ApplyConsumable', 'AthenaPinQuest', 'CompletePlayerSurvey', 'CopyCosmeticLoadout',
  'DeleteCosmeticLoadout', 'GetMcpTimeForLogin', 'IncrementNamedCounterStat',
  'SetCosmeticLockerBanner', 'SetCosmeticLockerSlot', 'SetHardcoreModifier', 'SetMCPEnabled',
  'SetMatchmakingBans',
]);
describe('MCP operation coverage', () => {
  test('the handler switch matches the audited set', () => {
    const handled = handledOperations();
    const added = handled.filter((o) => !AUDITED.includes(o));
    const removed = AUDITED.filter((o) => !handled.includes(o));
    assert.deepEqual(
      { added, removed },
      { added: [], removed: [] },
      'The MCP handler switch changed. That is fine — but update the audit in KNOWN_ISSUES.md ' +
        '("Audit — MCP operation coverage vs the 7.40 client") and this list together, and say ' +
        'whether the 7.40 client actually has the operation. Verify with:\n' +
        '  node tools/binscan.js <exe> count <OperationName>',
    );
  });

  test('both eras of the locker path stay handled', () => {
    // The one piece of genuine cross-version support that already existed here: 7.40 equips via
    // EquipBattleRoyaleCustomization, later builds via SetCosmeticLockerSlot. Losing either silently
    // breaks one era's locker, and only one of those eras can currently reach Nova to complain.
    const handled = new Set(handledOperations());
    assert.ok(handled.has('EquipBattleRoyaleCustomization'), '7.40 equip path missing');
    assert.ok(handled.has('SetBattleRoyaleBanner'), '7.40 banner path missing');
    assert.ok(handled.has('SetCosmeticLockerSlot'), 'later-era equip path missing');
    assert.ok(handled.has('SetCosmeticLockerBanner'), 'later-era banner path missing');
  });

  test('the audit records nothing as both present and absent in 7.40', () => {
    for (const op of IN_740) assert.ok(!NOT_IN_740.has(op), `${op} recorded as both present and absent`);
  });

  test('every operation Nova handles was checked against the client', () => {
    // Guards the audit against drift. A handled operation in neither bucket was never scanned, so
    // 'Nova supports it' would be resting on nothing. All 34 are currently accounted for.
    const unaccounted = handledOperations().filter((o) => !IN_740.has(o) && !NOT_IN_740.has(o));
    assert.deepEqual(unaccounted, [], 'Scan these against the client, then add them to one of the two sets.');
  });

  test('the two buckets together cover exactly what is handled', () => {
    assert.equal(IN_740.size + NOT_IN_740.size, handledOperations().length);
    assert.equal(IN_740.size, 22);
    assert.equal(NOT_IN_740.size, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  Release-Live — the branch-named builds that predate numbered releases.
//
//  CONFIRMED from a real binary: ++Fortnite+Release-Live-CL-3240987, UE 4.14.0, December 2016.
//  `Athena` and `BattleRoyale` are both ABSENT from it, so it is pre-Battle-Royale, and `profile0`
//  is PRESENT while `common_core` / `campaign` / `athena` are all absent — the reverse of 7.40.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { identifyVersion } from './identify';

describe('Release-Live builds', () => {
  const id = (ua: string) => identifyVersion({ 'user-agent': ua }, 7);

  test('a Release-Live client is distinguishable from a non-client', () => {
    // These were identical before: both fell through to the configured target with no signal saying
    // which was which, so an unexpected old client was invisible in the diagnostics.
    const live = id('Fortnite/++Fortnite+Release-Live-CL-3240987 Windows/10.0.14393');
    const curl = id('curl/8.0');
    assert.equal(live.id, 'live');
    assert.equal(curl.id, 'unknown');
    assert.notEqual(live.id, curl.id);
  });

  test('its changelist is kept — the only version information it carries', () => {
    assert.equal(id('Fortnite/++Fortnite+Release-Live-CL-3240987 Windows/10.0').changelist, 3240987);
    assert.equal(id('curl/8.0').changelist, undefined);
  });

  test('confidence stays UNKNOWN — a changelist does not place a build in a chapter', () => {
    // The whole point. Detecting the build must not be mistaken for dating it, and the era filter
    // in mcp/profiles/athena.ts keys off exactly this field.
    const live = id('Fortnite/++Fortnite+Release-Live-CL-3240987 Windows/10.0');
    assert.equal(live.confidence, 'UNKNOWN');
    assert.ok(live.signals.includes('user-agent:Release-Live'));
    assert.ok(live.signals.includes('fallback:configured-target'));
  });

  test('the 7.40 baseline is untouched by any of this', () => {
    const v = id('Fortnite/++Fortnite+Release-7.40-CL-5046157 Windows/10.0.17763.1.256.64bit');
    assert.equal(v.id, '7.40');
    assert.equal(v.confidence, 'CONFIRMED');
    assert.equal(v.chapter, 1);
    assert.equal(v.season, 7);
    assert.equal(v.changelist, 5046157);
  });
});
