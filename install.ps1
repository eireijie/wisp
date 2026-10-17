# Install Warren on Windows. In PowerShell:
#
#   irm https://raw.githubusercontent.com/eireijie/warren/main/install.ps1 | iex
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
  [switch]$NoService
)
$ErrorActionPreference = "Stop"
$Repo = if ($env:WARREN_REPO) { $env:WARREN_REPO } else { "https://github.com/eireijie/warren.git" }

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
  if ($NoService) { Bold "Start the hub with: warren hub start" }
  else {
    warren service install hub
    Bold "Warren is running at http://localhost:4747"
  }
  Write-Host "Open it in a browser to create your workspace. For HTTPS and phones, see $Dir\docs\deploy.md."
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
