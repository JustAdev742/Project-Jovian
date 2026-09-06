# coordinator

The live Linux box, `codenovaserver`. This directory is the **record** of how it is set up — the box
is not a git checkout, so these files are copies, not the running originals. Keep them in step by
hand when you change the box.

```
ssh -i ~/.ssh/nova_coordinator admin_home@2001:8003:2291:a501:2af1:eff:fe28:da6
ssh -i ~/.ssh/nova_coordinator admin_home@192.168.0.170          # same box on the LAN
```

## How it runs

```
cron (every minute, and @reboot after a 20 s sleep)
   └── ~/nova-backend/start-nova.sh     no-op if run-nova.sh is already running
        └── ~/nova-backend/run-nova.sh  supervisor: restart loop with backoff
             └── node_modules/.bin/tsx src/index.ts   → 127.0.0.1:3551
```

`tailscaled` runs in userspace networking, started the same way from
`~/app/clientfinder/start-tailscale.sh`. Funnel exposes **two** things:

| public URL | proxies to |
|---|---|
| `https://clientfinder.tail0a8fd0.ts.net` | `127.0.0.1:3000` — an unrelated Next.js app |
| `https://clientfinder.tail0a8fd0.ts.net:8443` | `127.0.0.1:3551` — **the Nova backend** |

**The second line is the one that matters for security.** The backend binds `127.0.0.1` and looks
local, but Funnel puts it on the public internet. Any authentication gap in Nova is remotely
reachable here, and only here — a player's own host agent is not.

## Deploying backend changes

`~/nova-backend` is **not a git checkout**; it was populated by file copy, so "pull to the
coordinator" is a copy, not a `git pull`. It runs `src/` directly through `tsx` — there is no
`dist/` — so shipping TypeScript sources is the whole job.

```bash
SSH="ssh -i ~/.ssh/nova_coordinator admin_home@2001:8003:2291:a501:2af1:eff:fe28:da6"

# 1. What actually differs? Compare LF-normalised hashes — the working tree is CRLF and a raw
#    diff would report every file as changed.
$SSH 'cd ~/nova-backend/src && find . -name "*.ts" -print0 | xargs -0 -I{} sh -c \
  "printf \"%s \" {}; tr -d \"\r\" < {} | md5sum | cut -d\" \" -f1"' | sort > /tmp/remote.txt

# 2. Back up, then copy. Normalise CRLF→LF on the way so step 1 keeps working next time.
$SSH 'cd ~/nova-backend && tar czf ~/nova-src-backup-$(date +%Y%m%d-%H%M%S).tgz src'

# 3. Restart. Kill the SUPERVISOR first or it will restart the backend under you, and kill the
#    backend BY PID — a `pkill -f "tsx src/index.ts"` pattern once matched the SSH session running it.
$SSH 'kill $(pgrep -f "[n]ova-backend/run-nova.sh"); sleep 1
      kill $(ss -tlnpH "sport = :3551" | grep -oP "pid=\K[0-9]+" | head -1)
      ~/nova-backend/start-nova.sh'
```

**Verify with probes, not with "it started".** At minimum: the endpoints 7.40 actually calls still
answer with their expected sizes (timeline 2 408 B, lightswitch 330 B are stable controls), an
unauthenticated `POST /friends/api/public/friends/<a>/<b>` returns **401**, and a planted `eg1~`
canary does not come back out of `GET /nova/api/logs`.

## `run-nova.sh` — why it has backoff

The backend now exits non-zero when it cannot bind its HTTP port, rather than running on headless
(see REGRESSION_HISTORY NOVA-AUDIT-011's sibling). Under the old unconditional 3-second restart that
turned a stuck port into 20 starts a minute against a log that had already reached 12 MB. The
supervisor now doubles the wait — 3→6→12→24→48→60 — for any run shorter than 30 seconds, and resets
to 3 seconds after a run long enough to have served traffic. It also rotates `nova.log` at 50 MB.

## Secrets

`~/nova-backend/.env` holds the Tailscale API key. **Never print it.** To use it in a shell on the
box: `set -a; . ./.env; set +a`. There are several `.env.bak-*` files beside it that also contain
credentials; they are not read by anything.

## What is NOT set here, deliberately

`NOVA_REGISTER_SECRET` is unset, so `/nova/api/gameserver/register` is unauthenticated — see
KNOWN_ISSUES `gameserver-register-unauthenticated`. Setting it here alone would **break hosting**,
because no launcher in the field sends it. It needs a launcher release first.

## Diagnostics dashboard — public, deliberately narrow

Deployed 2026-09-06. Until then the dashboard had **never been on the coordinator**: it was running
45 source files against the repo's 61, and `index.ts` had zero references to `diagnosticsRoutes`.
`/nova/api/dashboard` answered `200 {}` — the catch-all, not the dashboard. Worth remembering that
"it returned 200" proved nothing.

```
cloudflared  ->  127.0.0.1:3560  (diag-proxy.mjs, path allowlist)  ->  127.0.0.1:3551  (Nova)
```

**Why the proxy is not optional.** Tunnelling 3551 directly would publish every route the backend
serves, including `POST /nova/api/gameserver/register` — whose gate is deliberately unset, and which
decides the address every player is routed to (`gameserver-register-unauthenticated`). That issue is
accepted-open *because the backend is loopback-only*. Publishing it would make it remote.

`diag-proxy.mjs` forwards only `/nova/api/dashboard`, `/nova/api/diagnostics`, `/nova/api/incidents`
and `/nova/api/incidents/<id>`, GET/HEAD only, and 404s everything else. It adds no authentication —
the backend's `adminOk()` is still the security boundary. Verified from outside the network:

| request | result |
|---|---|
| dashboard, no secret | 403 |
| dashboard, wrong secret | 403 |
| dashboard, correct secret | 200 |
| `gameserver/register`, `oauth/token`, MCP, `/nova/api/logs` | 404 |

**The secret** is `NOVA_AC_ADMIN_SECRET` in `~/nova-backend/.env` (chmod 600). `NOVA_REGISTER_SECRET`
is deliberately left unset — `adminOk()` falls back to it, so setting it would close the register
gate and break hosting for every launcher below 1.6.5.

**The URL changes.** `trycloudflare.com` hostnames are issued per tunnel process, so a restart gets a
new one. Read the current one:

```bash
ssh -i ~/.ssh/nova_coordinator admin_home@2001:8003:2291:a501:2af1:eff:fe28:da6 \
  'cat ~/nova-backend/diag-public-url.txt'
```

`start-diag.sh` keeps both processes up (`@reboot` and every 5 minutes) and is idempotent. A stable
hostname would need a named Cloudflare tunnel and a domain.
