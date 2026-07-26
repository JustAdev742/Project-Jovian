# ═══════════════════════════════════════════════════════════════════════════
#  Nova Coordinator launcher  —  run this on the machine that hosts the backend
#  (e.g. your Dell E7270). Starts the Nova backend on port 3551.
#  Bandwidth used by the coordinator is tiny (JSON messages) — safe on a shared
#  home line. The heavy game traffic never flows through here.
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot '..\Main backend'

if (-not (Test-Path (Join-Path $backend 'package.json'))) {
  Write-Host "Could not find 'Main backend' next to this script." -ForegroundColor Red
  exit 1
}

Set-Location $backend

if (-not (Test-Path 'node_modules')) {
  Write-Host 'Installing backend dependencies (first run only)...' -ForegroundColor Cyan
  npm install
}

Write-Host ''
Write-Host '  Nova Coordinator starting on http://127.0.0.1:3551' -ForegroundColor Green
Write-Host '  (LOCAL play works now. For GLOBAL, also run start-tunnel.ps1 and edit .env — see NOVA-P2P-SETUP.md)' -ForegroundColor DarkGray
Write-Host ''

# Dev mode (tsx) picks up src/ directly. Use "npm start" if you prefer the built dist/.
npm run dev
