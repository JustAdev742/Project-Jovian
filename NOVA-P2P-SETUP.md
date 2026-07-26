# Nova — Free Global P2P Game Server Setup

This is your "P2P game server service": a free way to go from **login → lobby → press
Play → into a real match**, first on one PC, then with friends anywhere — without a
credit card and without your family's home internet carrying game traffic.

---

## How it actually works (read this once)

There are **two separate pieces**, and only one of them uses real bandwidth:

| Piece | What it is | Runs where | Bandwidth |
|-------|-----------|-----------|-----------|
| **Coordinator** | Your Nova backend — login, MCP/profile, matchmaking | Your Dell E7270, 24/7 | **Tiny** (like loading a webpage now and then). Safe on a shared line. |
| **Game host** | A real Fortnite server (Project Reboot gameserver DLL) that runs the match | A player's PC, per-match | **Heavy** — this is the part that must *not* be your weak line. Use localhost for testing, or let a friend with good internet host. |

The coordinator just **hands each player the address of a gameserver**. It never
touches the game traffic itself. That's the whole trick to making it free.

### The one thing you must obtain yourself
Nova (coordinator) is done and working. The missing piece is the **gameserver that
hosts the match** — a real Fortnite server. I can't download or ship game binaries, but
for 7.40 (Season 7) it's a solved, community-supported thing:

- **Project Reboot** by Milxnor — the same author as your `Cobalt.dll`.
  Repos: <https://github.com/Milxnor/Project-Reboot> ("S3–S19 gameserver") and
  <https://github.com/Milxnor/Project-Reboot-3.0>. 7.40 = Season 7, which is in range.
- Get the actual DLL + build guidance from the **Project Reboot Discord / site**:
  <https://www.rebootmp.com/>.

You already have the two hard parts (a working 7.40 client + Cobalt redirect + Nova
backend). The gameserver is the last component.

---

## PATH A — LOCAL (get into a match this week, $0, zero internet)

Goal: prove the entire chain end-to-end on your own PC. Everything points at
`127.0.0.1:7777`, which is already Nova's default — nothing to configure.

1. **Start the coordinator** (Nova backend):
   - Double-click / run `coordinator\start-coordinator.ps1`, **or** in `Main backend` run `npm run dev`.
   - It listens on `http://127.0.0.1:3551`.
2. **Start the gameserver** (Project Reboot) so something is actually hosting at
   `127.0.0.1:7777`:
   - Follow Project Reboot's instructions to launch a **7.40 gameserver** that logs into
     a local backend. Point it at Nova (`127.0.0.1:3551`) if it asks for a backend.
   - This is the piece that was missing before — last time you pressed Play, the client
     connected to `127.0.0.1:7777` and timed out **because nothing was hosting there**.
3. **Launch Fortnite** with your Nova launcher and press **Play**.
   - The client matchmakes through Nova, gets `127.0.0.1:7777`, and connects to the
     Reboot gameserver → you drop into the match.

> If you don't want to run a separate gameserver process, Project Reboot also has a
> "host a server" flow in its launcher that does both — but since you have your own
> Nova backend, running the gameserver *pointed at Nova* keeps your backend in charge.

**Same-house (LAN) play:** others in your house can join by pointing their client's
Cobalt at your PC's LAN IP (e.g. `192.168.1.x:3551`) and setting
`NOVA_GAME_SERVER_IP=192.168.1.x` in `Main backend\.env`. Still no internet, no cost.

---

## PATH B — GLOBAL (friends over the internet, still free)

Add this once Path A works. Two free tunnels do the heavy lifting:

### B1. Expose the coordinator with Cloudflare Tunnel (free, no card)
- Run `coordinator\start-tunnel.ps1`. It downloads `cloudflared` and prints a public URL
  like `https://random-words.trycloudflare.com`.
- This is the coordinator's public address. WebSockets work over it out of the box.
- In `Main backend\.env` set: `NOVA_MMS_URL=wss://random-words.trycloudflare.com`
- For a **stable** address instead of a random one each run, set up a free *named*
  tunnel with a domain on Cloudflare (same tool, `cloudflared tunnel create`).

### B2. Expose the gameserver with playit.gg (free, no card, no port-forward)
- On whoever is **hosting the match**, install the playit agent from <https://playit.gg/>.
- It gives a public address like `nova-abc.playit.gg:45678` that forwards to their local
  `127.0.0.1:7777`. Works behind any router/CGNAT.
- Tell Nova to route players to it — two ways:
  - **Simple/static:** in `.env`, `NOVA_GAME_SERVER_IP=nova-abc.playit.gg` and
    `NOVA_GAME_SERVER_PORT=45678`, then restart the coordinator.
  - **Live:** run `coordinator\register-gameserver.ps1 -Address nova-abc.playit.gg -Port 45678`
    (it heartbeats the registry; no restart needed, supports multiple hosts).

### B3. Point friends' clients at your coordinator
- Each friend's client needs its Cobalt redirect aimed at **your** coordinator's public
  URL (from B1), not `127.0.0.1`. Check whether your `Cobalt.dll` reads a backend URL
  from a config file in the build folder.
  - If yes: set it to your Cloudflare URL.
  - If it's hard-coded to `127.0.0.1:3551`: that's the one remaining piece to solve for
    global — ping me and I'll wire a tiny local redirect (or hosts-file entry) so their
    client reaches your coordinator. This is the only "unknown" in the global path.

> **Bandwidth reality:** the match host uploads ~0.1–0.3 Mbps *per player*. So don't host
> big lobbies on your weak line — test on localhost, and for global let a friend with a
> good connection be the host (they run playit + the gameserver). Your Dell only ever
> runs the featherweight coordinator.

---

## Switching LOCAL ↔ GLOBAL

It's just `Main backend\.env` (copy from `.env.example`). No code changes:

- **LOCAL:** no `.env`, or everything commented out → `127.0.0.1:7777`.
- **GLOBAL:** set `NOVA_GAME_SERVER_IP/PORT` to the playit address and `NOVA_MMS_URL` to
  the Cloudflare URL. Restart the coordinator.

---

## Endpoints the service exposes (for reference / the launcher)

| Method + path | Purpose |
|---|---|
| `GET  /nova/api/gameservers` | List the routing table + the currently-resolved default server |
| `POST /nova/api/gameserver/register` | A host announces `{address, port, playlist?, region?, name?, players?, maxPlayers?}` (heartbeat by re-posting; expires after 60s) |
| `POST /nova/api/gameserver/unregister` | Remove a host `{address, port, playlist?}` |
| `GET  /nova/api/sessions` | Active matchmaking sessions + player counts |

Matchmaking resolves a server in priority order: **live registration → static
`NOVA_GAME_SERVERS` table → config fallback (`127.0.0.1:7777`)**, so a bare setup always
resolves to *something*.

---

## Troubleshooting

- **`Connection TIMED OUT … RemoteAddr: 127.0.0.1:7777` → `Match State Aborted`**
  (what you saw last time): matchmaking worked; there was just **no gameserver hosting at
  that address**. Start the Project Reboot gameserver (Path A step 2).
- **`openPrivatePlayers was not found` / `Unable to read session settings`**: already
  fixed in Nova's session response — make sure you're running the current backend.
- **Friends can't reach the coordinator**: confirm the Cloudflare URL loads in a browser,
  and that their Cobalt points at it (B3).
- **Check what Nova is handing out right now:**
  `Invoke-RestMethod http://127.0.0.1:3551/nova/api/gameservers`

---

*Nova coordinator + matchmaking: built and working. Game hosting: Project Reboot
gameserver (obtain from rebootmp.com). Tunnels: Cloudflare (coordinator) + playit.gg
(gameserver). All free, no credit card.*
