# ═══════════════════════════════════════════════════════════════════════════
#  Register a gameserver with the Nova coordinator and keep it alive (heartbeat).
#  Use this on a HOST machine when playing GLOBAL: you run the Reboot gameserver
#  locally (listens on 127.0.0.1:7777) and playit.gg gives you a public address
#  that forwards to it. Tell Nova that public address so friends get routed to it.
#
#  Example (host behind a playit tunnel nova-abc.playit.gg:45678):
#    .\register-gameserver.ps1 -Coordinator http://127.0.0.1:3551 `
#        -Address nova-abc.playit.gg -Port 45678
#
#  Leave it running; it re-registers every 30s (the server expires after 60s of
#  silence). Ctrl+C to stop. For a purely LOCAL match you don't need this at all
#  — 127.0.0.1:7777 is the built-in default.
# ═══════════════════════════════════════════════════════════════════════════
param(
  [string]$Coordinator = 'http://127.0.0.1:3551',
  [Parameter(Mandatory = $true)][string]$Address,
  [int]$Port = 7777,
  [string]$Playlist = '*',
  [string]$Region = '*',
  [string]$Name = 'Nova host'
)

$body = @{ address = $Address; port = $Port; playlist = $Playlist; region = $Region; name = $Name } | ConvertTo-Json
$uri  = "$Coordinator/nova/api/gameserver/register"

Write-Host "Registering $Address`:$Port with $Coordinator (heartbeat every 30s, Ctrl+C to stop)..." -ForegroundColor Green
while ($true) {
  try {
    Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType 'application/json' | Out-Null
    Write-Host ("[{0}] heartbeat ok  →  {1}:{2}" -f (Get-Date -Format HH:mm:ss), $Address, $Port) -ForegroundColor DarkGray
  } catch {
    Write-Host ("[{0}] heartbeat FAILED: {1}" -f (Get-Date -Format HH:mm:ss), $_.Exception.Message) -ForegroundColor Red
  }
  Start-Sleep -Seconds 30
}
