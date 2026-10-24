# Install Warren on Windows. In PowerShell:
#
#   Run install.ps1 from a checkout, or use the command in INSTALL.md.
#
# To connect this computer to a hub as a device in one step (the command in Warren → Devices → Add device):
#
#   & ([scriptblock]::Create((irm <hub>/install.ps1))) -Hub <hub URL> -Token <token> -Name <name>
#
# It checks for git and Node 22+ (offering to install them with winget), clones (or updates) Warren
# into ~\warren, installs its dependencies, puts `warren` on your PATH, and starts it at sign-in.
param(
  [switch]$HubServer,
  [string]$Hub = "",
  [string]$Token = "",
  [string]$Name = "",
  [string]$Dir = $(if ($env:WARREN_DIR) { $env:WARREN_DIR } else { Join-Path $HOME "warren" }),
  [switch]$Yes,
  [switch]$NoService,
  # with -HubServer: don't also make this computer a device for agents
  [switch]$NoDevice,
  # don't open the browser at the end
  [switch]$NoOpen
)
$ErrorActionPreference = "Stop"
$GitHubRepo = "eireijie/warren"
$Repo = if ($env:WARREN_REPO) { $env:WARREN_REPO } else { "https://github.com/$GitHubRepo.git" }

function Bold($text) { Write-Host $text -ForegroundColor White }
function Fail($text) { Write-Host $text -ForegroundColor Red; exit 1 }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }
function Ensure($cmd, $id, $what) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "$what is missing. Install it and run this again." }
  $a = Read-Host "$what is missing. Install it with winget now? [Y/n]"
  if ($a -match '^n') { Fail "Install $what and run this again." }
  winget install --id $id -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
}

Bold "Warren installer"

# 1. git and Node 22+
Ensure git "Git.Git" "Git"
Ensure node "OpenJS.NodeJS.LTS" "Node.js"
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { Fail "Warren needs Node 22 or newer; this is $(node -v). Run: winget upgrade OpenJS.NodeJS.LTS" }
Write-Host "node $(node -v), $(git --version)"

# 2. the code
if (Test-Path (Join-Path $Dir ".git")) {
  Write-Host "Updating $Dir"
  # npm rewrites the lockfile on some installs; that change is never the user's work
  git -C $Dir checkout -- package-lock.json 2>$null
  git -C $Dir pull --ff-only
} else {
  if (Test-Path $Dir) { Fail "$Dir exists and isn't a Warren checkout. Pick another folder with -Dir." }
  git clone $Repo $Dir
}
if ($LASTEXITCODE) { Fail "Couldn't get Warren from $Repo." }
Set-Location $Dir

# 3. what this computer is for
$Mode = if ($HubServer) { "hub" } elseif ($Hub) { "device" } else { "" }
if (-not $Mode) {
  Write-Host ""
  Write-Host "What should this computer do?"
  Write-Host "  1) Run the hub: the workspace and web app (one per workspace)"
  Write-Host "  2) Connect to a hub as a device that runs agents"
  Write-Host "  3) Just install it"
  $Mode = switch (Read-Host "Choose 1, 2 or 3 [1]") { "2" { "device" } "3" { "none" } default { "hub" } }
}
if ($Mode -eq "device") {
  if (-not $Hub) { $Hub = Read-Host "Hub URL (for example http://my-server:4747)" }
  if (-not $Token) { $Token = Read-Host "Device token (Warren -> Devices -> Add device)" }
  if (-not $Hub -or -not $Token) { Fail "A device needs the hub URL and a token from Warren -> Devices -> Add device." }
}

# 4. dependencies
Bold "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE) { Fail "npm ci failed." }
if ($Mode -ne "device") {
  Bold "Building the web app"
  npm run build --silent
  if ($LASTEXITCODE) { Fail "Building the web app failed." }
}

# 5. the `warren` command: npm link puts warren.cmd next to npm, which is already on PATH
npm link --no-audit --no-fund --loglevel=error | Out-Null

# 6. start it
if ($Mode -eq "hub") {
  $Port = if ($env:PORT) { $env:PORT } else { "4747" }
  if ($NoService) {
    Bold "Start the hub with: warren hub start"
    Write-Host "Then open http://localhost:$Port in a browser to make your account."
  } else {
    warren service install hub
    $up = $false
    foreach ($i in 1..30) {
      try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $up) { Fail "Warren didn't start. Its log is in $HOME\.warren\hub.log; 'warren service status' shows what's running. Run the installer again once it's fixed." }
    # the hub's own computer runs agents too, so one computer is enough to start
    if (-not $NoDevice) {
      Bold "Making this computer a device for your agents"
      $local = @("--local")
      if ($Name) { $local += @("--name", $Name) }
      $eap = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
      warren service install node @local
      if ($LASTEXITCODE -ne 0) { Write-Host "Couldn't set up this computer as a device; add it later in Warren -> Devices." }
      $ErrorActionPreference = $eap; $global:LASTEXITCODE = 0
      Write-Host "To give agents their own computers (VMs) here, run: warren setup"
    }
    Bold "Warren is running: http://localhost:$Port"
    $lan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -in @("Dhcp", "Manual") -and $_.IPAddress -notmatch '^(127\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' } | Select-Object -First 1 -ExpandProperty IPAddress
    if ($lan) { Write-Host "On other devices on this Wi-Fi: http://${lan}:$Port" }
    Write-Host "Open it to make your account. Setup then helps you use Warren from anywhere with Tailscale (free)."
    if (-not $NoOpen) { Start-Process "http://localhost:$Port" }
  }
} elseif ($Mode -eq "device") {
  Bold "Checking this device"
  # like install.sh: setup's advice (a VM engine, harnesses) is optional, so a non-zero exit code
  # from it must not stop the install before the device is connected
  $eap = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
  if ($Yes) { warren setup --yes } else { warren setup }
  $ErrorActionPreference = $eap; $global:LASTEXITCODE = 0
  $connect = @("--hub", $Hub, "--token", $Token)
  if ($Name) { $connect += @("--name", $Name) }
  if ($NoService) { Write-Host "Connect with: warren node start $($connect -join ' ')" }
  else { warren service install node @connect }
} else {
  Bold "Installed in $Dir"
  Write-Host "  warren hub start       run the hub in this terminal"
  Write-Host "  warren service --help  keep the hub or a device running"
}
