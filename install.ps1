# Install Wisp without questions: irm https://raw.githubusercontent.com/eireijie/wisp/main/install.ps1 | iex
# Join: & ([scriptblock]::Create((irm <origin>/install.ps1))) join [invite-link]
param(
  [Parameter(Position=0)][string]$Command = "",
  [Parameter(Position=1)][string]$Invite = "",
  [switch]$HubServer,
  [string]$Hub = "",
  [string]$Token = "",
  [string]$Name = "",
  [string]$Dir = $(if (Test-Path Env:WISP_DIR) { $env:WISP_DIR } elseif (Test-Path Env:WARREN_DIR) { $env:WARREN_DIR } else { Join-Path $HOME "wisp" }),
  [switch]$Yes,
  [switch]$NoService,
  [switch]$NoDevice,
  [switch]$NoOpen
)
$ErrorActionPreference = "Stop"
$GitHubRepo = "eireijie/wisp"
$Repo = if (Test-Path Env:WISP_REPO) { $env:WISP_REPO } elseif (Test-Path Env:WARREN_REPO) { $env:WARREN_REPO } else { "https://github.com/$GitHubRepo.git" }
# Reuse the old checkout when no directory was chosen.
if (-not $PSBoundParameters.ContainsKey("Dir") -and -not (Test-Path Env:WISP_DIR) -and -not (Test-Path Env:WARREN_DIR) -and -not (Test-Path $Dir) -and (Test-Path (Join-Path $HOME "warren/.git"))) { $Dir = Join-Path $HOME "warren" }
$Check = [char]0x2713
$Work = [char]0x25cc
$Arrow = [char]0x2192
function Fail($text) { Write-Host "$([char]0x2717) $text" -ForegroundColor Red; exit 1 }
if ($Command -and $Command -ne "join") { Fail "Usage: install.ps1 [join [invite-link]]" }
$Mode = if ($Command -eq "join") { "join" } elseif ($HubServer) { "hub" } elseif ($Hub) { "device" } else { "hub" }
if ($Hub -match '/join/[^/]+/?$') { $Mode = "join"; $Invite = $Hub }
if ($Mode -eq "device" -and (-not $Hub -or -not $Token)) { Fail "Use join [invite-link], or provide both -Hub and -Token." }
Write-Host "Wisp"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "Install Git, then run this installer again." }
$State = Join-Path $HOME ".wisp"
# An older Warren home moves to ~\.wisp with `wisp migrate` below; until then it stays in use.
$OldState = Join-Path $HOME ".warren"
if (-not (Test-Path $State) -and (Test-Path $OldState) -and -not ((Get-Item $OldState -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { $State = $OldState }
$Runtime = Join-Path $State "runtime\node"
$Log = Join-Path $State "install.log"
New-Item -ItemType Directory -Path $State -Force | Out-Null
function Quiet($exe, [string[]]$Arguments) {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Fail "Couldn't run $exe; run this installer again." }
  $global:LASTEXITCODE = 0
  $Previous = $ErrorActionPreference
  try {
    # Windows PowerShell treats redirected native stderr as errors, including Git progress.
    $ErrorActionPreference = "Continue"
    & $exe @Arguments >> $Log 2>&1
    $Code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $Previous }
  if ($Code -ne 0) { Fail "Couldn't finish getting ready; check $Log and run wisp doctor." }
}
function NodeMajor($exe) {
  try { return [int](& $exe -p "process.versions.node.split('.')[0]" 2>$null) } catch { return 0 }
}
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($NodeCommand) { $NodeCommand.Source } else { "" }
if (-not $Node -or (NodeMajor $Node) -lt 22) {
  $Node = Join-Path $Runtime "node.exe"
  if (-not (Test-Path $Node) -or (NodeMajor $Node) -lt 22) {
    Write-Host "$Work Getting Node 22 ready..."
    # Use the OS architecture even when PowerShell itself is emulated.
    $MachineArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $Arch = switch ($MachineArch) { "ARM64" { "arm64" } "AMD64" { "x64" } "x86" { "x86" } default { Fail "This computer needs a supported Node 22 installation." } }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $Base = "https://nodejs.org/dist/latest-v22.x"
    $Temp = Join-Path ([IO.Path]::GetTempPath()) ("wisp-install-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $Temp | Out-Null
    try {
      $Sums = (Invoke-WebRequest "$Base/SHASUMS256.txt" -UseBasicParsing).Content
      $Entry = @($Sums -split "`n" | Where-Object { $_ -match "node-v22\.[\d.]+-win-$Arch\.zip\s*$" })[0]
      if (-not $Entry) { Fail "Node 22 is unavailable for this computer." }
      $Fields = $Entry.Trim() -split '\s+'
      $Archive = Join-Path $Temp $Fields[1]
      Invoke-WebRequest "$Base/$($Fields[1])" -OutFile $Archive -UseBasicParsing
      if ((Get-FileHash $Archive -Algorithm SHA256).Hash -ne $Fields[0]) { Fail "The Node 22 download was incomplete; run this installer again." }
      Expand-Archive $Archive -DestinationPath $Temp
      $Extracted = Join-Path $Temp ($Fields[1] -replace '\.zip$', '')
      New-Item -ItemType Directory -Path (Split-Path $Runtime) -Force | Out-Null
      if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
      Move-Item $Extracted $Runtime
      Write-Host "$Check Downloaded Node 22"
    } finally { Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
$env:Path = (Split-Path $Node) + ";" + $env:Path
$Npm = Join-Path (Split-Path $Node) "npm.cmd"
if (Test-Path (Join-Path $Dir ".git")) {
  $Origin = git -C $Dir remote get-url origin
  if ($Origin -match "^(https://github.com/eireijie/warren(?:\.git)?|git@github.com:eireijie/warren\.git)$") { git -C $Dir remote set-url origin $Repo }
  Quiet git @("-C", $Dir, "pull", "--ff-only")
}
else {
  if (Test-Path $Dir) { Fail "$Dir exists; choose another folder with -Dir." }
  Quiet git @("clone", $Repo, $Dir)
}
Push-Location $Dir
try {
  $Dir = (Get-Location).Path
  Write-Host "$Work Getting Wisp ready..."
  Quiet $Npm @("ci", "--no-audit", "--no-fund", "--loglevel=error")
  Quiet $Npm @("ci", "--prefix", "bin", "--no-audit", "--no-fund", "--loglevel=error")
  if ($Mode -eq "hub") { Quiet $Npm @("run", "build", "--silent") }
  Write-Host "$Check Downloaded Wisp"
  # Move an older Warren home and services to Wisp before starting anything under the new name.
  Quiet $Node @((Join-Path $Dir "bin\wisp.mjs"), "migrate")
  if ($State -eq $OldState -and (Test-Path (Join-Path $HOME ".wisp"))) {
    if ($Node.StartsWith($OldState + "\")) { $Node = (Join-Path $HOME ".wisp") + $Node.Substring($OldState.Length) }
    $State = Join-Path $HOME ".wisp"
    $Log = Join-Path $State "install.log"
  }
  $Bin = Join-Path $HOME ".local\bin"
  New-Item -ItemType Directory -Path $Bin -Force | Out-Null
  # the old Warren commands, when they belong to this checkout or the old ~\warren one
  foreach ($Old in @("warren", "warren-mcp", "warren-hub")) {
    $OldEntry = Join-Path $Bin "$Old-entry.ps1"
    if ((Test-Path $OldEntry) -and ((Get-Content $OldEntry -Raw).Contains((Join-Path $Dir "bin\")) -or (Get-Content $OldEntry -Raw).Contains((Join-Path $HOME "warren\bin\")))) {
      Remove-Item $OldEntry, (Join-Path $Bin "$Old.cmd") -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($Alias in @("wisp", "wisp-mcp", "wisp-hub")) {
    $Script = Join-Path $Dir "bin\$Alias.mjs"
    # A distinct helper name avoids PowerShell selecting a script blocked by its execution policy.
    # An ASCII trampoline preserves Unicode paths through a UTF-8 PowerShell wrapper.
    $NodeLiteral = "'" + $Node.Replace("'", "''") + "'"
    $ScriptLiteral = "'" + $Script.Replace("'", "''") + "'"
    Set-Content -Path (Join-Path $Bin "$Alias-entry.ps1") -Encoding UTF8 -Value "& $NodeLiteral $ScriptLiteral @args`r`nexit `$LASTEXITCODE"
    Set-Content -Path (Join-Path $Bin "$Alias.cmd") -Encoding ASCII -Value "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0$Alias-entry.ps1`" %*`r`n"
  }
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($Bin -notin ($UserPath -split ';')) { [Environment]::SetEnvironmentVariable("Path", "$Bin;$UserPath", "User") }
  $env:Path = "$Bin;" + $env:Path
  # Invoke the selected runtime directly so the current PowerShell also works before PATH refresh.
  $Cli = Join-Path $Dir "bin\wisp.mjs"
  if ($Mode -eq "join") {
    $JoinArgs = @($Cli, "join")
    if ($Invite) { $JoinArgs += $Invite }
    if ($Name) { $JoinArgs += @("--name", $Name) }
    if ($NoService) { $JoinArgs += "--no-service" }
    & $Node @JoinArgs
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
  } elseif ($Mode -eq "device") {
    if ($NoService) { Write-Host "$Check Installed Wisp; use the existing connection flags with wisp node start" }
    else {
      $Connect = @($Cli, "service", "install", "node", "--hub", $Hub, "--token", $Token)
      if ($Name) { $Connect += @("--name", $Name) }
      Quiet $Node $Connect
      Write-Host "$Check This computer joined"
    }
  } elseif ($NoService) {
    Write-Host "$Check Installed Wisp; start it with: wisp service install hub"
  } else {
    Quiet $Node @($Cli, "service", "install", "hub")
    $Port = $null
    try { $Port = (& $Node $Cli "service" "status" "hub" "--json" | ConvertFrom-Json)[0].port } catch {}
    if (-not $Port) { $Port = if ($env:PORT) { $env:PORT } else { "4747" } }
    $Up = $false
    foreach ($i in 1..30) {
      try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null; $Up = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $Up) { Fail "Wisp did not start; run wisp doctor." }
    Write-Host "$Check Started Wisp (starts again when you log in)"
    try { & $Node $Cli "setup-code" 2>$null | Where-Object { $_ -notmatch "already has an owner" } | ForEach-Object { Write-Host $_ } } catch {}
    if (-not $NoDevice) {
      $LocalArgs = @($Cli, "service", "install", "node", "--local")
      if ($Name) { $LocalArgs += @("--name", $Name) }
      Quiet $Node $LocalArgs
      Write-Host "$Work Getting computers ready for agents..."
    }
    $Apps = @("claude", "codex", "gemini", "hermes", "kimi", "qwen") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
    if ($Apps) { Write-Host "$Check Found agent apps: $($Apps -join ', ')" }
    else { Write-Host "$Work Agent apps can be added in Wisp" }
    if ((Get-Command tailscale -ErrorAction SilentlyContinue) -or (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { Write-Host "$Check Found Tailscale" }
    Write-Host "Opening Wisp in your browser... http://localhost:$Port"
    if (-not $NoOpen) { Start-Process "http://localhost:$Port" }
  }
  Write-Host "Other computers $Arrow Install Wisp there, then run wisp join"
  Write-Host "Phones $Arrow Open Add a device in Wisp and scan the code"
  Write-Host "Stuck? $Arrow wisp doctor"
} finally { Pop-Location }
