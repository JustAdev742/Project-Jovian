/**
 * The signature catalog: every failure this project has already diagnosed once, written down so it
 * is recognised automatically the next time instead of being rediscovered.
 *
 * Before this file the knowledge lived in KNOWN_ISSUES.md prose, the launcher self-check
 * (diagnostics.rs NOVA-3xx substrings), memory notes and the session handoff — none of it machine-
 * matchable. Each rule cites where it came from (`kb`).
 *
 * RULE FIELDS
 *   id          stable id; becomes the finding id `log.<id>`
 *   sources     which logs it applies to: ue4 (client+host), ue4:client, ue4:host, cobalt, agent,
 *               startup, coordinator
 *   re          regex tested against the raw line
 *   verbosity   optional: only UE4 lines of these verbosities (read positionally — see ue4log.mjs)
 *   severity / confidence / component / category   see lib/finding.mjs
 *   status      'open' (default), 'not-ours' (engine/content, not Nova's to fix), 'known-benign'
 *               (proven harmless), or 'proof' (a positive signal that a fix ran — reported as INFO)
 *   cause       root-cause group the Root Cause Analyzer chains on
 *   kb          where the diagnosis is written down
 *   key         optional (match) => discriminator, so one rule can yield distinct findings
 *
 * GRADING RULE: a matched line is CONFIRMED evidence that the line occurred. Whether it is a
 * PROBLEM is the rule's own grade — e.g. `bVerifyPeer = true` is only PROBABLE evidence that the
 * Engine.ini patch did not apply, because the log line alone does not prove why.
 */

const KI = slug => `KNOWN_ISSUES.md#${slug}`;

export const RULES = [
  // ── Loading screen / inventory (open problem A) ───────────────────────────────────────────────
  {
    id: 'quickbar-guid-unmapped', sources: ['ue4:client'],
    re: /AFortQuickBars::AddItemInternal could not find Item with GUID/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'reboot', category: 'gameplay',
    cause: 'quickbars-lookup', kb: KI('client-stuck-on-loading-screen'),
    title: 'Client could not place inventory items in quickbar slots (stuck-on-loading-screen signature)',
    explain: 'The server never mapped item GUIDs to quickbar slots, so the client waits for an inventory it cannot build. Fixed in 1.9.2 (QuickBar singular + owner lookup); a recurrence on ≥1.9.2 means the fix did not take.',
  },
  {
    id: 'quickbars-property-missing', sources: ['cobalt'],
    re: /Failed to find property 'QuickBars'/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'reboot', category: 'gameplay',
    cause: 'quickbars-lookup', kb: KI('client-stuck-on-loading-screen'),
    title: "Reboot asked the controller for 'QuickBars', which 7.40 does not have",
    explain: 'Reads like a harmless probe and is not: it is the server half of the loading-screen hang. 1.9.2 also tries QuickBar and the owner lookup.',
  },
  {
    id: 'quickbars-fix-ran', sources: ['cobalt'], status: 'proof',
    re: /\[QuickBars\] (controller property found at offset \d+|no QuickBars\/QuickBar property - looking the actor up by owner)/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'reboot', category: 'verification',
    cause: 'quickbars-lookup', kb: KI('client-stuck-on-loading-screen'),
    key: m => m[1].startsWith('controller') ? 'property' : 'owner',
    title: 'The 1.9.2 quickbar lookup ran',
    explain: 'Positive proof the 1.9.2 code is what ran. Which route resolved is in the evidence.',
  },
  {
    id: 'worldinventory-race', sources: ['ue4:client'],
    re: /ClientRestart_Implementation failed because WorldInventory is invalid/,
    severity: 'P2', confidence: 'CONFIRMED', component: 'reboot', category: 'replication',
    cause: 'worldinventory-race', kb: KI('worldinventory-race-at-spawn'),
    title: 'WorldInventory not yet replicated when ClientRestart ran (spawn race)',
    explain: 'Self-heals within seconds; mitigated by ForceNetUpdate before Possess. Open and deliberately unchanged — it is the spawn path. Recorded so its rate can be tracked.',
  },

  // ── Hosting (ProcessEvent, lobby) ─────────────────────────────────────────────────────────────
  {
    id: 'processevent-not-found', sources: ['cobalt'],
    re: /Unable to find ProcessEventAddress/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'reboot', category: 'hosting',
    cause: 'processevent-scan', kb: KI('processevent-signature-misses-on-7.40'),
    title: 'Hosting aborted: Reboot could not resolve ProcessEvent',
    explain: 'The 4.22 pattern scan is intermittent on 7.40. Since 1.8.9 Reboot falls back to the address Cobalt exports; this line means that fallback was unavailable too (Cobalt missing or too old).',
  },
  {
    id: 'processevent-handoff-used', sources: ['cobalt'], status: 'proof',
    re: /ProcessEvent: our scan found nothing; using Cobalt's (0x[0-9a-f]+)/i,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'reboot', category: 'verification',
    cause: 'processevent-scan', kb: KI('processevent-signature-misses-on-7.40'),
    title: "Reboot's own ProcessEvent scan missed; Cobalt's address was used (the 1.8.9 fallback working)",
    explain: 'Each occurrence is one hosting session the fallback rescued. The rate is the scan\'s miss rate.',
  },
  {
    id: 'no-local-player-controller', sources: ['cobalt'],
    re: /Never got a local player controller/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'reboot', category: 'hosting',
    cause: 'host-never-ready', kb: 'Launcher/src-tauri/src/diagnostics.rs (NOVA-306)',
    title: 'Gameserver never opened its lobby (no local player controller)',
    explain: 'From outside this looks like matchmaking hanging; only the host process knows why.',
  },
  {
    id: 'gameserver-exit', sources: ['agent'],
    re: /Gameserver exited \(code=(-?\d+|null)(?: signal=(\w+))?\)/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'reboot', category: 'crash',
    cause: 'host-crash', kb: 'Launcher/src-tauri/src/diagnostics.rs (NOVA-307)',
    key: m => m[1] === 'null' ? `signal:${m[2]}` : m[1],
    classify: m => {
      if (m[1] === 'null') return m[2] === 'SIGTERM' || m[2] === 'SIGKILL'
        ? { status: 'known-benign', severity: 'INFO', title: `Gameserver stopped by the agent (${m[2]})` }
        : { title: `Gameserver killed by signal ${m[2]}` };
      const code = Number(m[1]);
      if (code === 0) return { status: 'known-benign', severity: 'INFO', title: 'Gameserver exited cleanly (code 0)' };
      if (code === 3221225477) return { title: 'Gameserver crashed with an access violation (0xC0000005)' };
      if (code === 3221225786) return { severity: 'P3', title: 'Gameserver was closed (0xC000013A, Ctrl+C / window closed)' };
      if (code === 3) return { title: 'Gameserver exited with code 3 — UE4 critical-error exit, NOT a clean shutdown' };
      return { title: `Gameserver exited with code ${code}` };
    },
    title: 'Gameserver exited',
    explain: 'Exit 3 is UE4\'s GIsCriticalError → RequestExit path (what follows our vectored handler logging a crash); a raw crash shows 3221225477. Read the matching FortniteGame_2.log "=== Critical error: ===" block for the frames.',
  },
  {
    id: 'first-chance-av-known', sources: ['cobalt'], status: 'known-benign',
    re: /first-chance.*(?:0x)?1242250/i,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'crash',
    cause: 'known-first-chance', kb: 'SESSION-HANDOFF.txt §6 G',
    title: 'First-chance access violation at FortniteClient RVA 0x1242250 (known recoverable)',
    explain: 'Logged 8+ times with the server carrying on; a vectored handler sees first-chance exceptions and cannot tell them from fatal ones.',
  },
  {
    id: 'signature-missing-required', sources: ['cobalt'],
    re: /^\s*(?:\d\d:\d\d:\d\d\.\d+\s+)?\s*(\S+)\s+\[required\]\s+MISSING/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'cobalt', category: 'hooking',
    cause: 'signature-coverage', kb: 'BUILD_TARGETS.md',
    key: m => m[1], classify: m => ({ title: `Required hook target ${m[1]} did not resolve on this build` }),
    title: 'A REQUIRED hook signature did not resolve on this build',
    explain: 'Cobalt/Reboot find their targets by byte signature. A required target missing disables the feature that depends on it.',
  },
  {
    id: 'signature-missing-optional', sources: ['cobalt'],
    re: /^\s*(?:\d\d:\d\d:\d\d\.\d+\s+)?\s*(\S+)\s+\[optional\]\s+MISSING/,
    severity: 'P3', confidence: 'CONFIRMED', component: 'cobalt', category: 'hooking',
    cause: 'signature-coverage', kb: 'BUILD_TARGETS.md', key: m => m[1],
    classify: m => ({ title: `Optional hook target ${m[1]} did not resolve on this build` }),
    title: 'An optional hook signature did not resolve on this build',
  },
  {
    id: 'offset-not-found-legacy', sources: ['cobalt'],
    // Exactly "Failed to find3 X". The looser /find3?/ also caught "Failed to find PushWidget" and
    // "Failed to find property 'QuickBars'" on the first run against real logs.
    re: /Failed to find3 (\w+)/,
    severity: 'P2', confidence: 'CONFIRMED', component: 'reboot', category: 'offsets',
    cause: 'unguarded-offsets', kb: KI('trap8-systemic-unguarded-offsets'),
    key: m => m[1], classify: m => ({ title: `Reboot could not find property '${m[1]}' (older log format)` }),
    title: 'Reboot offset lookup failed (older log format)',
    explain: 'GetOffset returns 0 for a missing property, which points at the object\'s vtable — the trap behind three separate crashes. Check the call site guards it.',
  },
  {
    id: 'offset-not-found', sources: ['cobalt'],
    re: /Failed to find property '([^']+)'/,
    severity: 'P2', confidence: 'CONFIRMED', component: 'reboot', category: 'offsets',
    cause: 'unguarded-offsets', kb: KI('trap8-systemic-unguarded-offsets'),
    key: m => m[1], skipIf: m => m[1] === 'QuickBars',
    classify: m => ({ title: `Reboot could not find property '${m[1]}' on this build` }),
    title: 'Reboot property lookup failed on this build',
    explain: 'Each distinct property is one call site that gets offset 0. Harmless only if that site checks for it.',
  },

  // ── NOVA-303: requests escaping to Epic ───────────────────────────────────────────────────────
  {
    id: 'request-escaped-to-epic', sources: ['ue4:client', 'ue4:host'],
    re: /"originatingService"\s*:\s*"(?!nova-backend"|com\.epicgames\.account\.public")([^"]+)"/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'cobalt', category: 'integration',
    cause: 'nova-303', kb: KI('nova-303-request-escape'),
    key: m => m[1],
    title: 'A request escaped Cobalt\'s redirect and reached Epic\'s live servers',
    explain: 'A response stamped by a service Nova never runs. Caused by the VEH page-guard re-arm window. Keyed on originatingService, not CorrId — CorrId was shown unreliable (NOVA-AUDIT-014).',
  },
  {
    id: 'epic-token-rejection', sources: ['ue4:client', 'ue4:host'],
    re: /Token is missing key ID value/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'cobalt', category: 'integration',
    cause: 'nova-303', kb: KI('nova-303-request-escape'),
    title: "Epic's servers rejected a Nova token (\"Token is missing key ID value\") — an escaped request",
    explain: 'Nova\'s own invalid-token message is different ("The token is invalid or has expired."); only Epic says this.',
  },
  {
    id: 'hotfix-batch-discarded', sources: ['ue4:client'],
    re: /OnHotfixCheckComplete 0/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'cobalt', category: 'integration',
    cause: 'nova-303', kb: KI('nova-303-request-escape'),
    title: 'The hotfix batch failed and was discarded (DefaultEngine.ini from Nova not applied)',
    explain: 'UE4\'s hotfix batch is all-or-nothing: one failed file discards all of them, including the DefaultEngine.ini that points the client at Nova (NOVA-305).',
  },
  {
    id: 'hotfix-file-failed', sources: ['ue4:client'],
    re: /Hotfix file \(([^)]+)\) failed to download/,
    severity: 'P2', confidence: 'CONFIRMED', component: 'backend', category: 'integration',
    cause: 'nova-303', kb: KI('nova-303-request-escape'), key: m => m[1],
    title: 'A hotfix file failed to download',
  },

  // ── Login / "Fortnite was not started correctly" ──────────────────────────────────────────────
  {
    id: 'appes-forced-close', sources: ['ue4:client'],
    re: /AppES: closing code|was not started correctly/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'game', category: 'login',
    cause: 'forced-logout', kb: 'Launcher/src-tauri/src/diagnostics.rs (NOVA-301)',
    title: 'Anti-tamper verdict closed the session ("Fortnite was not started correctly")',
    explain: 'Seen with a SUCCESSFUL login followed ~400 ms later by a forced logout. Known causes: XMPP pointed at a dead port (cloudstorage hotfix), or an escaped request discarding the hotfix batch.',
  },
  {
    id: 'force-logout', sources: ['ue4:client'],
    re: /ForceLogout/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'game', category: 'login',
    cause: 'forced-logout', kb: 'memory: cobalt-component (anti-tamper hooks)',
    title: 'The client forced a logout',
    explain: '"ForceLogout Local=false" does NOT mean the server asked for it — the local login state machine did not raise it.',
  },
  {
    id: 'xmpp-wrong-endpoint', sources: ['ue4:client'],
    re: /New XMPP connection configured to Server=\[([^\]]+)\]\s*Port=\[(\d+)\]/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'backend', category: 'config',
    cause: 'xmpp-endpoint', kb: 'memory: nova-coordinator-deploy (CLOUDSTORAGE HOTFIX OVERRIDES LOCAL Engine.ini)',
    key: m => `${m[1]}:${m[2]}`,
    skipIf: m => m[2] === '3551',
    title: 'The client was configured to reach XMPP on the wrong port',
    explain: 'The cloudstorage DefaultEngine.ini hotfix outranks every local config. Port 80 here was the true cause of "Fortnite was not started correctly" for months. Read the served hotfix before touching the launcher.',
  },
  {
    id: 'verifypeer-true', sources: ['ue4:client'],
    re: /bVerifyPeer\s*=\s*true/i, status: 'known-benign',
    severity: 'INFO', confidence: 'CONFIRMED', component: 'launcher', category: 'config',
    cause: 'known-benign', kb: 'memory: launcher-fortnite-args',
    title: 'libcurl logs bVerifyPeer = true at startup (not evidence of a failed Engine.ini patch)',
    explain: 'MEASURED 2026-11-08: present in all 19 logs on the dev PC, including the 2026-09-19 sessions that played full matches. It is printed in the untimestamped prelude, and Cobalt forces CURLOPT_SSL_VERIFYPEER off on every request regardless. An earlier diagnosis used this line as corroboration that the patch had not applied; on its own it does not discriminate.',
  },
  {
    id: 'uac-active', sources: ['ue4:client', 'ue4:host'],
    re: /UACClient initialized/, status: 'known-benign',
    severity: 'INFO', confidence: 'CONFIRMED', component: 'launcher', category: 'anticheat',
    cause: 'uac', kb: 'Launcher/src-tauri/src/carter.rs:815-823',
    title: "Epic's UAC anti-cheat is active (deliberate: -nouac made things worse in 1.5.2 and 1.5.6)",
    explain: 'carter.rs records both attempts and says DO NOT RE-ADD -nouac. Harmless with the VEH curl hook. It matters because UAC\'s code-integrity checks are the leading explanation for the 1.4.3 inline-hook crash — so it is what blocks the inline-hook fix for NOVA-303.',
  },
  {
    id: 'login-invalid-user', sources: ['ue4:client'],
    re: /\[Connected\]\s*->\s*\[InvalidUser\]/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'game', category: 'login',
    cause: 'nova-303', kb: 'memory: cobalt-component (escape window)',
    title: 'Login state dropped from Connected to InvalidUser',
  },

  // ── Crashes, assertions, ensures ──────────────────────────────────────────────────────────────
  {
    id: 'ue4-critical-error', sources: ['ue4'],
    re: /LogWindows: Error: === Critical error: ===/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'game', category: 'crash',
    cause: 'ue4-crash', kb: 'memory: reboot-dll (trust UE\'s symbolicated Critical error)',
    title: 'UE4 recorded a fatal crash ("=== Critical error: ===")',
    explain: 'The authoritative crash record; it resolves Reboot frames to file+line. The Runtime module pairs it with the UE4CC report.',
  },
  {
    id: 'ue4-assertion', sources: ['ue4'],
    re: /Assertion failed:\s*(.+)/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'game', category: 'crash',
    cause: 'ue4-crash', key: m => m[1].slice(0, 120),
    title: 'UE4 assertion failed (check/verify)',
  },
  {
    id: 'ue4-ensure', sources: ['ue4'],
    re: /Ensure condition failed:\s*(.+)/,
    severity: 'P2', confidence: 'CONFIRMED', component: 'game', category: 'crash',
    cause: 'ue4-ensure', key: m => m[1].slice(0, 120),
    title: 'UE4 ensure failed (non-fatal)',
  },

  // ── Networking / replication ──────────────────────────────────────────────────────────────────
  {
    id: 'net-connection-timeout', sources: ['ue4'],
    re: /Connection TIMED OUT|UNetConnection::Tick: Connection TIMED OUT/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'game', category: 'network',
    cause: 'net-timeout', title: 'A network connection timed out',
  },
  {
    id: 'net-failure', sources: ['ue4'],
    re: /(NetworkFailure|TravelFailure|NMT_Failure|PendingConnectionFailure)\b.*?(?:Error|Type|:)\s*([A-Za-z_]+)?/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'game', category: 'network',
    cause: 'net-failure', key: m => `${m[1]}${m[2] ? ':' + m[2] : ''}`,
    title: 'UE4 network/travel failure',
  },
  {
    id: 'listen-failed', sources: ['ue4:host', 'cobalt'],
    re: /(?:Failed to listen|Unable to listen|failed to bind|SocketSubsystem.*bind.*fail)/i,
    severity: 'P0', confidence: 'CONFIRMED', component: 'reboot', category: 'hosting',
    cause: 'listen-failed', title: 'The gameserver could not listen on its port',
  },

  // ── Performance ───────────────────────────────────────────────────────────────────────────────
  {
    id: 'gamethread-hitch', sources: ['ue4'],
    re: /Hitch detected on gamethread \(frame hasn't finished for\s+([\d.]+)ms\)/,
    severity: 'P3', confidence: 'CONFIRMED', component: 'game', category: 'performance',
    cause: 'hitches', metric: m => Number(m[1]),
    title: 'Game-thread hitches',
    explain: 'Count and worst duration are in the data. Client streaming time is open problem B and no server-side timer can fix it.',
  },

  // ── Reboot's own crash handler (cobalt.log) ───────────────────────────────────────────────────
  {
    id: 'reboot-crash-handler', sources: ['cobalt'],
    re: /\[Crash\] unhandled exception (0x[0-9A-Fa-f]+) at (0x[0-9A-Fa-f]+)/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'reboot', category: 'crash',
    cause: 'host-crash', kb: 'memory: reboot-dll (crash handler)',
    // Image bases are 64 KB aligned, so an absolute address ending 2250 sits at an RVA ending 2250 —
    // the low half of the known-recoverable 0x1242250.
    key: m => /2250$/i.test(m[2]) ? 'rva-1242250' : m[2].slice(-5),
    classify: m => /2250$/i.test(m[2])
      ? { status: 'known-benign', severity: 'INFO', title: 'Reboot logged the known-recoverable fault (…2250 = RVA 0x1242250) as a crash' }
      : { title: `Reboot's crash handler caught ${m[1]} at …${m[2].slice(-5)}` },
    title: "Reboot's crash handler caught an exception",
    explain: 'A vectored handler sees first-chance exceptions too, so not every [Crash] line was fatal. Pair it with the UE4CC report of the same time (Runtime module).',
  },
  {
    id: 'first-chance-av-other', sources: ['cobalt'],
    re: /\[Exception\] first-chance (0x[0-9A-Fa-f]+) at 0x[0-9A-Fa-f]+ \(RVA (0x[0-9A-Fa-f]+)\)/,
    skipIf: m => /^0x0*1242250$/i.test(m[2]),
    severity: 'P2', confidence: 'CONFIRMED', component: 'game', category: 'crash',
    cause: 'first-chance', key: m => m[2].toLowerCase(),
    classify: m => parseInt(m[2], 16) > 0x10000000
      ? { severity: 'P2', title: `Crash handler reported RVA ${m[2]} — larger than the game image, so it was measured against the WRONG module` }
      : {},
    title: 'First-chance exception at an RVA other than the known-recoverable one',
    explain: 'RVA 0x19AC958 is the fault frame of the recurring wild-pointer gameserver crash (UE4CC group B). An RVA beyond the exe\'s size means the handler subtracted the exe base from an address inside Project Reboot.dll — its RVA arithmetic should resolve the module first.',
  },

  // ── Bumper, voice, party timing ───────────────────────────────────────────────────────────────
  {
    id: 'bumper-no-media-plugin', sources: ['ue4:client'],
    re: /Cannot play file:\/\/.*bumper\.mp4.*no media player plug-?ins/i,
    severity: 'P3', confidence: 'PROBABLE', component: 'cobalt', category: 'bumper',
    cause: 'bumper-open-retry', kb: 'memory: nova-bumper',
    title: 'The bumper tried to open its video before the media player plug-in was registered',
    explain: 'Cobalt retries OpenSource until the media factory registers (commit 8954e1b), so failed early attempts are expected. A problem only if a session shows this and never "texture reported 854 wide".',
  },
  {
    id: 'bumper-runs-on-gameserver', sources: ['ue4:host'],
    re: /Cannot play file:\/\/.*bumper\.mp4/i,
    severity: 'P3', confidence: 'CONFIRMED', component: 'cobalt', category: 'bumper',
    cause: 'bumper-on-server', kb: 'memory: nova-bumper',
    title: 'The intro bumper tries to play inside the headless gameserver',
    explain: 'Cobalt is loaded into BOTH Fortnite processes, and its trigger (/client/ClientQuestLogin) fires in the -nullrhi server too, which has no media player and no screen. Wasted work at best; the music-mute logic also runs there. The trigger should skip a process started with -nullrhi.',
  },
  {
    id: 'athena-profile-early', sources: ['ue4'], status: 'known-benign',
    re: /GetAthenaLoadoutWithOverrides\(\): MCP is enabled but we were unable to load AthenaProfile/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'mcp',
    cause: 'known-benign', kb: KI('findings-from-the-same-session-that-are-not-ours'),
    title: 'Loadout asked for before the Athena profile was fetched (transient ordering, once per session)',
  },
  {
    id: 'gfesdk', sources: ['ue4'], status: 'not-ours',
    re: /LogGfeSDK.*Failed to create GfeSDK|LogGfeSDK: Warning/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'engine',
    cause: 'not-ours', title: 'NVIDIA GeForce Experience SDK unavailable (driver feature, not Nova)',
  },
  {
    id: 'vivox-unresolved', sources: ['ue4'], status: 'not-ours',
    re: /LogVivoxVoiceChat.*couldn't resolve host/i,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'social',
    cause: 'not-ours',
    title: 'Vivox voice chat cannot reach its servers (not redirected; Nova has no voice service)',
  },
  {
    id: 'party-presence-publish-failed', sources: ['ue4'],
    re: /PublishPartyInfoToPresence failure/,
    severity: 'P3', confidence: 'POTENTIAL', component: 'backend', category: 'social',
    cause: 'party-presence', kb: 'memory: ot65-backend (broadcastPresence skipped the sender)',
    title: 'The client could not publish its party to presence',
    explain: 'Either the documented startup race (before OnLoggedIntoXmpp — harmless) or a regression of the presence self-echo fix (after it — parties invisible). The Root Cause Analyzer compares the timing.',
  },
  {
    id: 'streaming-disk-search', sources: ['ue4'],
    re: /This will hitch streaming because it ends up searching the disk/,
    severity: 'P3', confidence: 'CONFIRMED', component: 'game', category: 'performance',
    cause: 'streaming', title: 'Asset streaming fell back to searching the disk (streaming hitch)',
  },
  {
    id: 'agent-unhandled-route', sources: ['agent'],
    re: /\[UNHANDLED\]\s+(\w+)\s+(\S+)/,
    severity: 'P3', confidence: 'CONFIRMED', component: 'backend', category: 'routing',
    cause: 'unrouted', key: m => `${m[1]} ${m[2].split('?')[0]}`,
    title: 'The local agent received a request for a path it does not route',
  },
  {
    id: 'game-log-carries-token', sources: ['ue4'], status: 'not-ours',
    re: /AuthTicket=eg1~|-AUTH_PASSWORD=(?!eg1~<redacted>)\S{8,}/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'security',
    cause: 'token-leak',
    title: 'UE4 writes the player\'s auth ticket into its own log — redact before sharing a FortniteGame log',
    explain: 'Written by the game, not Nova (LogNet Login/Join request, command line). Tokens expire after 8 hours; the launcher redacts before forwarding.',
  },

  // ── Not ours / known benign (counted so they are never re-investigated) ───────────────────────
  {
    id: 'missing-package-not-in-build', sources: ['ue4'], status: 'not-ours',
    re: /Couldn't find file for package (\S+)/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'assets',
    cause: 'not-ours', kb: KI('findings-from-the-same-session-that-are-not-ours'), key: m => m[1],
    title: 'The game asked for a package that is absent from this build',
    explain: 'Nothing of Nova\'s references these (grepped backend and Reboot). The client asks on its own and continues.',
  },
  {
    id: 'poi-volume-headless', sources: ['ue4:host'], status: 'not-ours',
    re: /AFortPoiVolume::PostInitializeComponents/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'engine',
    cause: 'not-ours', kb: KI('findings-from-the-same-session-that-are-not-ours'),
    title: 'POI volumes have no brush component on the headless server (-nullrhi artifact)',
  },
  {
    id: 'party-startup-race', sources: ['ue4'], status: 'not-ours',
    re: /SendToParty failure|UpdateParty request failure|Failed to update config for party/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'social',
    cause: 'not-ours', kb: KI('findings-from-the-same-session-that-are-not-ours'),
    title: 'Party update attempted before the client\'s own XMPP login completed (client startup race)',
  },
  {
    id: 'corrupt-local-replays', sources: ['ue4:client'], status: 'not-ours',
    re: /Invalid chunk size|Requested read of -\d+ bytes/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'game', category: 'engine',
    cause: 'not-ours', kb: KI('findings-from-the-same-session-that-are-not-ours'),
    title: 'Corrupt local replay files (client-side, cosmetic)',
  },
  {
    id: 'pushwidget-missing', sources: ['cobalt'], status: 'known-benign',
    re: /Failed to find PushWidget/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'cobalt', category: 'hooking',
    cause: 'known-benign', kb: 'memory: cobalt-component (InitializeExitHook dead code)',
    title: 'PushWidget signature never matches on 7.40 (expected; no longer gates the anti-tamper hooks)',
  },
  {
    id: 'assetregistry-getassetsbyclass', sources: ['cobalt'], status: 'known-benign',
    re: /MISSING AssetRegistry\.GetAssetsByClass/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'cobalt', category: 'reflection',
    cause: 'known-benign', kb: 'memory: nova-bumper',
    title: 'AssetRegistry.GetAssetsByClass is not a UFunction on 7.40 (the bumper uses ObjectLibrary instead)',
  },
  {
    id: 'https-443-eacces', sources: ['coordinator'], status: 'known-benign',
    re: /Failed to start HTTPS on port 443.*EACCES/,
    severity: 'INFO', confidence: 'CONFIRMED', component: 'coordinator', category: 'config',
    cause: 'known-benign', kb: 'memory: nova-coordinator-deploy',
    title: 'Coordinator cannot bind :443 as a non-root user (pre-existing, harmless)',
  },

  // ── Launcher / agent / proxy ──────────────────────────────────────────────────────────────────
  {
    id: 'launcher-panic', sources: ['startup'],
    re: /^PANIC: (.+)/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'launcher', category: 'crash',
    cause: 'launcher-crash', key: m => m[1].slice(0, 100),
    title: 'The launcher panicked',
  },
  {
    id: 'webview2-broken', sources: ['startup'],
    re: /CreateWebview.*0x80070002/,
    severity: 'P0', confidence: 'CONFIRMED', component: 'environment', category: 'install',
    cause: 'webview2', kb: 'memory: reboot-dll (distribution debugging)',
    title: 'WebView2 runtime is broken on this machine (FILE_NOT_FOUND creating the webview)',
    explain: 'Repair or reinstall the WebView2 Evergreen Runtime. Not a missing-library problem in the launcher.',
  },
  {
    id: 'proxy-did-not-start', sources: ['startup', 'agent'],
    re: /proxy didn't start|is Node installed\?/i,
    severity: 'P0', confidence: 'CONFIRMED', component: 'proxy', category: 'startup',
    cause: 'proxy-down', kb: 'SESSION-HANDOFF.txt §5 (nova-proxy NUL corruption)',
    title: 'nova-proxy did not start — nothing serves 127.0.0.1:3551',
  },
  {
    id: 'register-secret-503', sources: ['startup'],
    re: /register-secret: coordinator returned HTTP 503/,
    severity: 'P3', confidence: 'CONFIRMED', component: 'coordinator', category: 'security',
    cause: 'register-secret', kb: KI('gameserver-register-unauthenticated'),
    title: 'Launcher got 503 for the registration secret (registered without one)',
    explain: 'Every launch before the 2026-11-08 coordinator fix. After it, a new occurrence means the coordinator could not store its issued secret.',
  },
  {
    id: 'eaddrinuse', sources: ['agent', 'coordinator'],
    re: /EADDRINUSE[^\n]*?:(\d+)/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'backend', category: 'startup',
    cause: 'port-conflict', kb: KI('backend-eaddrinuse-zombie'), key: m => m[1],
    title: 'A backend could not bind its port (another process holds it)',
  },
  {
    id: 'token-in-log', sources: ['startup', 'agent', 'cobalt', 'coordinator'],
    re: /eg1~[A-Za-z0-9._~+\/=-]{20,}/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'launcher', category: 'security',
    cause: 'token-leak', kb: KI('launcher-log-wrote-bearer-token'),
    title: 'A live-format bearer token is written in a Nova log file',
    explain: 'Logs are what players share. Every Nova writer should redact; this line escaped. (The evidence excerpt is redacted.)',
    fix: { summary: 'Find the writer that skipped redaction; then scrub the file.', repairId: 'scrub-tokens' },
  },
  {
    id: 'coordinator-crash-loop', sources: ['coordinator'],
    re: /\[run-nova\].*backend exited (-?\d+) after (\d+)s/,
    severity: 'P1', confidence: 'CONFIRMED', component: 'coordinator', category: 'crash',
    cause: 'coordinator-restarts', kb: 'coordinator/README.md (run-nova.sh backoff)',
    key: m => m[1],
    title: 'The coordinator backend exited and was restarted by run-nova.sh',
  },
];

/** Compile once, validate the catalog shape (a typo in a rule should fail loudly, in a test). */
export function validateRules(rules = RULES) {
  const ids = new Set();
  for (const r of rules) {
    if (!r.id || ids.has(r.id)) throw new Error(`duplicate or missing rule id: ${r.id}`);
    ids.add(r.id);
    if (!(r.re instanceof RegExp)) throw new Error(`${r.id}: re must be a RegExp`);
    if (!Array.isArray(r.sources) || !r.sources.length) throw new Error(`${r.id}: sources required`);
    if (!r.title) throw new Error(`${r.id}: title required`);
  }
  return true;
}
