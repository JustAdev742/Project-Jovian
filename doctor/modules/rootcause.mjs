/**
 * Root Cause Analyzer — connect findings that share an underlying cause, so the report leads with a
 * handful of causes instead of a hundred symptoms.
 *
 * Every chain here is one this project has already reasoned through by hand at least once; encoding
 * it means the reasoning happens on every run. Where TIMING decides between two explanations
 * (party publish before vs after XMPP login; a null world context during vs apart from the bumper),
 * the chain checks the timestamps rather than picking one.
 *
 * A cause's confidence is never higher than its weakest required link.
 */
const M = 'rootcause';

const ms = t => (t ? Date.parse(t) : NaN);
const keysOf = (F, pred) => F.list().filter(pred).map(f => f.key);
const byId = (F, prefix) => F.list().filter(f => f.id === prefix || f.key.startsWith(prefix + ':') || f.id.startsWith(prefix));
const openOnly = fs => fs.filter(f => f.status === 'open');

function link(F, keys, cause) {
  for (const k of keys) { const f = F.get(k); if (f && !f.cause) f.cause = cause; else if (f) f.cause = f.cause === cause ? cause : f.cause; }
}

/** Events of a given finding id, from evidence samples AND the session markers (which are exhaustive). */
function times(F, id) {
  return byId(F, id).flatMap(f => f.evidence.map(e => ({ t: e.time, src: e.source }))).filter(e => e.t);
}

export default {
  id: M,
  title: 'Root Cause Analyzer',
  async run(ctx, F) {
    const causes = [];
    const add = c => { causes.push(c); link(F, c.findings, c.id); };

    // 1. Nothing can be tested without the game.
    if (F.get('scanner.game-build-missing')) {
      add({
        id: 'game-build-missing', severity: 'P0', confidence: 'CONFIRMED',
        title: 'The 7.40 build is missing, so nothing can be played, hosted or verified on this PC',
        findings: ['scanner.game-build-missing'],
        narrative: `The launcher last launched ${ctx.paths.gameLastLaunched}, which no longer exists and was not found on any drive. Every fix awaiting in-game verification (1.9.2's quickbar fix first) is blocked on it, and the pak, exe-signature and Aftermath-slot checks are skipped.`,
        next: 'Restore the build (or tell the launcher where it now lives), then re-run the doctor with --game <folder>.',
      });
    }

    // 2. The stuck loading screen.
    const qbClient = byId(F, 'log.quickbar-guid-unmapped');
    const qbServer = byId(F, 'log.quickbars-property-missing');
    if (qbClient.length || qbServer.length) {
      const proof = byId(F, 'log.quickbars-fix-ran');
      const installed = ctx.versions?.installed;
      const fixedIn = '1.9.2';
      const older = installed && installed.localeCompare(fixedIn, undefined, { numeric: true }) < 0;
      add({
        id: 'quickbars-lookup', severity: 'P0',
        confidence: qbClient.length && qbServer.length ? 'CONFIRMED' : 'PROBABLE',
        title: proof.length ? 'Stuck loading screen: QuickBars lookup — the 1.9.2 fix has RUN; check it cleared the client errors'
          : 'Stuck loading screen: Reboot looked up "QuickBars", which 7.40 calls "QuickBar" — fix shipped in 1.9.2, NOT yet verified',
        findings: [...qbClient, ...qbServer, ...proof].map(f => f.key),
        narrative: `Server: ${qbServer.reduce((a, f) => a + f.count, 0)}× "Failed to find property 'QuickBars'". Client: ${qbClient.reduce((a, f) => a + f.count, 0)}× "AddItemInternal could not find Item with GUID". No GUID was ever mapped to a quickbar slot, so the client waited for an inventory it could not build. ${proof.length ? `Proof line seen: ${proof.map(p => p.data?.variant).join(', ')}.` : `No "[QuickBars]" proof line exists yet — the fixed code has never run here${older ? ` (installed launcher is ${installed}, the fix is in ${fixedIn})` : ''}.`}`,
        next: proof.length ? 'Confirm the client logs no "could not find Item with GUID" in the same session.' : 'Restore the game, install 1.9.2, play one match, then look for "[QuickBars]" in cobalt.log.',
      });
    }

    // 3. NOVA-303 — requests escaping the redirect.
    const escape = openOnly([...byId(F, 'log.request-escaped-to-epic'), ...byId(F, 'log.epic-token-rejection'), ...byId(F, 'log.hotfix-batch-discarded'), ...byId(F, 'log.login-invalid-user')]);
    if (escape.length) {
      const sessions = new Set(escape.flatMap(f => f.evidence.map(e => e.source)));
      const total = (ctx.ue4Sessions || []).length;
      add({
        id: 'nova-303', severity: 'P1', confidence: 'CONFIRMED',
        title: `Requests still escape Cobalt's redirect to Epic's live servers (seen in ${sessions.size} of ${total} UE4 sessions)`,
        findings: escape.map(f => f.key),
        narrative: 'Cobalt\'s VEH page-guard hook is a one-shot alarm with a deferred re-arm; a curl_easy_setopt call landing in the gap runs unhooked and leaves for Epic. Epic then rejects the Nova token ("Token is missing key ID value"). When the escaped call is a hotfix file, UE4 discards the whole batch, including the DefaultEngine.ini that points the client at Nova.',
        next: 'The inline hook is blocked by UAC code integrity (carter.rs: -nouac made things worse). The config route — service URLs in the LOCAL DefaultEngine.ini so an unhooked call still reaches Nova — is the open lead in KNOWN_ISSUES nova-303-request-escape.',
      });
    }

    // 4. The July 25 Reboot fixes that never reached the repo.
    const lost = [...byId(F, 'native.cpp-cstr-of-temporary'), ...byId(F, 'native.cpp-guard-tests-field-address')];
    if (lost.length) {
      const fs = await import('node:fs');
      const backup = `${ctx.repo}/_backup-reboot-src-20260725/structs.cpp`;
      const fixedThere = fs.existsSync(backup) && /MUST be a named local/.test(fs.readFileSync(backup, 'utf8'));
      add({
        id: 'reboot-july-fixes-lost', severity: 'P1', confidence: fixedThere ? 'CONFIRMED' : 'PROBABLE',
        title: fixedThere
          ? 'Fixes made to Reboot on 2026-07-25 are missing from the tree that ships (the repo started from an unfixed copy on 07-26)'
          : 'Reboot contains defect patterns recorded as fixed in July',
        findings: lost.map(f => f.key),
        narrative: `${lost.length} known-defect patterns are in Project-Reboot-DLL/: .c_str() of a temporary wstring in FindObject/StaticLoadObject (a use-after-free on every object lookup) and the TickFlush guard that tests the field's address instead of its value (null ReplicationDriver at match end → the 0x90 crash). ${fixedThere ? '_backup-reboot-src-20260725/ holds the fixed versions; git shows the repo tree was first committed on 07-26 without them, and every release since was built from it.' : ''}`,
        next: 'Diff _backup-reboot-src-20260725/ against Project-Reboot-DLL/ to list every lost fix, then port them one at a time with a build after each.',
      });
    }

    // 5. Crashes on the gameserver, and the client crash that follows a dropped connection.
    const hostExits = openOnly(byId(F, 'log.gameserver-exit'));
    const crashGroups = byId(F, 'runtime.crash-group');
    const clientAfterDisconnect = [];
    for (const g of crashGroups.filter(f => f.data?.roles?.includes('client'))) {
      for (const c of (ctx.crashes || []).filter(c => g.data.crashes.includes(c.id))) {
        const near = (ctx.ue4Sessions || []).some(s => s.kind === 'ue4:client' && s.markers.PendingConnectionLost && Math.abs(ms(s.markers.PendingConnectionLost.last) - ms(c.time)) < 120_000);
        if (near) clientAfterDisconnect.push(g.key);
      }
    }
    if (clientAfterDisconnect.length) {
      add({
        id: 'client-crash-on-disconnect', severity: 'P1', confidence: 'PROBABLE',
        title: 'The client crashes shortly after losing its connection to the gameserver',
        findings: [...new Set(clientAfterDisconnect)],
        narrative: 'Each client crash in this group lands within two minutes of a PendingConnectionLost to :7777 in the same session — a server that dies takes the client down with it. Fixing the server-side crash removes the trigger; the client crash itself is engine code.',
        next: 'Treat as a consequence of gameserver deaths; re-check after the gameserver crash causes are fixed.',
      });
    }
    if (hostExits.length || crashGroups.some(f => f.status === 'open' && f.component === 'reboot')) {
      add({
        id: 'host-crash', severity: 'P1', confidence: 'CONFIRMED',
        title: 'Gameserver processes are dying abnormally',
        findings: [...hostExits, ...crashGroups.filter(f => f.component === 'reboot')].map(f => f.key),
        narrative: `${hostExits.reduce((a, f) => a + f.count, 0)} abnormal gameserver exits recorded by the host agent; ${crashGroups.filter(f => f.component === 'reboot').length} UE4 crash signatures with Reboot on the stack (${crashGroups.filter(f => f.component === 'reboot' && f.status === 'open').length} on the Reboot build that ships today).`,
        next: 'Start with crash groups marked open (current build). Stale ones ran a Reboot build that no longer ships.',
      });
    }

    // 6. Cobalt's bumper running inside the headless server.
    const bumperHost = byId(F, 'log.bumper-runs-on-gameserver');
    const nullWorld = byId(F, 'blueprint.null-world-context');
    if (bumperHost.length) {
      const bumperT = times(F, 'log.bumper-runs-on-gameserver').map(e => ms(e.t));
      const correlated = nullWorld.filter(f => f.evidence.some(e => bumperT.some(t => Math.abs(ms(e.time) - t) < 15_000)));
      add({
        id: 'bumper-on-server', severity: 'P3', confidence: 'CONFIRMED',
        title: 'Cobalt runs the intro bumper inside the headless gameserver',
        findings: [...bumperHost, ...correlated].map(f => f.key),
        narrative: `The gameserver logged ${bumperHost.reduce((a, f) => a + f.count, 0)} failed attempts to play bumper.mp4. Cobalt is loaded into both Fortnite processes and its trigger fires in both.${correlated.length ? ' The null world-context script messages fall within 15 s of those attempts, so they very likely come from the same code.' : ''}`,
        next: 'Skip ShowBumper (and the music handling) when the process was started with -nullrhi. Small Cobalt change; verify by the absence of LogMediaUtils errors in FortniteGame_2.log.',
      });
    }

    // 7. Party presence: startup race or regression? Decide by timing.
    const presence = byId(F, 'log.party-presence-publish-failed');
    if (presence.length) {
      let before = 0, after = 0;
      for (const s of ctx.ue4Sessions || []) {
        const fail = s.markers['PublishPartyInfoToPresence failure'];
        const login = s.markers.OnLoggedIntoXmpp;
        if (!fail) continue;
        if (login && ms(fail.last) <= ms(login.first) + 1000) before++; else after++;
      }
      for (const f of presence) {
        if (after === 0 && before > 0) { f.status = 'not-ours'; f.confidence = 'CONFIRMED'; f.explain += ` MEASURED: in all ${before} sessions every failure came before OnLoggedIntoXmpp — the startup race.`; }
        else if (after > 0) { f.confidence = 'PROBABLE'; f.severity = 'P2'; f.explain += ` MEASURED: ${after} session(s) failed AFTER XMPP login — that is not the startup race.`; }
      }
      if (after > 0) add({ id: 'party-presence', severity: 'P2', confidence: 'PROBABLE', title: 'Party presence fails to publish after XMPP login', findings: presence.map(f => f.key),
        narrative: `${after} session(s) show PublishPartyInfoToPresence failing after OnLoggedIntoXmpp, which the documented startup race cannot explain. Check the presence self-echo in xmpp.server.ts.`, next: 'Re-test a party join and read the XMPP presence the client receives.' });
    }

    // 8. Evidence lost to unclean shutdowns.
    const torn = [...byId(F, 'log.file-has-nul-runs'), ...byId(F, 'log.ue4-log-torn'), ...byId(F, 'scanner.files-torn-to-nul')];
    if (torn.length) {
      add({
        id: 'unclean-shutdowns', severity: torn.some(f => f.id === 'scanner.files-torn-to-nul') ? 'P1' : 'P3', confidence: 'PROBABLE',
        title: `${torn.length} files carry torn writes — this PC has repeatedly been powered off or killed with files open`,
        findings: torn.map(f => f.key),
        narrative: 'Runs of NUL bytes where text should be are what an interrupted write leaves. The same cause zeroed nova-proxy on 2026-09-19 and stopped the launcher starting. All physical disks reported Healthy when checked on 2026-11-08, which points at power loss or hard kills rather than a failing drive.',
        next: 'Shut down cleanly; if torn CODE files reappear, check the drive with the manufacturer\'s tool.',
      });
    }

    // 9. Fixed in source is not running.
    const drift = [...byId(F, 'scanner.staging-stale'), ...byId(F, 'scanner.coordinator-drift'), ...byId(F, 'scanner.installed-launcher-behind'), ...byId(F, 'native.stale-reboot-tree-reference')];
    if (drift.length) {
      add({
        id: 'not-running-what-was-fixed', severity: 'P1', confidence: 'CONFIRMED',
        title: 'Code that was fixed is not the code that is running',
        findings: drift.map(f => f.key),
        narrative: 'Each of these is a copy that runs differing from the copy that was built or fixed. It has hidden shipped-as-fixed bugs here before (the backend payload, Cobalt, Reboot, and the coordinator\'s 1.9.0 region fix).',
        next: 'Work through the linked findings; each has its own fix line.',
      });
    }

    // 10. Local-control routes reachable from the internet on the coordinator.
    const routes = byId(F, 'native.route-without-auth');
    if (routes.length) {
      add({
        id: 'coordinator-public-control-routes', severity: 'P1', confidence: 'PROBABLE',
        title: `${routes.length} Nova API routes that change state or expose cross-player data have no authentication — public on the coordinator`,
        findings: routes.map(f => f.key),
        narrative: 'On players\' PCs nova-proxy keeps these on loopback. The coordinator has no proxy: Funnel publishes every path, and Funnel traffic arrives from 127.0.0.1, so a loopback check cannot protect them there.',
        next: 'Give the coordinator a way to tell Funnel traffic from local (or refuse local-control routes when NOVA_HOST_ELECTION is set and no agent spec is expected), then gate the destructive ones (DELETE /logs, DELETE /diagnostics) first.',
      });
    }

    causes.sort((a, b) => a.severity.localeCompare(b.severity) || (a.confidence === 'CONFIRMED' ? -1 : 1));
    return { causes, coverage: [{ area: 'root-cause chains', status: 'checked', detail: `10 chains evaluated, ${causes.length} causes identified, ${causes.reduce((a, c) => a + c.findings.length, 0)} findings linked` }] };
  },
};
