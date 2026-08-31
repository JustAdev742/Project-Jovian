# PROJECT_MEMORY

Durable technical knowledge that must survive rewrites. Everything here was expensive to learn.
If a future change contradicts an entry, the entry is what to check first.

Companions: [ARCHITECTURE.md](ARCHITECTURE.md) · [VERSION_COMPATIBILITY.md](VERSION_COMPATIBILITY.md)
· [KNOWN_ISSUES.md](KNOWN_ISSUES.md) · [REGRESSION_HISTORY.md](REGRESSION_HISTORY.md) ·
[DEPENDENCIES.md](DEPENDENCIES.md)

---

## 1. Facts that are not visible in the code

1. **7.40 is an MCP/OSS build, not EOS.** The client's own log: `FOnlinePartySystemMcp` ×54,
   `FOnlineIdentityMcp` ×6, `EOS_Initialize`/`ProductUserId` ×**0**. The 1,352-line `eos.routes.ts`
   is therefore **not on 7.40's path**. Do not debug 7.40 through EOS routes.

2. **Every endpoint 7.40 actually calls is already routed.** 34 distinct families, measured from
   3,533 logged URLs against 213 route definitions. Any remaining 7.40 problem is response
   correctness, state, or transport — **not coverage**.

3. **Cobalt is installed by file replacement, not injection.** It is copied over
   `GFSDK_Aftermath_Lib.x64.dll`. Only Reboot is injected. Anyone looking for an injection step for
   Cobalt will not find one.

4. **`FortniteGame.log` is in `%LOCALAPPDATA%\FortniteGame\Saved\Logs\`**, not the build folder. It
   is the *only* place NOVA-303 escapes are visible, and three launcher self-checks look in the wrong
   directory.

5. **The coordinator runs `tsx src/index.ts`, not `dist/`.** There is no `dist/` on the box. A
   previous project note claiming source drift was wrong.

6. **Host-control traffic and game traffic take different paths.** The coordinator is public via
   Tailscale Funnel; the game socket needs real tailnet membership. A machine can pass every
   host-control check and still be unreachable for gameplay. This was the confirmed cross-machine
   failure.

7. **`100.64.0.0/10` is shared CGNAT space.** An address starting `100.` proves nothing about *which*
   tailnet a machine is on. Test tailnet identity, never address shape.

8. **`sendEpicError` does not throw.** It calls `reply.send()` directly, so Fastify's
   `setErrorHandler` never sees deliberate 401/404/400s. Anything that instruments errors must hook
   `sendEpicError` too — this cost a full debugging cycle on 2026-08-31.

9. **`MH_EnableHook((PVOID)0)` is `MH_ALL_HOOKS`.** In MinHook, a null target means *all hooks*. A
   failed signature scan therefore enables everything instead of failing.

10. **Reboot's `crash.log` records exceptions the process survived.** It is installed as a
    *first-chance* vectored handler, which cannot know whether a fault was fatal. Crash triage from
    that file cannot distinguish a crash from a handled exception.

---

## 2. Method — what this project has learned about being right

The 2026-08-15 audit produced 30 findings, 8 claimed P1. Under adversarial verification: **1 survived
at P1**, 3 were refuted outright, 4 downgraded. Including the auditor's own strongest finding, whose
fix was **not shipped** because a skeptic showed it would have made things worse.

That ratio is the most important number this project has produced. The failure mode here is not
missing information — it is **confident wrong answers**.

Practices that follow, and that have each already paid for themselves:

- **A positive signal with a control in the same run.** "The gate did not run" is not "the gate
  passed". Every verification in `REGRESSION_HISTORY.md` includes an unchanged control.
- **Measure, do not estimate.** The log-eviction defect was proven by firing the measured 289 req/min
  and watching a planted marker disappear — not by dividing 800 by 289.
- **State the negative results.** "Every endpoint is routed" redirected the whole 7.40 effort.
- **Prefer the fix that fails safe.** Redaction beat an auth gate because it removes the secret
  rather than moving the boundary, and cannot break a launcher in the field.
- **A fix that cannot fail safe is a deployment decision.** `REGISTER_SECRET` is documented and open
  for exactly this reason. Flag it; do not paper over it.
- **UNKNOWN is a valid answer.** Chapters 2–4 and the live-event system are recorded as UNKNOWN
  because the corpus grades itself as inference. Inventing them would produce exactly the failure
  mode above.

---

## 3. Traps that have already cost time

1. **The catch-all masks everything.** An unrouted `GET` returns `200 {}` and an unrouted `POST`
   returns `204` — indistinguishable from a real empty response. **Always probe a deliberately bogus
   path as a control** before concluding an endpoint works. Since 2026-08-31, `GET
   /nova/api/diagnostics?category=MISSING` answers this directly.
2. **The log buffer wraps in under three minutes** at real traffic rates, and *reading* it used to
   make that worse. Use the diagnostics endpoint for anything that must survive.
3. **Cobalt's banner timestamp is frozen** at `log.cpp`'s compile time. Two different binaries
   self-identify identically. **Identify DLLs by hash.**
4. **`nova-agent.log` is truncated on every launcher start.** Copy it *before* relaunching.
5. **Never share logs unredacted.** `FortniteGame_2.log`, `launcher-startup.log` and `cobalt.log` all
   contain live `eg1~` bearer tokens in cleartext. Strip `eg1~[A-Za-z0-9._-]+` first. (The backend's
   own logs are redacted as of 2026-08-31; **Cobalt's are not.**)
6. **`git` reports directory metadata, not truth.** A "0 byte" `nova-agent.log` was stale NTFS
   metadata for a file held open by a running process. It was 23,003 bytes.
7. **Shrinking `JOIN_WINDOW_MS` looks right and is wrong.** It converts "player B is late" into
   "A and B never play together" by electing B as a second host. See KNOWN_ISSUES "Do not fix these".

---

## 4. The evidence base, and what it does not contain

**Available:** `cobalt.log` (792 KB, 6 launches), `FortniteGame.log` / `FortniteGame_2.log`
(client + gameserver, 2026-08-15), coordinator `nova.log`, Reboot `crash.log` / `baseaddress.log`,
and the research corpus in `Full documentation/` (endpoint documentation, EpicResearch, decompiled
Retrofit service interfaces, AES archive, datamining, map archives).

**Not available, and this is the central gap:**

> **No artifact from the laptop has ever been examined.** Not one log, hash, or `tailscale status`.
> Every cross-machine claim in this project's history is a mechanism read out of PC-side code with
> the laptop-side premise untested.

> **The only end-to-end success on record is the PC connecting to itself** over its own tailnet
> address — no WireGuard peer, no DERP relay, no remote firewall in the path.

The single highest-value experiment remains one instrumented two-machine session with a pre-flight
capture on the laptop. It is specified step by step in `AUDIT_REPORT.md` §6 and **should happen
before any further code is written against the cross-machine question.**

---

## 5. Standing decisions

| decision | why | revisit when |
|---|---|---|
| `/nova/api/*` carries no auth | the launcher reads it locally with no token, and `nova-proxy` keeps it off the coordinator path | anything sensitive is added to it — the redaction is what makes this safe today |
| `REGISTER_SECRET` left fail-open | closing it breaks every launcher in the field | a release is being cut; serve the secret to authenticated launchers first, then flip |
| not-found returns `200 {}` / `204` | the client treats 404 as fatal on several paths | never — instrument instead |
| profile `version` strings are invented (`nova_lawin_ch1s7`) | no client validates them; a real migration name would imply migrations this backend does not perform | a client is found that reads the field |
| no version adapters | 7.40 is the only target; speculative layers become the "pile of conditional hacks" the brief warns against | a second build is actually in use |
| dead dependencies left in place | removing four unverified at once is an unforced risk | one at a time, each with a full build |
