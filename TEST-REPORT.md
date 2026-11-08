# TEST-REPORT

What is verified, how, and what is not. Update with every release. Newest first.

## 2026-11-08 (1.9.4 → 1.9.6, Phase 0)

**Automated, all passing**
- backend `npm test`: 300 tests (incl. pre-warm 5, boot marker 2, doctor 17)
- doctor `node --test doctor/test/*.test.mjs`: 58
- `node doctor/nova-doctor.mjs verify`: all 8 checks PASS (backend tests + typecheck, staging gates,
  method audit 33/33, 7.40 session replay 22/22, launcher ue4log 26, Cobalt emitter + Reboot drift)
- `tools/fleet-e2e.mjs`: coordinator + agent + live doctor with real processes; a 10-line burst arrives
  as one line ×10
- release checks for 1.9.4, 1.9.5, 1.9.6: served `latest.json` = written, signature = `.sig`, zip md5
  = local build

**Verified in played sessions (this PC hosting and playing)**
- fleet doctor: live lines reach the dashboard (1.9.4)
- lobby pre-warm: server elected from the lobby, ready before Play; queue 62s → 22s (1.9.5)
- phantom host player: the server's own controller gets no pawn (1.9.5)
- 60 Hz: `[Nova] NetServerMaxTickRate 60 -> 60` (1.9.6)
- coordinator deploys: content-diffed identical, probes with a bogus-path control

**Failing in played sessions**
- **Loading screen after joining a hosted match: still stuck on 1.9.6.** See KNOWN_ISSUES
  client-stuck-on-loading-screen. Every session on this PC that got past it predates 2026-07-28.

**Not verified**
- anything with two players (parties, duos, global chat between accounts, Solo team damage)
- the injection-on-readiness timing in isolation (it ran; the hang hides whether the match is right)
- any build other than 7.40
- voice (not built)
