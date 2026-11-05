# ai2vpn installer (Windows, needs Docker Desktop)
#
#   irm https://raw.githubusercontent.com/icebays/ai2vpn/HEAD/install.ps1 | iex
#
# or, from a checkout:   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Environment variables (optional): INSTALL_DIR (default: %USERPROFILE%\ai2vpn),
# AI2VPN_PORT (default: 8080 or the next free one), BRANCH (default: the repository's default branch).
# Re-running the installer updates an existing install and keeps your accounts and settings.

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/icebays/ai2vpn'
$Branch  = $env:BRANCH

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail($m) { throw $m }   # not `exit`: under `irm | iex` that would close the window

# ---- install dir
$here = if ($PSScriptRoot) { $PSScriptRoot } else { '' }
if ($env:INSTALL_DIR) { $Dir = $env:INSTALL_DIR }
elseif ($here -and (Test-Path (Join-Path $here 'docker-compose.yml'))) { $Dir = $here }
else { $Dir = Join-Path $env:USERPROFILE 'ai2vpn' }

# ---- docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Info 'Installing Docker Desktop with winget...'
    winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    Fail 'Docker Desktop was installed. Start it (and finish its setup), then run this installer again.'
  }
  Fail 'Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and run this installer again.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker is installed but not running. Start Docker Desktop and run this installer again.' }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose is missing. Update Docker Desktop and try again.' }

# ---- get the code
if ($Dir -ne $here) {
  if (Test-Path (Join-Path $Dir '.git')) {
    Info "Updating $Dir..."
    git -C $Dir stash push -q -m 'ai2vpn installer' 2>$null
    git -C $Dir pull -q --ff-only
    git -C $Dir stash pop -q 2>$null
  } elseif (Get-Command git -ErrorAction SilentlyContinue) {
    if (-not (Test-Path (Join-Path $Dir 'docker-compose.yml'))) {
      Info "Downloading ai2vpn to $Dir..."
      if ($Branch) { git clone --branch $Branch "$RepoUrl.git" $Dir } else { git clone "$RepoUrl.git" $Dir }
      if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
    }
  } else {
    Info "Downloading ai2vpn to $Dir (zip)..."
    $ref = if ($Branch) { $Branch } else { 'HEAD' }
    $zip = Join-Path $env:TEMP 'ai2vpn.zip'
    $tmp = Join-Path $env:TEMP ('ai2vpn-' + [guid]::NewGuid())
    Invoke-WebRequest "https://api.github.com/repos/icebays/ai2vpn/zipball/$ref" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip $tmp -Force
    New-Item -ItemType Directory -Force $Dir | Out-Null
    Copy-Item -Recurse -Force (Join-Path (Get-ChildItem $tmp | Select-Object -First 1).FullName '*') $Dir
    Remove-Item -Recurse -Force $zip, $tmp
  }
}
Set-Location $Dir

# ---- .env (port + admin password), first install only
function PortBusy($p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
function EnvValue($k) {
  $m = Select-String -Path .env -Pattern "^$k=(.*)$" -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($m) { $m.Matches[0].Groups[1].Value.Trim("'", '"') } else { '' }
}
if (-not (Test-Path .env)) {
  $Port = if ($env:AI2VPN_PORT) { [int]$env:AI2VPN_PORT } else { 8080 }
  if ($env:AI2VPN_PORT -and (PortBusy $Port)) { Fail "Port $Port is already in use. Set AI2VPN_PORT to another port." }
  while (PortBusy $Port) { $Port++ }
  $Pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
  "AI2VPN_PORT='$Port'`nADMIN_PASSWORD='$Pw'`nA2V_SANDBOX='1'`n" | Set-Content -NoNewline -Encoding ascii .env
  Info "Created .env (port $Port, a new admin password)"
} else {
  Info "Keeping your existing settings (.env)"
}
$Port = EnvValue 'AI2VPN_PORT'; if (-not $Port) { $Port = 8080 }
$Pw = EnvValue 'ADMIN_PASSWORD'
foreach ($d in 'data', 'workspace', 'sandbox-home') { New-Item -ItemType Directory -Force $d | Out-Null }

# ---- start
Info 'Building and starting containers (the first run downloads ~2 GB and can take 5-15 minutes)...'
$services = @()
if ((EnvValue 'A2V_SANDBOX') -eq '0') { $services = @('ai2vpn') }
docker compose up -d --build --remove-orphans @services
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed (see the messages above).' }

Info 'Waiting for ai2vpn to start...'
$healthy = $false
for ($i = 1; $i -le 90; $i++) {
  $s = (docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' ai2vpn 2>$null)
  if ($s -eq 'healthy') { $healthy = $true; break }
  Start-Sleep 2
}

Write-Host ''
Write-Host "ai2vpn is installed in $Dir" -ForegroundColor White
Write-Host "  Open:        http://localhost:$Port"
Write-Host "  Password:    $Pw"
Write-Host "  API base:    http://localhost:$Port/v1"
if (-not $healthy) { Write-Host '  (still starting - give it a minute, or check: docker logs ai2vpn)' -ForegroundColor Yellow }
Write-Host ''
Write-Host '  Next:        VPN tab -> paste your WireGuard/OpenVPN config;  Accounts -> + Add account'
Write-Host '  Update:      re-run this installer (or Settings -> Updates in the web UI)'
Write-Host "  Uninstall:   cd $Dir; docker compose down   (delete .\data to remove all accounts)"
