# 04: Voice chat in the launcher (research, 2026-11-08)

Fortnite 7.40's own voice chat runs on Vivox, which Nova cannot emulate. So voice has to live in the
Nova launcher, which stays open while the game runs. This report designs real party voice: real audio
between players, push-to-talk while the game has focus, device selection, mute, per-player volume,
honest connection status, and "only my party can hear me". It also gives the order to build it in and
a test plan that proves audio really travels between two machines.

How sure each claim is, using the same grading idea as `00-codebase-audit.md`:

| Tag | Meaning |
|---|---|
| **[repo]** | Seen in this repository's source today, with file:line |
| **[crate]** | Read in the exact dependency source this build compiles (`~/.cargo/registry`, versions from `Cargo.lock`) |
| **[measured]** | Observed on this machine on 2026-11-08 |
| **[doc]** | From the external documentation cited in §13 |
| **[inferred]** | My reasoning; nobody has checked it yet |
| **[SPIKE]** | Must be proven by the Phase 0 two-machine spike (§9) before anything is built on it |

---

## 0. The recommendation in one screen

1. **Use WebRTC inside the launcher's WebView2, with no native audio stack.** Chromium already ships
   Opus, echo cancellation, noise suppression, gain control and a jitter buffer. The WebView2 runtime
   on this PC is 158.0.4370.7 [measured].
2. **Full-mesh peer-to-peer over the tailnet, audio only.** Each pair of party members has one
   `RTCPeerConnection`. ICE uses **only host candidates on the Tailscale interface** (100.64.0.0/10
   and fd7a:115c:a1e0::/48), with no STUN and no TURN in v1. Tailscale already handles NAT traversal
   (direct WireGuard when it can, DERP relay when it can't), so WebRTC only has to reach a 100.x
   address. Audio never touches the coordinator.
3. **The coordinator does signaling and decides who may join.** Add a new WSS route `/nova/voice` on
   the existing Fastify server, reached through the Funnel on :8443 like everything else. Clients
   authenticate with the launcher's existing `eg1~` bearer token, sent as the first message. A voice
   room is **exactly the player's current Fortnite party**, as the coordinator's XMPP server sees it:
   whoever occupies the MUC room `Party-<partyId>`.
4. **Push-to-talk comes from a Rust low-level keyboard and mouse hook** (`WH_KEYBOARD_LL` +
   `WH_MOUSE_LL`). It runs on its own thread, never swallows the key, and has a `GetAsyncKeyState`
   watchdog. Rust tells the UI through a Tauri event, and the UI flips `track.enabled`. Tauri 1's
   `globalShortcut` cannot do this: it reports key presses only, never releases (§6.1).
5. **The microphone permission is granted by Nova, not by a browser prompt.** A `PermissionRequested`
   handler, installed through `Window::with_webview`, grants **Microphone only, and only for the
   app's own origin**. It runs after Nova's own opt-in screen has explained who can hear you.
6. **Two fallbacks, both deferred until measurement says they're needed:**
   - coturn on the coordinator, listening on its tailnet IP, plus Funnel :10000 TLS-terminated TCP
     for players who are not on the tailnet.
   - An SFU (LiveKit on the coordinator's tailnet IP), only if mesh measurably fails.
7. **Two things block shipping:**
   - **The JWT signing secret ships to every player** (§8.1). It is a hard-coded literal, and it is
     inside the compiled backend bundled with every launcher, so anyone can mint a token for any
     account. "Only my party can hear me" cannot be promised until this is fixed.
   - **Parties between two real players have not been verified on 7.40** (§5.3). Voice uses them as
     its source of truth.

---

## 1. What exists in the repo today

Searching for `voice|webrtc|vivox|rtc` across `Launcher/src`, `Launcher/src-tauri/src` and
`Main backend/src` found **no voice implementation anywhere**:

- **Launcher UI:** only false positives. "voice" appears in `theme.css` comments about typography, and
  `AlertCircle` icons match `rtc`.
- **Launcher Rust:** no matches.
- **Backend:** the only hits are the game-facing EOS RTC stubs:
  - `responses/sdkv1.json:568-569` advertises `RTCService.BaseUrl = http://127.0.0.1:3551/rtc`.
  - `services/eos/eos.routes.ts:1154-1163` answers `POST /rtc/v1/:deploymentId/rooms/:roomName/token`
    with a token that points at `ws://127.0.0.1:3551/rtc`.
  - `services/xmpp/xmpp.server.ts:193` lists `/rtc` in `EOS_SOCKET_PREFIXES`, so that socket is held
    open but idle, deliberately kept out of matchmaking (lines 214-224).

  These exist so the game's EOS layer doesn't error. They carry no audio, and nothing in this design
  should reuse them. The game's own voice toggles will keep doing nothing, and the launcher UI must
  not suggest that they control Nova voice. **[repo]**

`00-codebase-audit.md` already lists the launcher as having "no social panel, party UI, … voice".

Facts in the repo that shape the design:

| Fact | Where | Why it matters |
|---|---|---|
| Every HTTP `upgrade` is handed to the XMPP `WebSocketServer`, whatever the path | `xmpp.server.ts:584-589` | A voice socket must be dispatched **before** this handler, or it will be treated as a matchmaker socket |
| The upgrade handler logs `request.url` in full | `xmpp.server.ts:585` | A token in a WSS query string would land in `nova.log`. Send it as a message instead |
| 7.40 parties are "V1": XMPP only, no `/party` HTTP calls | `social.routes.ts:234-237`; `version/features.ts:226-243` | The party roster exists only as XMPP state on the coordinator |
| Party MUCs are named `party-*`; occupancy is keyed by (accountId, resource) | `xmpp.server.ts:440-455` (leave), `:460-495` (join), `:55` (`MUCs` exported) | This is the authority for "who is in this party" |
| The party id is also published in presence (`party.joininfo*.partyId`) | `xmpp.server.ts:635-650`, used at `:671` | A secondary authority if MUC occupancy proves unreliable |
| The launcher session token is an `eg1~` JWT whose `sub` is the **Fortnite** accountId | `auth.ts:16-17`; `launcher.routes.ts:49-53` | The same id the XMPP client uses, so voice and party identities match |
| `verifyToken` checks the JWT signature and nothing else (no revocation) | `token.service.ts:116-123` | See §8.1 |
| `JWT_SECRET` is a literal with no environment override | `config.ts:39` | See §8.1 |
| The coordinator URL is in one place | `novaApi.ts:33` (`https://clientfinder.tail0a8fd0.ts.net:8443`) | The voice WSS URL comes from it |
| The coordinator knows each announced player's tailnet IP | `matchmaking.routes.ts:677` `meshIpFor()` (exported); `:106` `tailnetMemberIps()` (not exported) | Server-side ICE candidate checks |
| The launcher runs elevated (`requireAdministrator`) | `src-tauri/app.manifest` | Push-to-talk hooks see input aimed at the elevated game (§6.5); the launcher can add firewall rules (§4.3) |
| The Tauri allowlist is `"all": true`; CSP is `default-src * 'unsafe-inline' 'unsafe-eval' …` | `tauri.conf.json:15-34,54` | Events and WSS are allowed. The CSP is far too loose for a page that can open the mic (§8.6) |
| Resolved versions: tauri 1.8.2, tauri-runtime-wry 0.14.11, wry 0.24.11, tao 0.16.10, webview2-com 0.19.1 | `Cargo.lock` | The APIs used below were read in exactly these crates |
| "Windows Firewall blocks inbound on the Tailscale adapter by default" (the team's own note) | `tailscale.rs:265-267` | ICE should still work (§4.3), but this needs checking |
| The Tailscale adapter's alias is `Tailscale`; its network category is `Private` | [measured] `Get-NetAdapter` / `Get-NetConnectionProfile` | Lets a firewall rule be scoped to that one interface |
| No anti-cheat runs: the EAC/launcher stand-ins start suspended and the client gets `-nobe` | `main.rs:285-310`, `carter.rs:772-780` | A low-level input hook doesn't risk an anti-cheat flag (§6.5) |

A correction to the launcher-UI memory note: the production build is **not** served from `file://`.
Tauri 1.x on Windows serves it from `https://tauri.localhost` (`tauri-1.8.2/src/manager.rs:404-409`)
**[crate]**. That origin is a secure context, which `getUserMedia` requires. HashRouter is still the
right choice.

---

## 2. Q1: WebRTC inside Tauri 1.5 / WebView2 on Windows

### 2.1 Does `getUserMedia` work?

Yes. WebView2 is Chromium, and the page runs in a secure context:

- `https://tauri.localhost` in production [crate].
- `http://localhost:1420` in dev, because `localhost` counts as potentially trustworthy.

Do **not** set `security.dangerousUseHttpScheme`. It switches production to `http://tauri.localhost`
(`tauri-utils-1.6.2/src/config.rs:1506-1510`) [crate]. Whether getUserMedia would still work there
was not tested. There's no reason to try.

One thing is not known: whether getUserMedia behaves differently in a WebView2 hosted by an
**elevated** process. Nothing turned up either way. **[SPIKE]**

### 2.2 How the microphone permission gets granted

What happens today [crate]:

- wry 0.24.11 registers exactly one `PermissionRequested` handler. It grants
  `COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ` and nothing else (`wry-0.24.11/src/webview/webview2/mod.rs:666-685`).
- A microphone request is left at `COREWEBVIEW2_PERMISSION_STATE_DEFAULT`, which Microsoft describes
  as "the default browser behavior is used, which normally prompt users for decision" [doc].
- So a player would see WebView2's generic "tauri.localhost wants to use your microphone" prompt.

**Why not just let that prompt run.**

- WebView2 persists permission decisions in the profile by default [doc].
- Microsoft warns that once a state is saved, "browser heuristics can affect whether the event
  continues to be raised" [doc].
- So one accidental **Block** could break voice permanently, with nothing in Nova able to undo it.
- The API that would avoid saving the decision (`SavesInProfile`, on
  `ICoreWebView2PermissionRequestedEventArgs3`) isn't in the bindings this build has.
  `webview2-com-sys 0.19.0` only goes up to `…EventArgs2` and `ICoreWebView2Profile2` [crate].

**The recommended handler.** Tauri 1.8 exposes the raw controller (`Window::with_webview` →
`PlatformWebview::controller()`, `tauri-1.8.2/src/window.rs:877,959`) [crate]. Add a second handler
in `setup()`. WebView2 events accept several handlers.

```rust
// Launcher/src-tauri/src/voice_perm.rs  (sketch)
// Cargo.toml: webview2-com = "=0.19.1"  (must equal wry's: controller() returns 0.19 types)
use webview2_com::{take_pwstr, PermissionRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::*};
pub fn install(window: &tauri::Window) {
    let _ = window.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(
            |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                args.PermissionKind(&mut kind)?;
                let mut uri = windows::core::PWSTR::null(); // windows 0.39 (webview2-com's)
                args.Uri(&mut uri)?;
                let origin = take_pwstr(uri);
                let ours = origin.starts_with("https://tauri.localhost")
                    || (cfg!(debug_assertions) && origin.starts_with("http://localhost:1420"));
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && ours {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                } // camera, geolocation, … stay at DEFAULT; never auto-grant them
                Ok(())
            })), &mut token);
    });
}
```

Things to get right with this handler:

- **Consent becomes Nova's job.** Because the handler grants silently, the launcher must not call
  `getUserMedia` until the player has accepted Nova's own voice opt-in (§8.4).
- **Ship it in the same release that first requests the mic.** The launcher has never asked for the
  mic before, so no player has a saved Block yet. Shipping the handler with the first request keeps it
  that way.
- **Windows' own microphone switches still apply.** Settings › Privacy › Microphone, and "Let desktop
  apps access your microphone", can block the mic underneath WebView2. When `getUserMedia` fails with
  `NotAllowedError` or `NotReadableError`, show a specific message and a button that opens
  `ms-settings:privacy-microphone`. **[inferred]** for exactly which error appears; check it in the spike.
- **The windows crate version:** the existing `windows = 0.48` dependency stays. The handler code
  uses webview2-com's `windows 0.39` types, either through a renamed dependency or webview2-com's
  re-exports. **[crate]**

### 2.3 Output device: `setSinkId`

- `HTMLMediaElement.setSinkId()` has been in Chrome since version 49 [doc].
- `AudioContext.setSinkId()` arrived in Chrome 110 [doc].
- WebView2 158 has both.
- **The list of output devices depends on microphone permission.** Without it, Chrome exposes only
  the default devices. After `getUserMedia({audio:true})`, the full list appears [doc].
- So the order is: opt-in, then `getUserMedia`, then `enumerateDevices`.
- On Windows, Chromium also lists `default` and `communications` pseudo-devices [doc]. Show them as
  "System default" and "Windows communications device".

### 2.4 Device labels from `enumerateDevices`

Before permission, labels are empty and only the default devices are listed [doc]. After a
successful `getUserMedia`, every device is listed with its label. Listen to
`navigator.mediaDevices.ondevicechange` to rebuild the pickers, and to handle a headset being
unplugged in the middle of a call (fall back to default and tell the player).

### 2.5 The launcher is in the background for the whole match

While Fortnite has focus, the launcher window is hidden behind it or minimized, and Chromium treats
the page as hidden. What Chrome does to timers then [doc]:

- **Basic throttling:** timers fire at most about once per second while hidden.
- **Intensive throttling does not apply** while WebRTC is in use, meaning an RTCPeerConnection has an
  open data channel or a live MediaStreamTrack.
- **Pages that have played sound in the last 30 seconds** are only minimally throttled.

So:

- **Never drive push-to-talk from a JS timer or polling loop.** Make it event-driven: a Rust event
  delivered with `emit_all`, which wry runs by injecting script. Whether that injection is throttled in
  a hidden page wasn't tested **[inferred]**. Measure keydown-to-`track.enabled` latency with the
  window minimized **[SPIKE]**.
- Keep stats polling (connection quality, speaking indicators) cheap. Accept roughly 1 Hz updates
  while hidden; nobody is looking at the window then anyway.
- When the launcher window is closed, the app exits and voice ends with it (`main.rs:376`). While
  voice is active, closing should minimize instead, or at least warn.

### 2.6 Why not do the audio natively in Rust

`webrtc-rs` plus `cpal` would avoid WebView2's quirks, but it would mean building echo cancellation,
noise suppression, gain control, device handling and Opus integration ourselves. Chromium already has
all of that, maintained. **[inferred]**

### 2.7 `additionalBrowserArgs`

Tauri 1.6's config has `windows[].additionalBrowserArgs`
(`tauri-utils-1.6.2/src/config.rs:1230-1233`) [crate]. **This design doesn't need it.**

- Setting it **replaces** wry's default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
  (`wry …/mod.rs:126-131`), so those would have to be repeated.
- The mDNS switch people reach for (`--disable-features=WebRtcHideLocalIpsWithMdns`) was removed from
  chrome://flags in M91. Its expiry was extended to M120 in 2022, and its current state is unknown [doc].
- Chrome already exposes raw host IPs to a page that holds microphone permission (§4.1), so the switch
  isn't needed.

---

## 3. Q2: Topology, mesh or SFU, for 2–16 people

### 3.1 The options

| | Mesh (P2P) | LiveKit SFU | mediasoup | Janus | Pion |
|---|---|---|---|---|---|
| What it is | Browser-to-browser | Go server built on Pion, a single binary, Apache-2.0 [doc] | A Node library with a C++ worker; we write the signaling [doc] | C server with plugins. AudioBridge **mixes** Opus server-side [doc]; VideoRoom is an SFU | A Go WebRTC library; we'd write the SFU |
| New server software | none | 1 binary + config | npm package; downloads a prebuilt worker, else needs gcc/g++ and Python 3.10+ [doc] | C build with deps | our own Go service |
| Ports | none (tailnet) | 7880 WS, 7881 ICE/TCP, 7882 UDP mux or 50000-60000, optional TURN 3478/5349 [doc] | its own UDP/TCP range | its own range | its own |
| Media depends on the coordinator? | **no** (only signaling) | yes | yes | yes | yes |
| Per-player volume | yes (one track per peer) | yes | yes | **no with AudioBridge** (one mixed stream) | yes |
| Client upload per speaker | N-1 streams | 1 stream | 1 | 1 | 1 |

### 3.2 Bandwidth, worked out

Assumptions **[inferred]**: Opus mono at 32 kbit/s, inside RFC 7587's 28–40 kbit/s "sweet spot" for
full-band speech [doc]; 20 ms packets, so 50 per second.

Bytes per packet:

| Part | Bytes |
|---|---|
| Opus payload | 80 |
| RTP, header extensions and SRTP tag | about 34 |
| UDP and IPv4 | 28 |
| WireGuard (outer IPv4 + UDP + header + tag) | 60 |
| **Total** | **about 200 B, so about 80 kbit/s per stream on the wire** |

What that means:

- **Mesh, 16 people, while you talk:** about 15 × 80 = 1.2 Mbit/s upload. Download is only the people
  currently talking.
- **Silence:** push-to-talk is the default and DTX is on, so idle streams send almost nothing.
- **A realistic 4-person squad:** about 240 kbit/s upload while talking.
- **SFU on the coordinator:** it would have to send N×(N-1) streams for everyone talking at once. Two
  people talking in a 16-person party is about 2.4 Mbit/s up; all 16 talking is about 19 Mbit/s up.
  That has to come out of a home connection, on a box whose Ethernet link flaps (13 carrier losses in
  14 days, per the coordinator memory note). Every flap would cut voice for every party at once.

### 3.3 Recommendation: mesh

- **No new server.** Nothing changes on the coordinator except signaling.
- **Survives coordinator outages.** Once a call is connected, the coordinator can drop and audio keeps
  flowing. Only joins and re-negotiations wait for it to come back.
- **Audio never touches a server.** Nothing to record, and nothing on the coordinator ever sees
  plaintext audio.
- **NAT traversal is already solved** by the tailnet that Nova already requires for multiplayer.
- **The cost is acceptable:** about 1.2 Mbit/s up while talking in a 16-person party, and
  roughly 0.2 Mbit/s in a squad. The usual "mesh only scales to 3–5 people" rule of thumb is about
  video [doc]. Audio with push-to-talk and DTX is about an order of magnitude lighter **[inferred]**.

**When to move to an SFU.** Measure the 16-person case (§10.7). If upload while talking, CPU, or
connection setup time is unacceptable on the weakest realistic player PC (for example, one that is
also hosting a Reboot server), add **LiveKit**:

- Run it on the coordinator, bound to its **tailnet** IP (`rtc.node_ip: 100.96.188.28`, UDP mux 7882,
  ICE/TCP 7881 for clients that can't use UDP).
- Mint LiveKit join tokens from the same `/nova/voice` party check.
- The client's audio module should hide whether it's talking to a mesh or an SFU, so this swap doesn't
  touch the UI.

Why LiveKit over the others: it's one binary, it falls back to TCP, and it has its own client SDK.
mediasoup means writing far more code ourselves. Janus AudioBridge would make per-player volume
impossible.

---

## 4. Q3: NAT traversal

### 4.1 Can peers use their Tailscale IPs directly, as host candidates?

Yes, in principle. **[SPIKE]** before anything depends on it.

- Tailscale gives each device an address on a real network interface, from 100.64.0.0/10 [doc] and
  fd7a:115c:a1e0::/48 [doc].
- Chromium gathers host candidates on every interface except loopback by default. VPN adapters are
  skipped only when an app sets `ADAPTER_TYPE_VPN` in the ignore mask [doc].
- One project reports that desktop Chrome and Firefox find the Tailscale interface and connect
  directly over the WireGuard tunnel [doc].
- There's also a counter-report: Janus over Tailscale failed for one PiKVM user, and the thread was
  never resolved [doc]. So this has to be proven on the two real machines.

**The mDNS catch.** Chrome hides private IPs behind random `.local` mDNS names, **unless the page holds
camera or microphone permission** [doc].

- Mesh voice needs the mic anyway, so after opt-in the 100.x addresses show up as raw host candidates.
- `.local` names can't be resolved across a tailnet (mDNS is local multicast). Drop them.
- A peer listening without mic permission still connects: its connectivity checks reach the other
  side's raw 100.x address, and that side learns a peer-reflexive candidate [inferred]. That only
  fails if neither side has mic permission, and then nobody can be heard anyway.

### 4.2 Candidate policy

The same rules apply on the client and on the server.

```ts
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;        // 100.64.0.0/10
const TAILNET_V6 = /^fd7a:115c:a1e0:/i;                              // fd7a:115c:a1e0::/48
const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle",
                                   rtcpMuxPolicy: "require", iceCandidatePoolSize: 0 });
// send only candidates whose address matches; drop host candidates on LAN/public IPs and *.local
```

- **No STUN.** Public STUN would gather the player's **public IP**, and every party member would see
  it. It also isn't needed on the tailnet.
- **Server side:** the `/nova/voice` relay throws away any `candidate` message, and any `a=candidate`
  SDP line, whose address isn't a tailnet address. Optionally it also requires the address to match the
  sender's announced IP (`meshIpFor`), or to be in `tailnetMemberIps()`. Then a buggy or modified
  client still can't hand its LAN or public addresses to strangers.
- **Send the description straight away.** Trickle ICE means the description sent right after
  `setLocalDescription()` usually has no candidates in it. Usually isn't always, so the SDP scrub
  above is the backstop.

### 4.3 Windows Firewall

- The team's own note says Windows Firewall blocks inbound on the Tailscale adapter by default
  (`tailscale.rs:265-267`).
- ICE sends connectivity checks in **both directions at once**. Windows Firewall is stateful, so each
  side's outgoing check normally lets the other side's matching packets back in. That's why WebRTC
  usually works across host firewalls **[inferred]**.
- If the spike shows ICE failing on the tailnet, the launcher (already elevated) can add a narrowly
  scoped rule:
  `New-NetFirewallRule -DisplayName "Nova Voice (tailnet UDP)" -Direction Inbound -Protocol UDP -InterfaceAlias Tailscale -RemoteAddress 100.64.0.0/10 -Action Allow`
  It's limited to the `Tailscale` interface [measured] and to tailnet sources.
- Don't key the rule on `msedgewebview2.exe`: its path changes with every runtime update.
- A firewall **block** rule beats an allow rule [doc]. If a Windows "allow access?" dialog ever
  appears for `msedgewebview2.exe` and the player clicks Cancel, check what that does. **[SPIKE]**

### 4.4 Tailscale ACLs

- A new tailnet's default policy "enables communication between all devices" [doc].
- If the Nova tailnet's policy has been narrowed (say, to the gameserver's UDP 7777 only), WebRTC's
  random ports will be blocked.
- **Action:** read the policy file in the admin console and confirm player devices can reach each
  other on any UDP port. If it's narrowed, add a grant for UDP between player devices.

### 4.5 DERP relays

- When two players can't connect directly, Tailscale relays their traffic through DERP. DERP is the
  last resort, used "due to hard NAT, firewalls, or another reason" [doc].
- WebRTC doesn't notice; the only effect is more latency and jitter.
- Optionally the launcher can run `tailscale status --json` and show "relayed" next to a peer. That's
  honest, but not required for v1.

### 4.6 TURN: needed? Possible through Funnel?

**Not needed for players on the tailnet.** It only helps two groups:

- players whose Tailscale is broken or missing (`ts_status` → offline);
- the rare case where a host firewall still blocks the 100.x path.

**It can run through Funnel over TCP/TLS:**

- Funnel listens only on 443, 8443 and 10000 [doc]. 443 and 8443 are already taken by the backend;
  **10000 is free**.
- Funnel offers `--tls-terminated-tcp=<port> tcp://localhost:<port>` [doc]. It terminates TLS with
  its valid certificate and forwards plain TCP. A browser's `turns:` client talks TLS to Funnel, and
  coturn sees plain TURN over TCP.
- Chrome only uses TCP between itself and the TURN server; the relay leg is always UDP [doc]. That's
  fine here, because the relay lives on the coordinator.

**Caveats:**

- "Traffic sent over a Funnel is subject to non-configurable bandwidth limits" [doc].
- TCP adds head-of-line blocking.
- Funnel routes TLS by SNI. Chrome's TURN-over-TLS client has to send SNI. **[SPIKE]**
- `tailscale` isn't on admin_home's PATH and sudo needs a password and a TTY (coordinator memory
  note), so **the user has to run the Funnel command themselves**.

```ini
# /etc/turnserver.conf on the coordinator (sketch; options from coturn's example config)
listening-ip=127.0.0.1          # Funnel :10000 --tls-terminated-tcp → here (TCP)
listening-ip=100.96.188.28      # tailnet clients (UDP+TCP)
listening-port=3478
relay-ip=100.96.188.28          # relayed addresses are tailnet addresses → tailnet peers can reach them
no-tls
no-dtls
fingerprint
use-auth-secret
static-auth-secret=<random 32+ bytes, same as NOVA_VOICE_TURN_SECRET>
realm=nova
denied-peer-ip=0.0.0.0-255.255.255.255      # deny everything…
allowed-peer-ip=100.64.0.0-100.127.255.255  # …except tailnet (allowed wins when both match)
no-multicast-peers
user-quota=4
total-quota=200
max-bps=64000
min-port=49160
max-port=49200
```

**Credentials use the TURN REST scheme** (`username = "<expiry>:<accountId>"`,
`password = base64(HMAC-SHA1(secret, username))`) [doc]. The coordinator issues them in the `welcome`
message, valid for 10 minutes, only after the party check.

The peer allow-list means the relay **can't be used as a proxy into the coordinator's LAN**. If both
ends are relayed, traffic hairpins inside coturn between two tailnet addresses.

---

## 5. Q4: Signaling on the coordinator

### 5.1 Where the route lives

`/nova/voice` on the coordinator's existing HTTP server. The same Funnel :8443 path already carries
the matchmaker WebSocket, which is verified working through Tailscale (coordinator memory note).

The backend already depends on `ws` 8.x and uses it directly (`package.json`), so **no new
dependency**. Don't add `@fastify/websocket`: it would fight with the existing raw `upgrade` listener.
Dispatch the voice path first instead:

```ts
// xmpp.server.ts attachXmppWebSocket(), at the top of the 'upgrade' listener (line 584)
const pathname = (request.url || '/').split('?')[0];
if (pathname === '/nova/voice') { voiceUpgrade(request, socket, head); return; } // before logging url
```

`voiceUpgrade` uses its own `new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })`.

Only the coordinator needs this route. Host-agent bundles will contain the code but never receive
voice connections.

### 5.2 Authentication

- A browser `WebSocket` can't set an `Authorization` header (the constructor only takes a URL and
  subprotocols) [doc].
- A token in the query string would be logged by `xmpp.server.ts:585`, and possibly by Funnel.
- So: **the first message must be `hello` carrying the token, within 5 seconds**, or the server closes
  with code 4401.
- The server runs `verifyToken`, which requires `t === 'eg1'` and `ic === false`, and takes
  `accountId = sub`.
- **One voice session per account.** A new `hello` closes the older socket with 4409 "replaced".
- When the token's `exp` passes, the server sends `reauth-required`. Within 60 seconds the client
  either sends `reauth {token}` or gets closed.

### 5.3 Who may join which room

- A player may join `party:<id>` only if the coordinator's XMPP has **some resource of that account
  currently occupying the MUC `Party-<id>`** (case-insensitive, matching the `party-` handling at
  `xmpp.server.ts:440`).
- The client never names the room. On `join {}` the server works out the party itself. The client can
  only ask to join **its own** current party.
- Add a small `EventEmitter` to `xmpp.server.ts` that emits `partyJoin` and `partyLeave` with
  (accountId, roomName) from three places: the MUC join path (`:460-495`), the explicit unavailable
  path (`:440-455`) and `removeClient` (`:652-689`).
- On `partyLeave`, the voice server immediately sends `kicked {reason:"left-party"}` to that account,
  and `peer-left` to everyone else, who tear down their peer connections. Leaving the Fortnite party
  ends voice with that party within about a second.
- A sweep every 10 seconds re-checks every room member against `MUCs`, in case an event was missed.
- A room holds at most 16 accounts, matching the party `max_size: 16` (`social.routes.ts:282`).
- Joining requires the game to be running and in a party. Every Fortnite player is always in a party
  of at least one, so a party of one gets an honest "only you are here" state.

**Dependency risk.** `00-codebase-audit.md` lists party depth as "unmeasured". Phase 0 must show that
when two real players party up in 7.40, both of their accounts appear in the same `Party-*` MUC on the
coordinator. If parties don't form between players, voice has no source of truth for membership.

Fallbacks, in order:

1. The partyId in presence (`extractPartyId`, `:635`). The client publishes it even when the MUC
   misbehaves.
2. A launcher-side "voice room" joined with a one-time invite code. Still opt-in and still private,
   but it is no longer "party".

### 5.4 Message schema (version 1)

```ts
// Shared by Main backend/src/services/voice/voice.protocol.ts and Launcher/src/voice/protocol.ts
type AccountId = string;                       // 32-hex Fortnite account id
type PeerState = { muted: boolean; deafened: boolean };
type Peer = { accountId: AccountId; displayName: string } & PeerState;

// client → server
type C2S =
  | { t: "hello";  v: 1; token: string; client: { launcher: string } }   // must be first, ≤5 s
  | { t: "reauth"; token: string }
  | { t: "join" }                                   // join MY current party's room; server decides
  | { t: "leave" }
  | { t: "state";  muted: boolean; deafened: boolean }                  // ≤ 4/s
  | { t: "signal"; to: AccountId; sdp?: { type: "offer" | "answer"; sdp: string };   // ≤ 16 KiB
                     candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }
  | { t: "ping";   n: number };

// server → client
type S2C =
  | { t: "welcome"; accountId: AccountId; displayName: string; maxPeers: 16;
      iceServers: RTCIceServer[] /* [] in v1; TURN creds later */ }
  | { t: "party";  partyId: string | null; members: number }   // pushed on every MUC change
  | { t: "joined"; room: string; self: Peer; peers: Peer[] }   // newcomer offers to each of `peers`
  | { t: "peer-joined"; peer: Peer }
  | { t: "peer-left";   accountId: AccountId; reason: "left" | "left-party" | "disconnected" | "replaced" }
  | { t: "peer-state";  accountId: AccountId } & PeerState
  | { t: "signal";  from: AccountId; sdp?: { type: "offer" | "answer"; sdp: string };
                    candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }
  | { t: "kicked";  reason: "left-party" | "replaced" | "token-expired" | "rate-limited" }
  | { t: "reauth-required"; inSeconds: number }
  | { t: "error";   code: "not-in-party" | "room-full" | "bad-message" | "not-in-room" | "rate-limited"; message: string }
  | { t: "pong";    n: number };
```

Close codes: 4400 bad message, 4401 unauthenticated, 4403 forbidden, 4408 auth timeout, 4409
replaced, 4429 rate limited.

`signal` is relayed **only between two members of the same room**, after the candidate and SDP
scrubbing in §4.2.

### 5.5 Negotiation

- Use the W3C "perfect negotiation" pattern [doc].
- The **polite** peer is the one with the lexicographically larger accountId. Both ends compute this
  with no coordination, so offer collisions ("glare") always resolve the same way.
- The newcomer creates an offer to every peer listed in `joined`.
- If `iceConnectionState` becomes `failed`, call `pc.restartIce()`. After 3 failed restarts, show
  "Can't reach <name>" and keep retrying with backoff.
- When the signaling socket reconnects: send `hello`, then `join`. Keep any peer connection that is
  still `connected`. Rebuild the rest.

### 5.6 Keepalive and reconnect

- The server sends a `ws` ping frame every 20 seconds and terminates a socket after 2 missed pongs.
- The client reconnects with jittered exponential backoff: 1, 2, 4, 8, 15, 30 seconds.
- Show "Voice server: reconnecting…" honestly while that happens. Audio between already-connected
  peers keeps flowing.

### 5.7 What must never be logged

Never log SDP or candidates: they contain addresses. Log counts and states only, for example
`[Voice] 3/4 peers connected in party:ab12…`.

---

## 6. Q5: Push-to-talk while the game has focus

### 6.1 Tauri 1.x `globalShortcut` can't do push-to-talk

- `@tauri-apps/api/globalShortcut.register(shortcut, handler)` is built on tao's `ShortcutManager`.
  On Windows, that calls `RegisterHotKey` with `MOD_NOREPEAT`
  (`tao-0.16.10/src/platform_impl/windows/global_shortcut.rs:27-50`). The event loop reacts only to
  `WM_HOTKEY` (`event_loop.rs:250`) [crate].
- **It fires on press only.** There is no key-up. The maintainers confirmed this in issue #4364,
  blaming "limitation of the used win32 API", and closed it as "Added in v2" [doc].
- A key registered with `RegisterHotKey` is taken by the hotkey system rather than delivered to the
  focused window [inferred], so binding push-to-talk to a key the game also uses would take that key
  away from the game. **[SPIKE]**
- Mouse buttons can't be registered at all. Side buttons are the most common push-to-talk binding.
- **Verdict:** at most, use it for toggle actions on modifier chords (toggle mute, toggle deafen).
  Simpler still: run those through the same hook as push-to-talk.

### 6.2 Raw input is the wrong tool here

- Microsoft recommends raw input over low-level hooks in general [doc].
- **But** "only one window per raw input device class may be registered to receive raw input within a
  process (the window passed in the last call to RegisterRawInputDevices)" [doc].
- tao already registers keyboard and mouse raw input for the Tauri window
  (`tao-0.16.10/src/platform_impl/windows/raw_input.rs:135-147`) [crate]. A second registration would
  silently take it over, or tao would take it back.
- Tauri 1 doesn't pass tao's `DeviceEvent`s through to application code either.

### 6.3 Recommended: low-level hooks plus a watchdog (`Launcher/src-tauri/src/voice_ptt.rs`)

```rust
// Cargo.toml: windows 0.48 features += "Win32_UI_WindowsAndMessaging",
//             "Win32_UI_Input_KeyboardAndMouse", "Win32_System_LibraryLoader"
static BIND: AtomicU32 = AtomicU32::new(0);      // VK code, or 0x10000|XBUTTON1/2 for mouse
static DOWN: AtomicBool = AtomicBool::new(false);
// thread "nova-ptt": SetWindowsHookExW(WH_KEYBOARD_LL, kb_proc, hinst, 0)
//                    SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, hinst, 0)
//                    loop { GetMessageW(...) }          // the hook needs a message loop on THIS thread
unsafe extern "system" fn kb_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
        if k.vkCode == BIND.load(Relaxed) {
            let down = matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            if DOWN.swap(down, Relaxed) != down { let _ = TX.get().unwrap().try_send(down); } // no work here
        }
    }
    CallNextHookEx(HHOOK::default(), code, w, l)   // ALWAYS pass through: the game still gets the key
}
// thread "nova-ptt-emit": rx.recv() → app.emit_all("voice://ptt", { down, at_ms })
// watchdog (every 200 ms while DOWN): if GetAsyncKeyState(vk) & 0x8000 == 0 → force up + emit;
//   if the key is physically down but the hook never reported it for >300 ms → assume the hook was
//   silently removed and reinstall it.
// commands: ptt_set_binding(code), ptt_capture_next() (listens for the next key/button), ptt_status()
```

Why each piece is there:

- **The hook needs a message loop** on the thread that installed it [doc].
- **The callback must return quickly.** If it takes longer than `LowLevelHooksTimeout`, capped at
  1000 ms on Windows 10 1709 and later, "on Windows 7 and later, the hook is silently removed without
  being called. There is no way for the application to know whether the hook is removed" [doc].
  So the callback only does an atomic swap and a non-blocking send.
- **The watchdog keeps the mic from getting stuck open** (a privacy failure) and repairs a silently
  removed hook. `GetAsyncKeyState` can't be called inside the callback, because the async key state
  hasn't been updated yet at that point [doc]. It's fine from the watchdog thread.
- **Mouse side buttons** arrive as `WM_XBUTTONDOWN`/`UP`, with `HIWORD(mouseData)` set to
  `XBUTTON1` or `XBUTTON2`.
- **Why not the `rdev` crate.** Its Windows listener resolves a character name inside the hook
  callback on every key press, under a global mutex, and pumps messages with a single blocking
  `GetMessageA` [doc]. That's work we don't want inside a callback with a 1-second budget. A focused
  60-line hook avoids it.

### 6.4 Anti-cheat and game focus

| Concern | Status |
|---|---|
| Anti-cheat flagging hooks | Nova runs no anti-cheat. The EAC stand-in starts suspended, and the client gets `-nobe` (`main.rs:285-310`, `carter.rs:772-780`) [repo]. Low-level hooks are also the standard push-to-talk method used by voice apps on Windows [inferred]. |
| Elevation mismatch (UIPI) | The launcher is `requireAdministrator` and starts the game itself, so both run at the same integrity level and the hook sees input aimed at the game [repo]. Discord documents that push-to-talk fails when the game runs as administrator and Discord does not [doc]. **If the launcher ever drops admin, push-to-talk breaks.** Add a regression test. |
| Exclusive fullscreen | Low-level hooks are called before input reaches any window, so fullscreen makes no difference [doc: "every time a new keyboard input event is about to be posted into a thread input queue"]. |
| Secure desktop (UAC prompt, Ctrl+Alt+Del, lock screen) | The hook receives nothing there. The watchdog releases push-to-talk. |
| Key shared with a game action | The hook passes the key through, so both work. The settings UI should say so ("the game will still see this key"). |
| Feedback while in game | The launcher can't draw over the game, and drawing would mean injecting into it, which we won't. Instead, play short on/off sounds through the chosen output, as an option, and show state in the status ribbon. |

### 6.5 The JavaScript side

- Push-to-talk down: set `localTrack.enabled = true`. It takes effect immediately and the same track
  feeds every peer connection.
- Push-to-talk up: set `enabled = false` after a **200 ms release tail**, so the last word isn't cut.
- **Mute always wins over push-to-talk.** Deafen = mute + mute every remote `<audio>` element.
- Use `enabled = false` rather than `replaceTrack(null)`: re-enabling is instant and needs no
  renegotiation.
- With `usedtx=1` (§7.4), a disabled track sends almost nothing.

---

## 7. Q6: The audio pipeline: per-player volume, speaking detection, echo and noise

### 7.1 Capture

```ts
getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
```

- Changing microphone mid-call: get a new track, then `sender.replaceTrack(newTrack)` on every peer
  connection. No renegotiation needed.
- While **not** in a room, stop the track, so Windows' "microphone in use" indicator is honest.

### 7.2 Playback and per-player volume

- **One `<audio autoplay>` element per peer**, with `srcObject = remoteStream`.
- Its `volume` (0–1) is the per-player slider. Remember it per accountId in `localStorage`.
- Call `setSinkId(outputId)` on each element.
- **Why not route remote audio through Web Audio:** Chrome has a long-standing bug where a remote
  WebRTC stream fed into `createMediaStreamSource` is **silent** unless it's also attached to a media
  element (crbug 933677) [doc]. Firefox has also documented echo-cancellation reference problems when
  output goes to a non-default device [doc]. Chrome's behaviour there isn't documented, so check echo
  with speakers in the test plan.
- Boosting above 100% isn't required. If it's wanted later, use a `GainNode` per peer, and keep the
  element attached (muted) as the workaround for the silence bug.

### 7.3 Speaking indicators and voice activity

- **Remote speakers:** poll `receiver.getSynchronizationSources()[0].audioLevel` (0–1, where 1.0 =
  0 dBov) at 10 Hz while the window is visible [doc]. Show "speaking" above about 0.02, with a 300 ms
  hold. No Web Audio needed.
- **Local mic meter and optional voice-activation mode:** `AnalyserNode` on the local stream (local
  capture works fine in Web Audio). Compute RMS each frame. Open when above a threshold the player
  sets, with a 300 ms hang-over before closing. Run the gate with `requestAnimationFrame` while
  visible, and `setInterval(…, 20)` while hidden.

  **Caution:** background throttling (§2.5) makes timer-driven voice activation unreliable while the
  game has focus. That's another reason **push-to-talk is the default mode**. If voice activation is
  offered, its loop has to be measured with the window hidden **[SPIKE]**.

### 7.4 Opus settings

- `sender.setParameters({ encodings: [{ maxBitrate: 32000, priority: "high" }] })`.
- Edit the SDP before `setLocalDescription` to add `usedtx=1` to the Opus `fmtp` line, alongside
  Chrome's default `useinbandfec=1;minptime=10`. Mono is the default (`stereo=0`) [doc].
- DTX makes silence and disabled push-to-talk nearly free.
- FEC hides some of the loss when traffic goes through DERP.

### 7.5 What echo cancellation and noise suppression can't do

- **Chrome's echo canceller can only cancel audio that Chrome itself plays.** One developer reports
  that with "chrome-wide echo cancellation", all audio produced inside Chrome is filtered [doc]. That
  covers your teammates' voices. **Fortnite's own sound comes from another process**, so on speakers it
  reaches the mic and only noise suppression stands between it and your teammates.
- **What to tell players:** use a headset. Push-to-talk is the default, so game audio only leaks while
  you're holding the key.
- **Windows "communications" ducking:** Windows can turn other sounds down when a communications
  stream opens. Chromium has history here: the `googDucking` constraint, and a `communications`
  device [doc]. If Fortnite gets quieter when voice starts, the fix is avoiding the communications
  device, plus documenting Sound › Communications › "Do nothing". **[SPIKE]**

---

## 8. Q7: Security and privacy

### 8.1 Blocker: the token-signing secret ships to every player

- `config.ts:39` is `JWT_SECRET: 'nova-backend-secret-key-change-in-production'`, with **no
  environment override**. Nothing else in `src/` assigns it.
- The same literal is compiled into
  `Launcher/src-tauri/resources/Backend-Coordinator/dist/config.js`, which ships in every installer
  (found by grep today). [repo]
- `verifyToken` (`token.service.ts:116-123`) checks only the HS256 signature.
- **So anyone with the launcher can mint a valid coordinator token for any accountId**, and from there
  impersonate a party member in voice, or do anything else that account can do.
- This predates voice, and it isn't recorded in `KNOWN_ISSUES.md` or `AUDIT_REPORT.md`. Voice's
  privacy promise rests on it being fixed.
- **Minimum fix:**
  1. Read `NOVA_JWT_SECRET` from the environment on the coordinator, with a random value in its `.env`.
  2. Keep the literal only as a local-dev default.
  3. Everyone signs in again once.
- If anything outside the coordinator needs to **verify** coordinator tokens (to check: the host agent
  doesn't appear to), move to asymmetric signing (EdDSA or RS256), where only the coordinator holds the
  private key.
- Track it as its own item; don't fold it silently into the voice work.

### 8.2 Authorization rules

1. Nothing is processed before an authenticated `hello`. Auth timeout 5 s.
2. Access tokens only (`t: 'eg1'`, `ic: false`). Client-credential tokens are refused.
3. Joining is decided by the server from XMPP party membership; there are no client-chosen room ids.
   Party membership is re-checked on every party event and every 10 s.
4. `signal` goes only to members of the sender's own room, and only after tailnet-address scrubbing.
5. One session per account. 16 members per room.
6. Every message is validated by hand, in the style of the existing `doctor.validate.ts` (no new
   dependency): known keys, types, length caps, accountId format `^[0-9a-f]{32}$`.

### 8.3 Rate limits

Everything reaches the coordinator from `127.0.0.1` through the Funnel, so **limits per IP address
mean nothing**. Limit per account and globally.

| Limit | Value |
|---|---|
| Unauthenticated sockets at once (global) | 64; the rest are closed immediately |
| Messages per socket | token bucket, 20/s, burst 60 → 4429 |
| `join` | 10 per minute per account |
| `state` | 4/s |
| Candidates | 64 per peer per negotiation |
| SDP size | ≤ 16 KiB; `maxPayload` 64 KiB |
| `hello` attempts | 10 per minute per account (once the token decodes) |
| Rooms per account | 1 |

### 8.4 Privacy defaults

- **Voice is off until the player opts in.** The first-run card says, in plain words:
  - your microphone is used only while you're in voice;
  - **only the people in your current Fortnite party can hear you**;
  - audio goes directly between players over the Nova network and is never sent to or stored on the
    Nova server.
- **Push-to-talk is the default**, not an open mic.
- **Joining is manual by default.** "Automatically join my party's voice" is an opt-in setting.
  **Changing party always leaves the old room and never auto-joins the new one** unless that setting is
  on. A party change must never quietly open your mic to new people.
- **"Who can hear you" is always visible:** the room's exact members, each with live connection state.
  No placeholder rows.
- **Mute state survives restarts.** When the player isn't in a room, the mic track is stopped.
- **No recording anywhere,** and no SDP or candidates in logs or in forwarded diagnostics. The redactor
  in `ue4log.rs`/`dbg_log` should learn the 100.x pattern before any voice line reaches it.

### 8.5 Threats

| Threat | Mitigation |
|---|---|
| Forged token (§8.1) | Fix the secret first. Without that, everything else here is decorative |
| Joining someone else's party room | Room is derived by the server from MUC occupancy; no client-chosen room ids |
| Leaking LAN or public IPs to party members | No STUN, tailnet-only candidates, filtered on client and server |
| Server swapping SDP to sit in the middle | The coordinator is trusted already. DTLS fingerprints travel in the SDP. Optional later: show a short "safety code" derived from both fingerprints |
| Using TURN as an open proxy (if added) | Peer allow-list limited to tailnet, short-lived REST credentials, quotas |
| Flooding signaling | Caps in §8.3, `maxPayload`, auth timeout, 1 room per account |
| Mic left open by a missed key-up | Hook watchdog, mute-wins rule, stop the mic track on leave or kick |

### 8.6 Tighten the CSP before the mic goes live

`default-src * 'unsafe-inline' 'unsafe-eval'` lets any injected script use a mic that has been granted
silently.

- Move to `script-src 'self'` at least, and `connect-src` listing `'self'`, the coordinator's
  `https:`/`wss:` origin, `http://127.0.0.1:3551` and `:3552`.
- Chromium's `*` does cover `ws:` and `wss:` [doc], so the current CSP **won't block** the voice
  socket. Spell the socket out anyway.

---

## 9. Implementation plan

### Phase 0: Spike and go/no-go (two real machines, about 1 day)

Prove the uncertain parts with throwaway code: a minimal page in the launcher, plus a 50-line signaling
relay on the coordinator or on one player PC.

| Check | Pass condition |
|---|---|
| Mic in an elevated WebView2, with the Rust permission handler | `getUserMedia` resolves with no prompt; device labels present |
| Tailnet host candidates | Raw `100.x` host candidates appear after mic permission; the selected candidate pair is 100.x ↔ 100.x |
| Firewall | ICE connects with no new firewall rule. If not, the scoped rule from §4.3 fixes it |
| Audio really flows | Test tone detected on the far end (§10.3, step 4) |
| Push-to-talk with Fortnite fullscreen focused | Hook sees down and up; game still receives the key; latency to `track.enabled` measured with the launcher minimized |
| Party authority | Two accounts in one in-game party show up in the same `Party-*` MUC on the coordinator |
| Ducking | Fortnite's volume doesn't drop when the mic opens (or the fix is found) |

If party authority fails, choose a fallback from §5.3 before Phase 1.

### Phase 1: Coordinator (backend)

New files under `Main backend/src/services/voice/`:

| File | Contents |
|---|---|
| `voice.protocol.ts` | The message types from §5.4 and hand-written validators |
| `voice.rooms.ts` | Pure room registry: join, leave, membership, caps. Easy to unit-test |
| `voice.party.ts` | Party lookup from `MUCs` (`party-*`, case-insensitive); subscribes to the XMPP party events |
| `voice.ice.ts` | Tailnet address tests, candidate and SDP scrubbing; later, TURN REST credentials |
| `voice.signaling.ts` | `WebSocketServer({ noServer, maxPayload })`, `voiceUpgrade()`, hello/auth/timeout, relay, rate limits, heartbeat, the 10 s sweep |
| `voice.routes.ts` | `GET /nova/api/voice/status` (requireAuth): your party id, eligibility, member count, server version. Lets the UI explain *why* voice isn't available without opening a socket |
| `voice.test.ts` | Real-socket tests (§10.1) |

Edits to existing files:

| File | Change |
|---|---|
| `xmpp.server.ts` | Dispatch `/nova/voice` before the XMPP upgrade (`:584`); export a `partyEvents` emitter fired from the join (`:460-495`), unavailable (`:440-455`) and `removeClient` (`:652-689`) paths |
| `matchmaking.routes.ts` | Export `tailnetMemberIps()` |
| `config.ts` | `VOICE_ENABLED`, `VOICE_MAX_ROOM=16`, `VOICE_TURN_SECRET`, `VOICE_TURN_URLS`; **and §8.1, `JWT_SECRET` from `NOVA_JWT_SECRET`** |
| `index.ts` | Register `voiceRoutes` |

Deploy using the procedure in the coordinator memory note: tar `src/`, back up, restart, check a real
route against a bogus-path control, because the catch-all returns 200 `{}` for unknown paths. **No new
npm dependencies.**

The host-agent bundle doesn't need voice. Re-stage it with `tools/stage-backend.mjs` whenever backend
`src/` changes anyway (installer memory note).

### Phase 2: Launcher, Rust side

| File | Contents |
|---|---|
| `src-tauri/src/voice_perm.rs` | The `PermissionRequested` handler from §2.2, installed in `setup()` |
| `src-tauri/src/voice_ptt.rs` | Hook thread, watchdog, emitter thread; commands `ptt_set_binding`, `ptt_capture_next`, `ptt_status` |
| `src-tauri/src/main.rs` | `mod voice_perm; mod voice_ptt;`; `voice_perm::install(&window)` in setup; add commands to `generate_handler!`; close-while-in-voice → minimize or warn |
| Optional: `src-tauri/src/tailscale.rs` | `ts_ensure_voice_firewall()`, only if Phase 0 shows it's needed |
| `src-tauri/Cargo.toml` | `webview2-com = "=0.19.1"`; `windows` features `Win32_UI_WindowsAndMessaging`, `Win32_UI_Input_KeyboardAndMouse`, `Win32_System_LibraryLoader` |

### Phase 3: Launcher, voice engine (TypeScript, no new npm dependencies)

Under `Launcher/src/voice/`:

| File | Contents |
|---|---|
| `protocol.ts` | Copy of the shared types |
| `signaling.ts` | WSS client to `COORDINATOR.replace(/^https/, "wss") + "/nova/voice"`: hello, reauth, backoff reconnect, typed events |
| `mesh.ts` | Peer connection per member, perfect negotiation, candidate filter, ICE restart, `getStats` sampling: candidate pair, RTT, loss, jitter, bytes |
| `audio.ts` | Opt-in → `getUserMedia`, device lists, `devicechange`, `replaceTrack`, `<audio>` element per peer with volume and `setSinkId`, local analyser, remote `audioLevel`, test tone |
| `ptt.ts` | `listen("voice://ptt")` → gate, release tail, mute-wins |
| `prefs.ts` | localStorage: devices, binding, mode, per-account volumes, auto-join opt-in. Every access wrapped in try/catch |
| `VoiceProvider.tsx` | React context mounted in `router.tsx`'s `Shell`, next to `useLauncher`, so voice survives navigation the same way the launch sequence does |

### Phase 4: Launcher UI

Follow the user's mandatory web/UI workflow from CLAUDE.md for this phase: design direction, sourced
components, build, then the Phase 4 review gates (web-design-guidelines, accesslint, design-audit,
ui-design-review, review-animations, writing-guidelines). Respect the launcher's existing rules:

- **Amber means hosting and nothing else.** Voice states use the cold palette plus semantic colours.
- Compute contrast; don't eyeball it.
- `<MotionConfig reducedMotion="user">` is already in place; speaking pulses must respect it.
- **No fake rows:** every roster entry comes from `joined`/`peer-*` messages and `getStats`.

Files:

| File | Contents |
|---|---|
| `src/screens/Voice.tsx` | Party roster. Per member: name, speaking indicator, connection state and RTT, volume slider, local mute. Your own mic: live meter, push-to-talk or voice-activation, mute, deafen. Opt-in card. Clear reasons when unavailable: "Start Fortnite and join a party", "Nova network offline", "Windows is blocking the microphone" |
| `src/screens/Settings.tsx` (section) | Input and output pickers, push-to-talk binding capture, release tail, voice-activation threshold, auto-join opt-in, on/off sounds |
| `src/AppShell.tsx` | Nav item; voice state in `StatusRibbon` (signaling state, peers connected, mic live or muted) |
| `src/router.tsx` | Route + `VoiceProvider` |

### Phase 5: Diagnostics

- A "Voice diagnostics" panel in `SelfCheck.tsx`. Per peer: the selected candidate pair (shown as
  `100.x.x.x ↔ 100.y.y.y`, visible locally only), codec, bytes sent and received, packet loss, jitter,
  RTT. Plus a **test-tone** button and a tone detector.
- Add voice failure signatures to the nova-doctor catalog (doctor memory note): mic blocked by Windows
  privacy, no tailnet, ICE failed, party not found.

### Optional later phases

- **Phase 6, TURN fallback:** coturn per §4.6 (the user runs the Funnel `--tls-terminated-tcp=10000`
  command); the coordinator issues credentials in `welcome`.
- **Phase 7, SFU:** LiveKit on the coordinator's tailnet IP, only if the §10.7 measurements say so.

---

## 10. Test plan: proving audio really flows

### 10.1 Backend, automated

`node:test` with real sockets, in the style of `muc-join.test.ts`: a real XMPP handshake, plus a real
voice socket.

1. No `hello` within 5 s → closed with 4408. Bad or expired token → 4401. Client-credential token →
   4401.
2. Two accounts join the XMPP MUC `Party-abc` → both `join` → each gets `joined` and sees the other.
   A third account in `Party-xyz` sending `join` lands in its own room and never sees them.
3. One member sends an XMPP `unavailable` to `Party-abc` (or its XMPP socket is terminated) → within
   1 s it gets `kicked{left-party}` and the other gets `peer-left`.
4. `signal` to an accountId outside the sender's room is dropped and returns `error{not-in-room}`.
5. Candidate scrubbing: `192.168.1.5`, a public IPv6 address and `x.local` are dropped;
   `100.101.2.3` and `fd7a:115c:a1e0::1` pass. SDP `a=candidate` lines are scrubbed the same way.
6. Flood of 200 messages in 1 s → 4429. A 70 KiB frame is refused by `maxPayload`.
7. A second `hello` for the same account → the first socket closes with 4409.
8. `/nova/voice` never reaches the matchmaker: the matchmaking waiter count is unchanged after a
   voice connection. This guards the `upgrade` dispatch.

### 10.2 PTT, automated where possible

- Rust unit tests for binding parsing.
- An ignored-by-default test that injects `SendInput` key-down and key-up and checks the channel
  receives `true` then `false`. Injected input still passes through low-level hooks; `LLKHF_INJECTED`
  is set, and the hook must not filter it.

### 10.3 Media, automated (one machine, no humans)

`tools/voice-e2e.mjs`: start a local backend, then run two Chromium or Edge instances through
puppeteer-core, using the browser already installed:

- Flags: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<tone>.wav`.
- Peer A sends a 440 Hz WAV; peer B sends 660 Hz.
- Both load the launcher's built `voice/` modules against the test signaling server.

Assertions:

- Each side's `inbound-rtp` `bytesReceived` keeps growing over 5 s.
- An `AnalyserNode` FFT on the received track (attached to a muted `<audio>`, per §7.2) peaks at the
  **other** peer's frequency: A hears 660, B hears 440. That proves the actual audio content arrived,
  correctly routed, not just packets.
- Toggling A's `track.enabled = false` drops B's measured level to under 1% within 500 ms.

### 10.4 Two-machine acceptance test (the real proof)

Machines: the dev PC and the laptop, **both signed into the Nova tailnet**. Check with
`tailscale status`, because the laptop was once on a different tailnet (coordinator memory note).
Two different Nova accounts.

1. `tailscale ping <other 100.x>` answers, and note whether it's `direct` or `via DERP`.
2. Both start Fortnite and form **one in-game party**.
   - Check: `GET /nova/api/voice/status` on each shows the same party id.
3. Both join voice. Pass:
   - Voice diagnostics on each shows `connected`.
   - The selected candidate pair is **100.x ↔ 100.x** (this proves the tailnet path).
   - Codec `opus/48000`.
   - RTT shown and plausible.
4. **Tone test:** A presses "Send test tone", which swaps the mic for a 1 kHz oscillator track via
   `replaceTrack`. B's diagnostics must show "Receiving A's test tone, 1000 Hz" from FFT on the
   received stream. Repeat B → A.
5. **Wire capture:** on B, capture on the `Tailscale` interface with Wireshark or `pktmon`.
   - While A holds push-to-talk: a UDP flow from A's 100.x at about 50 packets/s.
   - After release: drops to the DTX trickle.
6. **Human test:** speak both ways. Check the per-player volume slider changes loudness on one side
   only. Change the output device mid-call. Unplug the headset → falls back to default and a toast
   appears.
7. **Push-to-talk under focus:** Fortnite fullscreen and focused on A. Hold the binding (keyboard key,
   then mouse side button):
   - B hears A.
   - Release stops it within about 250 ms. Measure from the timestamps in the diagnostics log.
   - The bound key still does its in-game action.
   - Lock the screen while holding → transmission stops (watchdog).

### 10.5 Privacy

- B leaves the Fortnite party → within 2 s: A sees `peer-left`, A's `bytesReceived` from B stops, and
  B's mic track is stopped (the Windows mic indicator goes off).
- B, now in another party, crafts a raw socket `join` (via devtools) → lands only in its own room,
  never A's.
- B forges a token signed with the **old** literal secret after §8.1 is fixed → 4401.
- Inspect the signaling traffic that B receives: no non-100.x addresses in any candidate or SDP.

### 10.6 Resilience

- Kill the coordinator's backend mid-call (restart recipe from the memory note):
  - Audio between A and B **keeps flowing**.
  - The UI says "Voice server reconnecting".
  - On return, both re-join without duplicate peer connections; the count stays at 1 per pair.
- `tailscale down` on B → ICE goes `disconnected` then `failed`; A shows "Can't reach B". After
  `tailscale up`, `restartIce` recovers.
- The launcher runs minimized for 15 minutes in a match → push-to-talk latency is unchanged (§2.5).

### 10.7 Scale

Use 4 real machines, or 1 real machine plus headless-Chromium bots with fake audio on 2–3 tailnet
machines. Measure on the weakest machine, including one that is **also hosting a Reboot server**:

- launcher plus WebView2 CPU at 4, 8 and 16 members;
- upload while talking;
- connection setup time.

These numbers decide whether Phase 7 (SFU) is ever needed.

---

## 11. Risks, ranked

1. **Forgeable tokens** (§8.1). Breaks the party-only guarantee outright. Fix before voice ships.
2. **Parties not forming between players on 7.40** (§5.3). Leaves voice with no source of truth;
   fallbacks exist, but the product changes.
3. **Tailnet ICE not connecting on some PCs** because of the firewall, third-party security suites
   (one report of Bitdefender blocking TCP over the Tailscale adapter [doc]) or a narrowed ACL.
   Mitigations: the scoped firewall rule, checking the ACL, and later the TURN fallback. Players
   without a working tailnet get no voice until Phase 6, and the UI must say so plainly.
4. **Background throttling or latency in a hidden WebView2** affecting push-to-talk or voice
   activation (§2.5). Measured in Phase 0; push-to-talk is event-driven to avoid it.
5. **Push-to-talk privacy failure** (stuck open). Watchdog, mute-wins, stop the mic on leave.
6. **Game audio leaking into the mic on speakers**, and **Windows ducking** (§7.5). Recommend a
   headset; push-to-talk default; spike the ducking.
7. **Upload in a 16-person mesh** (about 1.2 Mbit/s while talking) on a PC that's also hosting.
   Measure (§10.7); SFU is the escape hatch.
8. **Closing the launcher ends voice** (`main.rs:376`). Minimize-on-close while in voice.

## 12. Still unknown

Each of these is a spike item, not a guess to build on:

- Does mic capture work in an **elevated** WebView2?
- Is the WebView2 permission event still raised after a saved decision? It can't happen with the
  handler shipped first, but confirm.
- Does Chrome send SNI over TURN/TLS through Funnel?
- Does a `RegisterHotKey` binding take the key away from the game?
- Does Windows Firewall allow ICE on the tailnet with no extra rule?
- Does the Nova tailnet's ACL allow UDP on any port between players?
- How fast is a Rust `emit_all` into a minimized WebView2?

---

## 13. Sources

WebView2 and Tauri

- WebView2 `ICoreWebView2PermissionRequestedEventArgs`: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2permissionrequestedeventargs
- WebView2 `…EventArgs3` (`SavesInProfile`, persistence by default, the "browser heuristics" caveat): https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2permissionrequestedeventargs3?view=webview2-1.0.3967.48
- WebView2 `COREWEBVIEW2_PERMISSION_STATE` / `_KIND_MICROPHONE`: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.2903.40#corewebview2_permission_state
- WebView2 `AdditionalBrowserArguments` behaviour: https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environmentoptions.additionalbrowserarguments
- Wails WebView2 permissions (default prompt when unhandled): https://v3.wails.io/features/windows/permissions
- Tauri issue #4364, push-to-talk / key release in global shortcuts: https://github.com/tauri-apps/tauri/issues/4364
- Tauri v2 global-shortcut plugin (Pressed/Released state): https://v2.tauri.app/reference/javascript/global-shortcut/

Media APIs

- MDN `HTMLMediaElement.setSinkId()`: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId
- caniuse, setSinkId: https://caniuse.com/mdn-api_htmlmediaelement_setsinkid
- MDN `AudioContext.setSinkId()`: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId
- Chrome blog, AudioContext.setSinkId in Chrome 110: https://developer.chrome.com/blog/audiocontext-setsinkid
- MDN `enumerateDevices()`: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices
- MDN `RTCRtpReceiver.getSynchronizationSources()`: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/getSynchronizationSources
- MDN Perfect negotiation: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
- MDN `WebSocket()` constructor (URL and protocols only): https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket
- Chrome timer throttling (WebRTC and audio exemptions): https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Chrome 47 WebRTC (`communications` device, `googDucking`): https://developer.chrome.com/blog/chrome-47-webrtc
- Remote WebRTC audio silent in Web Audio, crbug 933677 (Q&A mirror): https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/54514273/webrtc-via-web-audio-api-silent-on-google-chrome
- three.js forum, the same workaround: https://discourse.threejs.org/t/positionalaudio-setmediastreamsource-with-webrtc-question-not-hearing-any-sound/14301?page=2
- Chrome-wide echo cancellation discussion: https://github.com/w3c/mediacapture-extensions/issues/31
- Firefox echo cancellation with setSinkId (bug 1849108): https://bugzilla.mozilla.org/show_bug.cgi?id=1849108

ICE, mDNS and WebRTC networking

- Chrome mDNS host candidates and the capture-permission exception: https://groups.google.com/g/discuss-webrtc/c/6stQXi72BEU
- `WebRtcHideLocalIpsWithMdns` flag removed from chrome://flags in M91: https://groups.google.com/g/discuss-webrtc/c/Rs-hq_O90nY
- WebRTC network ignore mask / VPN adapter type: https://chromium.googlesource.com/external/webrtc/+/763d847f1e5ac3c5607ace75cc03876e4fc1341b/rtc_base/network.cc
- Tailscale interface found by desktop browsers for WebRTC (CAAL #84): https://github.com/CoreWorxLab/CAAL/discussions/84
- Janus over Tailscale failure report: https://janus.discourse.group/t/failing-to-establish-webrtc-stream-over-tailscale-interface/1026
- Chrome TURN over TCP: the relay leg stays UDP: https://groups.google.com/g/turn-server-project-rfc5766-turn-server/c/vR_2OAV9a_w
- RFC 7587, Opus RTP payload (fmtp parameters, bitrate sweet spots): https://www.rfc-editor.org/rfc/rfc7587.html

Tailscale

- Tailscale Funnel (ports, TLS only, bandwidth limits): https://tailscale.com/kb/1223/funnel
- `tailscale funnel` CLI (`--tcp`, `--tls-terminated-tcp`): https://tailscale.com/kb/1311/tailscale-funnel
- Tailscale 100.x addresses: https://tailscale.com/kb/1015/100.x-addresses
- Tailscale IPv6 / fd7a:115c:a1e0::/48: https://tailscale.com/docs/concepts/ip-and-dns-addresses
- Tailscale DERP: https://tailscale.com/kb/1232/derp-servers
- Tailscale ACLs (default allow-all): https://tailscale.com/kb/1018/acls
- Tailscale on Windows, network profile and firewall forum thread: https://forum.tailscale.com/t/win-10-stopped-connecting-cant-get-ping-response/755
- Bitdefender blocking TCP over the Tailscale adapter: https://community.bitdefender.com/en/discussion/105901/bitdefender-firewall-blocking-tcp-traffic-over-tailscale-virtual-adapter-despite-explicit-allow-rule

Servers: SFU and TURN

- LiveKit ports and firewall: https://docs.livekit.io/home/self-hosting/ports-firewall/
- LiveKit server (Go, Pion, single binary, Apache-2.0): https://github.com/livekit/livekit
- mediasoup installation: https://mediasoup.org/documentation/v3/mediasoup/installation/
- Janus AudioBridge: https://janus.conf.meetecho.com/docs/audiobridge.html
- BlogGeek.me, SFU glossary (mesh 2–5 participants): https://bloggeek.me/webrtcglossary/sfu/
- BlogGeek.me, multiparty alternatives: https://bloggeek.me/webrtc-multiparty-video-alternatives
- coturn example `turnserver.conf`: https://raw.githubusercontent.com/coturn/coturn/master/examples/etc/turnserver.conf

Windows input

- `LowLevelKeyboardProc` (message loop, timeout, silent removal, raw input recommendation): https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc
- `RegisterRawInputDevices` (one window per device class per process): https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerrawinputdevices
- Discord, push-to-talk with an elevated game: https://support.discord.com/hc/en-us/articles/205082178
- rdev Windows listener source: https://raw.githubusercontent.com/Narsil/rdev/main/src/windows/listen.rs

CSP

- Chromium CSP wildcard matching ws/wss: https://codereview.chromium.org/2160983002
