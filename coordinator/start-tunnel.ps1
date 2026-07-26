# ═══════════════════════════════════════════════════════════════════════════
#  Cloudflare Quick Tunnel  —  exposes the Nova coordinator (port 3551) to the
#  internet for FREE, with NO account and NO credit card. Outbound-only: no
#  router/port-forward changes. Prints a public https URL like
#      https://random-words.trycloudflare.com
#  Give that URL (as wss://random-words.trycloudflare.com) to friends' clients
#  as NOVA_MMS_URL, and point their Cobalt redirect at it. See NOVA-P2P-SETUP.md.
#
#  NOTE: Quick Tunnel URLs are random and change each run. For a stable custom
#  domain, set up a *named* tunnel (still free) — instructions in the guide.
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'
$port = 3551
$exe  = Join-Path $PSScriptRoot 'cloudflared.exe'

if (-not (Test-Path $exe)) {
  Write-Host 'Downloading cloudflared (one-time, ~20 MB)...' -ForegroundColor Cyan
  $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Invoke-WebRequest -Uri $url -OutFile $exe
}

Write-Host ''
Write-Host "  Opening a free public tunnel to http://127.0.0.1:$port ..." -ForegroundColor Green
Write-Host '  Look for the https://<name>.trycloudflare.com line below.' -ForegroundColor DarkGray
Write-Host ''

& $exe tunnel --url "http://127.0.0.1:$port"
