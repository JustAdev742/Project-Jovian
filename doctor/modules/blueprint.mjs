/**
 * Blueprint inspector — what can honestly be inspected without an editor.
 *
 * Project Nova has no Blueprint source: the game's Blueprints are Epic's, cooked to bytecode inside
 * encrypted paks, and Nova changes behaviour from C++ (Reboot) instead. So compile errors, broken
 * pin connections and invalid graph references cannot be examined — there is nothing to open — and
 * this module says so rather than reporting a clean bill of health.
 *
 * What DOES exist is Blueprint RUNTIME failure: when a Blueprint function dereferences None or
 * recurses, UE4 writes a LogScript line naming the function. Reboot's server-side actions (spawning,
 * inventory, abilities) feed those Blueprints, so a LogScript error after a Reboot change is a lead.
 */
import { normaliseMessage } from '../lib/ue4log.mjs';

const M = 'blueprint';

/** Pull the Blueprint function out of a LogScript message, when UE4 names one. */
function blueprintOf(msg) {
  return /Function\s+(\/[^\s:]+(?::[\w]+)?)/.exec(msg)?.[1]
    || /Blueprint:\s*(\S+)\s+Function:\s*(\S+)/.exec(msg)?.slice(1).join('.')
    || /(\/Game\/[^\s']+)/.exec(msg)?.[1]
    || null;
}

export default {
  id: M,
  title: 'Blueprint inspector',
  async run(ctx, F) {
    const cov = [];
    const sessions = ctx.ue4Sessions || [];
    let total = 0;
    for (const s of sessions) {
      for (const e of s.script) {
        total++;
        const bp = blueprintOf(e.message);
        const norm = normaliseMessage(e.message);
        // Not a Blueprint fault at all: NATIVE code called a Blueprint-exposed library function
        // (GameplayStatics / Kismet) with a null world. In Nova only Cobalt (the bumper's sound-mix
        // and spawn calls) and Reboot make such calls, so this belongs to them.
        if (/null object was passed as a world context object/i.test(e.message)) {
          F.add({
            id: 'blueprint.null-world-context', key: `blueprint.null-world-context:${s.kind}`, module: M,
            component: s.kind === 'ue4:host' ? 'reboot' : 'cobalt', category: 'reflection',
            severity: 'P3', confidence: 'CONFIRMED',
            title: `Native code passed a null world context to a GameplayStatics/Kismet call (${s.kind === 'ue4:host' ? 'gameserver' : 'client'})`,
            explain: 'UE4 logs this when a Blueprint-library function is invoked with WorldContextObject = null. The call is harmless-looking and returns nothing, so a feature built on it silently does not run. The Root Cause Analyzer checks whether it coincides with the bumper.',
            firstSeen: e.time, lastSeen: e.time, cause: 'null-world-context',
            evidence: [{ source: s.name, line: e.line, time: e.time, excerpt: e.message }],
          });
          continue;
        }
        const kind = /Accessed None/.test(e.message) ? 'accessed-none' : /Infinite script recursion|runaway loop/i.test(e.message) ? 'runaway' : 'script-error';
        F.add({
          id: `blueprint.${kind}`, key: `blueprint.${kind}:${s.kind}:${bp || norm}`, module: M,
          component: s.kind === 'ue4:host' ? 'reboot' : 'game', category: 'blueprint',
          severity: kind === 'runaway' ? 'P1' : 'P3', confidence: 'CONFIRMED',
          title: `Blueprint ${kind === 'accessed-none' ? 'read a None reference' : kind === 'runaway' ? 'runaway loop/recursion' : 'script error'}${bp ? ` in ${bp}` : ''} (${s.kind === 'ue4:host' ? 'gameserver' : 'client'})`,
          explain: s.kind === 'ue4:host'
            ? 'On the gameserver a Blueprint usually reads None because Reboot spawned or initialised something without a field the Blueprint expects. Check Reboot changes to the related actor.'
            : 'Client-side Blueprint error; often a consequence of server state the client did not receive.',
          firstSeen: e.time, lastSeen: e.time,
          evidence: [{ source: s.name, line: e.line, time: e.time, excerpt: e.message }],
          data: { blueprint: bp, message: norm },
        });
      }
    }
    cov.push({ area: 'Blueprint runtime errors (LogScript)', status: sessions.length ? 'checked' : 'skipped',
      detail: sessions.length ? `${total} LogScript errors/warnings across ${sessions.length} UE4 sessions` : 'no UE4 logs were read (Log Intelligence did not run)' });
    for (const area of ['Blueprint compilation', 'broken pin connections', 'invalid Blueprint references']) {
      cov.push({ area, status: 'n/a', detail: 'no editor project or Blueprint source exists for Nova — the game\'s Blueprints are Epic\'s, cooked into encrypted paks' });
    }
    return { coverage: cov };
  },
};
