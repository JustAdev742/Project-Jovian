# Build Cobalt (the SSL/redirect shim loaded into the Fortnite client).
#
#   .\build.ps1              # Release x64 -> cobalt\x64\Release\Cobalt.dll
#   .\build.ps1 -Deploy      # also copy it next to the launcher exe
#
# There is no NuGet restore step and no network access required: MinHook is vendored under
# vendor\MinHook. (The upstream project depended on the Detours NuGet package, which meant it did
# not build at all on a clean machine.)

param(
    [ValidateSet('Release', 'Debug')] [string] $Configuration = 'Release',
    [switch] $Deploy
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found. Install Visual Studio with the 'Desktop development with C++' workload."
}

$vsPath = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if (-not $vsPath) {
    throw "No Visual Studio installation with MSBuild was found. Install the 'Desktop development with C++' workload."
}

$msbuild = Join-Path $vsPath 'MSBuild\Current\Bin\MSBuild.exe'
if (-not (Test-Path $msbuild)) { throw "MSBuild.exe not found under $vsPath" }

Write-Host "Building Cobalt ($Configuration x64)..." -ForegroundColor Cyan
& $msbuild (Join-Path $root 'Cobalt.sln') /t:Build /p:Configuration=$Configuration /p:Platform=x64 /v:minimal /nologo
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }

$dll = Join-Path $root "x64\$Configuration\Cobalt.dll"
if (-not (Test-Path $dll)) { throw "Build reported success but $dll is missing" }

$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($dll)
Write-Host ""
Write-Host "Built: $dll" -ForegroundColor Green
Write-Host "  Product     : $($info.ProductName)"
Write-Host "  Description : $($info.FileDescription)"
Write-Host "  Version     : $($info.FileVersion)"
Write-Host "  Size        : $('{0:N0}' -f (Get-Item $dll).Length) bytes"

if ($Deploy) {
    # Wherever the launcher exe is, Cobalt.dll has to sit beside it (see dll_replace in carter.rs).
    $targets = @(
        (Join-Path $root '..\src-tauri\target\release'),
        (Join-Path $root '..\src-tauri\target\debug')
    ) | Where-Object { Test-Path $_ }

    foreach ($t in $targets) {
        Copy-Item $dll (Join-Path $t 'Cobalt.dll') -Force
        Write-Host "Deployed to $t" -ForegroundColor Green
    }
    if (-not $targets) { Write-Warning "No launcher build output found to deploy into." }
}
