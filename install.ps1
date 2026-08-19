<#
  Arbitrage with CrossEx - Windows installer.

  Usage (paste into PowerShell):
    irm https://raw.githubusercontent.com/pendle-finance/arbitrage-with-crossex/main/install.ps1 | iex

  What this script does - and everything it does:
    1. Downloads a private copy of Node.js (official nodejs.org build, checksum
       verified) into %LOCALAPPDATA%\CrossEx-Boros - it does NOT touch your
       system, your PATH, or any other program, and never needs Administrator.
    2. Downloads the app from GitHub into that same folder.
    3. Installs the app's dependencies and builds its web interface.
    4. Registers a background Scheduled Task so the app is always running for
       you, even after you restart Windows.
    5. Opens http://localhost:6688 in your browser and puts a shortcut in your
       Start Menu. Your Gate.io API keys are entered later, in the browser -
       never in this terminal.

  Re-running this command updates the app in place - it stops the previously
  running version first (including any orphaned/wedged copy), so an old version
  never lingers. Your keys and trade history are never touched.

  This is the Windows counterpart of install.sh; the two are kept in step.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far faster without it

# ---------------------------------------------------------------------------
# Configuration (BOROS_* env vars exist for development/testing overrides)
# ---------------------------------------------------------------------------
$RepoSlug = if ($env:BOROS_REPO)   { $env:BOROS_REPO }   else { 'pendle-finance/arbitrage-with-crossex' }
$Branch   = if ($env:BOROS_BRANCH) { $env:BOROS_BRANCH } else { 'main' }
# Pin an exact commit, tag or branch: BOROS_REF wins over BOROS_BRANCH. This is
# how you install the very tree you audited - see "Install exactly what you
# audited" in the README.
$Ref      = $env:BOROS_REF
$Port     = if ($env:BOROS_PORT)   { [int]$env:BOROS_PORT } else { 6688 }
$Root     = if ($env:BOROS_ROOT)   { $env:BOROS_ROOT }   else { Join-Path $env:LOCALAPPDATA 'CrossEx-Boros' }
$NodeLine = 'v24'
$TaskName = 'Arbitrage with CrossEx'
$AppTitle = 'Arbitrage with CrossEx'
# Display names this app shipped under before. The scheduled task and the Start
# Menu shortcut are keyed BY NAME, so a rename orphans the old ones: the old task
# keeps launching the old install and the two servers fight over the port.
# APPEND the outgoing name on every rename - never replace the list.
# ($Root is deliberately NOT renamed alongside these: it holds the API keys and
# the trade ledger, and moving it would risk orphaning both.)
$LegacyTitles = @('CrossEx-Boros Terminal', 'Boros CrossEx Terminal')
$LogDir   = Join-Path $Root 'logs'

$ServerEntry = Join-Path $Root 'app\src\server\index.ts'
$RunnerPath  = Join-Path $Root 'run-server.ps1'
$Tmp = $null

function Say  { param([string]$m) Write-Host '==> ' -ForegroundColor Cyan -NoNewline; Write-Host $m }
function Fail {
  # throw, not exit: this script is normally run as `irm ... | iex`, where `exit`
  # would terminate the user's entire PowerShell session rather than the install.
  param([string]$m)
  throw "Arbitrage with CrossEx install failed: $m"
}

# `$IsWindows` exists only in PowerShell 6+; on Windows PowerShell 5.1 it is undefined.
$IsWindowsLike = if (Get-Variable -Name IsWindows -Scope Global -ErrorAction SilentlyContinue) {
  $IsWindows
} else {
  $env:OS -eq 'Windows_NT'
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
function Invoke-Preflight {
  if (-not $IsWindowsLike) { Fail 'this installer is for Windows only - on macOS use install.sh.' }
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    Fail "PowerShell 5 or newer is required (found $($PSVersionTable.PSVersion))."
  }
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($admin) {
    Write-Host 'Note: running as Administrator is not required - nothing here needs it.' -ForegroundColor Yellow
  }

  $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("boros-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $script:Tmp | Out-Null
  foreach ($d in @($Root, (Join-Path $Root 'config'), (Join-Path $Root 'data'), $LogDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
  # config holds the live-money API secret; data holds the full trade journal.
  # chmod means nothing on Windows, so tighten the ACL explicitly.
  foreach ($d in @((Join-Path $Root 'config'), (Join-Path $Root 'data'))) {
    Protect-Directory $d
  }
}

# Restrict a directory to the current user, SAFELY.
#
# The obvious one-liner - `icacls $d /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"` -
# is a trap. It strips every inherited ACE first, and if the grant then fails to
# resolve the account (domain-joined machines, renamed or non-ASCII accounts, a
# localised Windows) the folder is left with an EMPTY DACL that locks out even
# its owner. The app then cannot open its own database: SQLITE_CANTOPEN, with
# nothing in the installer output to explain why.
#
# So: grant FIRST and by SID (which always resolves), only drop inheritance once
# we know we still have access, and prove the result is writable - restoring
# Windows defaults if any of that fails. A folder with slightly wider
# permissions is recoverable; one nobody can open is not.
function Protect-Directory {
  param([string]$Path)
  $sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value

  # No /t on either call, deliberately. (OI)(CI) are INHERITANCE flags and mean
  # nothing on a file, so applying this recursively rewrites existing files'
  # ACEs, and the following /inheritance:r /t then strips what they did have.
  # That is exactly how an existing deals.sqlite became unopenable
  # (SQLITE_CANTOPEN) on a re-install while a brand-new one was fine. NTFS
  # propagates an inheritable ACE to children by itself - recursion is not only
  # unnecessary here, it is the bug.
  $out = & icacls $Path '/grant:r' "*${sid}:(OI)(CI)F" 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Note: could not tighten permissions on $Path - leaving Windows defaults." -ForegroundColor Yellow
    Write-Host "      $out" -ForegroundColor DarkGray
    return
  }
  & icacls $Path '/inheritance:r' 2>&1 | Out-Null

  # Prove it, and prove it the way the app will actually use the folder.
  $ok = $true
  $why = ''
  try {
    $probe = Join-Path $Path ('.probe-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    [IO.File]::WriteAllText($probe, 'x')
    # Re-OPEN it, not just create it: SQLite opens an existing file read-write,
    # and a create-only probe cannot tell the difference.
    ([IO.File]::Open($probe, 'Open', 'ReadWrite')).Dispose()
    Remove-Item -Force $probe
  } catch {
    $ok = $false; $why = $_.Exception.Message
  }
  if ($ok) {
    # Existing files matter as much as new ones - on a re-install the ledger is
    # already sitting here, and a new-file probe would happily pass while the
    # database itself had been locked away.
    foreach ($f in @(Get-ChildItem -File -Force $Path -ErrorAction SilentlyContinue)) {
      try { ([IO.File]::Open($f.FullName, 'Open', 'ReadWrite')).Dispose() }
      catch { $ok = $false; $why = "$($f.Name): $($_.Exception.Message)"; break }
    }
  }
  if (-not $ok) {
    Write-Host "Note: $Path is not usable after tightening - restoring inherited permissions." -ForegroundColor Yellow
    Write-Host "      $why" -ForegroundColor DarkGray
    & icacls $Path '/reset' '/t' '/c' 2>&1 | Out-Null
  }
}

# Windows refuses to move or delete anything with an open handle, and handles can
# linger briefly after a process exits (antivirus and the Search indexer both scan
# a folder the moment it stops changing). Retry a filesystem op before giving up.
function Invoke-WithRetry {
  param([scriptblock]$Action, [int]$Tries = 10, [int]$DelayMs = 500)
  for ($i = 1; $i -le $Tries; $i++) {
    try { & $Action; return } catch {
      if ($i -eq $Tries) { throw }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Remove-Temp {
  if ($script:Tmp -and (Test-Path $script:Tmp)) {
    Remove-Item -Recurse -Force $script:Tmp -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# Step 1: private Node.js runtime (no Administrator, no PATH changes)
# ---------------------------------------------------------------------------
function Get-NodeArch {
  # PROCESSOR_ARCHITEW6432 is set when a 32-bit shell runs on a 64-bit OS.
  $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($a) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { Fail "unsupported architecture: $a" }
  }
}

function Install-Node {
  $nodeExe = Join-Path $Root 'node\node.exe'
  if (Test-Path $nodeExe) {
    $v = (& $nodeExe -v 2>$null)
    if ($v -and $v.StartsWith($NodeLine)) { Say "Node.js $v already installed - skipping."; return }
  }
  $arch = Get-NodeArch
  Say "Downloading Node.js (official nodejs.org build, $arch)..."
  $base = "https://nodejs.org/dist/latest-$NodeLine.x"
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content

  $line = $sums -split "`n" | Where-Object { $_ -match "node-$NodeLine[\d.]*-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Fail "could not resolve the latest Node.js $NodeLine zip for win-$arch." }
  $parts = $line.Trim() -split '\s+'
  $expected = $parts[0]
  $file = $parts[-1]

  $zip = Join-Path $script:Tmp $file
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $zip

  Say 'Verifying checksum...'
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) {
    Fail 'Node.js download failed checksum verification.'
  }

  Expand-Archive -Path $zip -DestinationPath $script:Tmp -Force
  $extracted = Join-Path $script:Tmp ([IO.Path]::GetFileNameWithoutExtension($file))
  $target = Join-Path $Root 'node'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item -Path $extracted -Destination $target
  Say "Node.js $(& (Join-Path $target 'node.exe') -v) installed into $Root."
}

function Install-Yarn {
  $nodeDir = Join-Path $Root 'node'
  $yarn = Join-Path $nodeDir 'yarn.cmd'
  if (Test-Path $yarn) { return }
  Say 'Installing the yarn package manager (into the private runtime only)...'
  $npm = Join-Path $nodeDir 'npm.cmd'
  # --prefix is not optional here. On Windows npm's global prefix defaults to
  # %APPDATA%\npm, NOT the folder holding node.exe, so a bare `install -g` would
  # scatter yarn outside the private runtime - and $Root\node\yarn.cmd, which
  # everything downstream calls, would never appear. Pinning the prefix keeps the
  # runtime self-contained and removable in one delete, which is the promise the
  # installer makes.
  & $npm install -g --silent --prefix "$nodeDir" 'yarn@1.22.22' 2>&1 | Out-Null
  if (-not (Test-Path $yarn)) {
    Fail "yarn installation failed (expected $yarn)."
  }
}

# ---------------------------------------------------------------------------
# Step 2+3: fetch the app and build it (staged in app.new, then swapped in)
# ---------------------------------------------------------------------------
# The commit a GitHub archive was cut from. `git archive` - which generates
# every /archive/ download - stores the full sha as the ZIP's archive comment,
# in the last bytes of the file. Exact, offline, no API call. Best effort by
# design: an install must never fail over provenance.
function Get-ArchiveCommit {
  param([string]$Path)
  try {
    $fs = [IO.File]::OpenRead($Path)
    try {
      $take = [int][Math]::Min(1024, $fs.Length)
      $fs.Seek(-$take, 'End') | Out-Null
      $buf = New-Object byte[] $take
      [void]$fs.Read($buf, 0, $take)
      if ([Text.Encoding]::ASCII.GetString($buf) -match '([0-9a-f]{40})\s*$') { return $Matches[1] }
    } finally { $fs.Dispose() }
  } catch { }
  return $null
}

# Record WHAT was installed, next to the code it describes: app.new is swapped
# into place atomically, so this file can never describe a different tree.
# Surfaced by the app in Settings -> About and on GET /api/version.
function Write-InstallInfo {
  param([string]$New, [string]$Commit, [string]$Requested, [string]$Source)
  @{
    schema       = 1
    repo         = $RepoSlug
    requestedRef = $Requested
    commit       = $Commit
    source       = $Source
    installedAt  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    installer    = 'install.ps1'
  } | ConvertTo-Json | Set-Content -Path (Join-Path $New 'install-info.json') -Encoding UTF8
}

function Get-App {
  Say 'Downloading the app...'
  $new = Join-Path $Root 'app.new'
  if (Test-Path $new) { Remove-Item -Recurse -Force $new }
  New-Item -ItemType Directory -Force -Path $new | Out-Null

  $stage = Join-Path $script:Tmp 'app-zip'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  if ($env:BOROS_ZIP) {
    $zip = $env:BOROS_ZIP
    $requested = ''
    $source = 'local-archive'
  } else {
    $zip = Join-Path $script:Tmp 'app.zip'
    if ($Ref) {
      $requested = $Ref
      $url = "https://github.com/$RepoSlug/archive/$Ref.zip"
    } else {
      $requested = "refs/heads/$Branch"
      $url = "https://github.com/$RepoSlug/archive/refs/heads/$Branch.zip"
    }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    } catch {
      Fail "could not download '$requested' from $RepoSlug - does it exist?"
    }
    $source = 'github-archive'
  }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  # GitHub zips wrap everything in one folder (named for the ref, whatever its
  # kind) - strip it, the equivalent of tar --strip-components=1.
  $inner = Get-ChildItem -Path $stage -Directory | Select-Object -First 1
  if (-not $inner) { Fail 'app download looks incomplete (empty archive).' }
  Get-ChildItem -Path $inner.FullName -Force | Move-Item -Destination $new

  if (-not (Test-Path (Join-Path $new 'package.json'))) {
    Fail 'app download looks incomplete (no package.json).'
  }
  Write-InstallInfo -New $new -Commit (Get-ArchiveCommit $zip) -Requested $requested -Source $source
}

function Build-App {
  $yarn = Join-Path $Root 'node\yarn.cmd'
  $new = Join-Path $Root 'app.new'
  $env:PATH = "$(Join-Path $Root 'node');$env:PATH"
  Say 'Installing dependencies (this takes a minute on first install)...'
  & $yarn --cwd $new install --frozen-lockfile --silent --non-interactive
  if ($LASTEXITCODE -ne 0) { Fail 'dependency installation failed.' }
  & $yarn --cwd (Join-Path $new 'web') install --frozen-lockfile --silent --non-interactive
  if ($LASTEXITCODE -ne 0) { Fail 'web dependency installation failed.' }
  Say 'Building the web interface...'
  & $yarn --cwd (Join-Path $new 'web') --silent build | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'web build failed.' }
}

function Swap-App {
  # Stop-RunningService MUST have run before this. On POSIX a directory can be
  # renamed while its files are open, which is why install.sh gets away with
  # swapping first and stopping second; Windows locks them, so moving $Root\app
  # while the previous server still holds a file inside it fails outright with
  # "being used by another process".
  $app = Join-Path $Root 'app'
  $old = Join-Path $Root 'app.old'
  $new = Join-Path $Root 'app.new'
  if (Test-Path $old) { Invoke-WithRetry { Remove-Item -Recurse -Force $old } }
  if (Test-Path $app) { Invoke-WithRetry { Move-Item -Path $app -Destination $old } }
  Invoke-WithRetry { Move-Item -Path $new -Destination $app }
  if (Test-Path $old) { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
}

# Both halves of the service: the node server AND the PowerShell supervisor that
# restarts it. Stopping only node is pointless - the supervisor would bring it
# straight back.
#
# Constrained to the executables that can actually BE the service. Matching on
# command line alone is not enough: these processes are force-killed, and an
# editor or a grep holding one of these paths as an argument
# (`notepad ...\run-server.ps1`) would match and be killed too. Path AND
# executable, so nothing else can ever be caught - and the ExecutablePath clause
# is the same idea inverted: the private runtime's own node.exe identifies the
# service all by itself.
#
# Two ways a live server used to dodge this match, both closed here:
#   - Windows paths are case-insensitive, but String.Contains is ordinal and
#     case-SENSITIVE: a server started by hand with a differently-cased path
#     (`node c:\users\...`) was never matched. IndexOf with OrdinalIgnoreCase
#     compares the way the filesystem does. (-like is case-insensitive too, but
#     treats [ ] ? * in a path as wildcards, so it is deliberately avoided.)
#   - A server started with RELATIVE arguments from inside the app folder has no
#     absolute path in its command line at all. But node.exe under $Root\node\
#     cannot be running anything except this service, so any process whose
#     ExecutablePath sits there is ours no matter how it was launched - that
#     clause needs no command line whatsoever.
# An ELEVATED server hides BOTH CommandLine and ExecutablePath from this
# non-elevated WMI query and still slips through; the port checks that follow in
# each script exist to catch exactly that case.
function Get-ServerProcess {
  $exes = @('node.exe', 'powershell.exe', 'pwsh.exe')
  # Trailing backslash on purpose: a bare "$Root\node" prefix would also match a
  # sibling like "$Root\node-v22\node.exe"; the separator pins it to the folder.
  $nodeDir = (Join-Path $Root 'node') + '\'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -and ($exes -contains $_.Name.ToLowerInvariant()) -and (
        ($_.CommandLine -and (
          $_.CommandLine.IndexOf($ServerEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $_.CommandLine.IndexOf($RunnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        )) -or
        ($_.ExecutablePath -and
          $_.ExecutablePath.StartsWith($nodeDir, [StringComparison]::OrdinalIgnoreCase))
      )
    }
}

function Stop-StaleServer {
  # Unregistering the task stops the MANAGED instance, but a wedged one - or one
  # started by hand, or an orphan a previous crash left behind - can survive and
  # keep holding the port and the trade-journal lock, which would block the
  # update and leave an old version trading.
  $procs = @(Get-ServerProcess)
  if ($procs.Count -eq 0) { return }
  Say 'Stopping the previous version still running...'
  # Supervisor first: killing node while its supervisor lives just triggers a
  # restart, and we would chase it forever. The sort key must tolerate a null
  # CommandLine now that Get-ServerProcess can match on ExecutablePath alone -
  # and null sorts as "not the supervisor", which is right: only powershell
  # running the runner is the supervisor.
  foreach ($p in ($procs | Sort-Object { $_.CommandLine -and $_.CommandLine.IndexOf($RunnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 } -Descending)) {
    Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  }
  foreach ($i in 1..12) {
    Start-Sleep -Milliseconds 500
    if (@(Get-ServerProcess).Count -eq 0) { return }
  }
  foreach ($p in @(Get-ServerProcess)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}

function Test-PortInUseByOther {
  # Called after the task is removed and stale servers are reaped, so our own
  # instances are gone: anything still listening is another program.
  foreach ($i in 1..6) {
    $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $busy) { return $false }
    Start-Sleep -Milliseconds 500
  }
  return $true
}

function Write-RunnerScript {
  # The Scheduled Task runs this. A PowerShell runner (rather than a .cmd) is
  # what lets the window be genuinely hidden, and it keeps the environment the
  # server needs in ONE place: the config dir and data dir live outside the app
  # folder precisely so an update can replace the app without touching them.
  $runner = Join-Path $Root 'run-server.ps1'
  # '' is PowerShell's escape for a literal quote inside a single-quoted string:
  # without this a user folder like C:\Users\O'Brien would end the string early.
  $qRoot  = $Root.Replace("'", "''")
  $outLog = (Join-Path $LogDir 'server.out.log').Replace("'", "''")
  $errLog = (Join-Path $LogDir 'server.err.log').Replace("'", "''")
  @"
# Generated by install.ps1 - regenerated on every install. Do not edit.

# NOT 'Stop'. This launches a long-running NATIVE process, and PowerShell turns
# redirected native stderr into ErrorRecords - under 'Stop' the first one is a
# terminating error. Node prints an ExperimentalWarning for node:sqlite on every
# single start, so 'Stop' killed the server the moment it booted and nothing ever
# reached the port.
`$ErrorActionPreference = 'Continue'

`$root = '$qRoot'
`$env:PATH = "`$root\node;`$env:PATH"
`$env:NODE_ENV = 'production'
`$env:PORT = '$Port'
`$env:DOTENV_CONFIG_PATH = "`$root\config\.env"
`$env:ARB_DATA_DIR = "`$root\data"
Set-Location "`$root\app"

# Start-Process, not a call with 2>> redirection: this wires the process's real
# stdout and stderr handles straight to the files, so PowerShell never inspects,
# wraps or reformats a single line of them. Splatted via a hashtable because a
# backtick line-continuation inside a here-string escapes the newline instead.
#
# Each ArgumentList element carries its OWN embedded double quotes. Windows
# PowerShell 5.1 - the powershell.exe the Scheduled Task explicitly runs - joins
# ArgumentList elements with spaces and does NOT quote them, so a bare path
# under a root containing a space (C:\Users\John Smith\AppData\...) would be
# split into several node arguments: node exits instantly and the supervisor
# loop below retries the same broken command forever. The embedded quotes
# survive 5.1's naive space-join and deliver each path to CreateProcess as ONE
# argument. (PowerShell 7.3+ quotes elements itself and would double-quote
# these, but this runner is only ever executed by powershell.exe 5.1 - that is
# the executable install.ps1 puts in the Scheduled Task action.)
`$startArgs = @{
  FilePath               = "`$root\node\node.exe"
  ArgumentList           = @("``"`$root\app\node_modules\tsx\dist\cli.mjs``"", "``"`$root\app\src\server\index.ts``"")
  NoNewWindow            = `$true
  Wait                   = `$true
  PassThru               = `$true
  RedirectStandardOutput = '$outLog'
  RedirectStandardError  = '$errLog'
}
# Supervisor loop. BOTH of Task Scheduler's own restart mechanisms proved
# unreliable here: restart-on-failure did not fire when the process was killed,
# and a repetition attached to an at-logon trigger never ticks when the task is
# registered after logon and started by hand - the trigger has no StartBoundary,
# so the repetition window never opens. Verified on Windows 11: the task went
# back to Ready and sat there. Supervising from inside the task instance depends
# on none of that, and recovers in seconds rather than a minute.
`$fails = 0
while (`$true) {
  `$startedAt = Get-Date
  `$p = Start-Process @startArgs
  `$ranSeconds = ((Get-Date) - `$startedAt).TotalSeconds

  # A server that dies within seconds is misconfigured (bad port, unreadable
  # ledger), not merely crashed - back off so it cannot spin.
  if (`$ranSeconds -lt 20) { `$fails++ } else { `$fails = 0 }
  Start-Sleep -Seconds ([Math]::Min(60, 5 * [Math]::Max(1, `$fails)))
}
"@ | Set-Content -Path $runner -Encoding UTF8
  return $runner
}

# Runs BEFORE the app directory is swapped. Ordering matters on Windows: the
# previous server holds open handles inside $Root\app, and nothing can move that
# directory until it exits.
function Stop-RunningService {
  Say 'Stopping any running instance...'
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  # Tasks registered under a previous product name. Without this, an upgrade
  # across a rename leaves the old task registered and starting the old app -
  # two servers, one port. This is what makes the rename a safe UPDATE.
  foreach ($legacy in $LegacyTitles) {
    Stop-ScheduledTask -TaskName $legacy -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $legacy -Confirm:$false -ErrorAction SilentlyContinue
  }
  Stop-StaleServer   # reap any old/orphaned server so re-running always updates

  if (Test-PortInUseByOther) {
    Fail @"
port $Port is already in use by another program.
  See what it is with:  Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object OwningProcess
  Quit that program and re-run this installer (or set BOROS_PORT to another port).
"@
  }
}

function Install-Service {
  Say 'Registering the background service...'
  # Keep the always-on logs from growing without bound: reset on each (re)install.
  Set-Content -Path (Join-Path $LogDir 'server.out.log') -Value '' -Encoding UTF8
  Set-Content -Path (Join-Path $LogDir 'server.err.log') -Value '' -Encoding UTF8

  $runner = Write-RunnerScript
  # conhost.exe, NOT powershell.exe with -WindowStyle Hidden. That flag cannot do
  # the job: Windows allocates the console at CreateProcess, before PowerShell has
  # parsed a single argument of its own, and the console is then handed to whatever
  # the user's default terminal is. Where that is Windows Terminal - the default on
  # a clean Windows 11 install - WT launches itself and shows a window, ignoring the
  # SW_HIDE that PowerShell applies a moment later. The "background service" came up
  # as a terminal window on the desktop, and closing that window killed the
  # supervisor and left node.exe orphaned on the port with nothing watching it.
  # Machines that still delegate to classic conhost honour the late hide and were
  # never affected - which is why this reproduces on some boxes and not others.
  #
  # --headless creates no window at all, so the handoff never happens. It is how
  # CreatePseudoConsole spawns conhost internally and has shipped since Windows 10
  # 1809. conhost stays alive as the child's console host for as long as the
  # supervisor runs, so the task instance stays Running and the one-minute
  # repetition trigger below keeps behaving as a no-op under IgnoreNew.
  $action = New-ScheduledTaskAction -Execute 'conhost.exe' `
    -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
  # Keepalive by REPETITION, not by restart-on-failure. Task Scheduler's "if the
  # task fails, restart every N" keys off the action's exit code and quietly does
  # not fire in a number of ordinary cases - it did not bring the server back
  # when the process was killed under test. A trigger that simply re-runs every
  # minute is the dependable pattern: paired with MultipleInstances = IgnoreNew
  # it is a no-op while the server is healthy, and the moment it is not, the next
  # tick starts it again. RestartCount stays as a second line of defence.
  #
  # The repetition has to be grafted from a -Once trigger: New-ScheduledTaskTrigger
  # will not take -RepetitionInterval together with -AtLogOn.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)).Repetition

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

# ---------------------------------------------------------------------------
# Step 5: open the app, create the launcher
# ---------------------------------------------------------------------------
function Wait-ForServer {
  Say 'Waiting for the app to start...'
  # 127.0.0.1, never 'localhost'. The server binds IPv4 loopback (HOST defaults
  # to 127.0.0.1), while Windows resolves 'localhost' to ::1 FIRST - a client
  # that does not fall back to IPv4 never reaches a server that is plainly
  # listening. The Host/Origin guard accepts 127.0.0.1 just as readily.
  $uri = "http://127.0.0.1:$Port/api/health"
  $last = 'no attempt made'

  # Stage 1: is anything accepting connections? A raw socket answers that with
  # no DNS ambiguity and no proxy in the way.
  $listening = $false
  foreach ($i in 1..120) {
    $c = New-Object Net.Sockets.TcpClient
    try {
      $c.Connect('127.0.0.1', $Port)
      if ($c.Connected) { $listening = $true; break }
    } catch {
      $last = $_.Exception.Message
    } finally {
      $c.Close()
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $listening) {
    Fail @"
the app never started listening on port $Port.
  Log: $LogDir\server.err.log
  Last error: $last
"@
  }

  # Stage 2: confirm it is really our API. WebClient with Proxy = $null, not
  # Invoke-WebRequest, which inherits the system proxy and will cheerfully try to
  # route a loopback request through it on a machine configured for one.
  foreach ($i in 1..20) {
    try {
      $wc = New-Object Net.WebClient
      $wc.Proxy = $null
      $body = $wc.DownloadString($uri)
      if ($body -match '"status"\s*:\s*"ok"') { return }
      $last = "unexpected health response: $body"
    } catch {
      $last = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }

  # The port is open, so the app IS running - only our verification failed. Say
  # so and carry on rather than failing an install that actually succeeded.
  Write-Host "Note: port $Port is open but the health check did not confirm it ($last)." -ForegroundColor Yellow
  Write-Host "      The app is most likely fine - open http://127.0.0.1:$Port to check." -ForegroundColor Yellow
}

function New-Launcher {
  # A plain internet shortcut in the Start Menu - nothing to sign, nothing for
  # SmartScreen to object to.
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  New-Item -ItemType Directory -Force -Path $programs | Out-Null
  # Shortcuts left by a previous product name - otherwise the Start Menu keeps
  # one entry per name this app has ever had, all pointing at the same port.
  foreach ($legacy in $LegacyTitles) {
    Remove-Item -Path (Join-Path $programs "$legacy.url") -Force -ErrorAction SilentlyContinue
  }
  $lnk = Join-Path $programs "$AppTitle.url"
  "[InternetShortcut]`r`nURL=http://localhost:$Port`r`n" | Set-Content -Path $lnk -Encoding ASCII
}

# ---------------------------------------------------------------------------
try {
  Write-Host ''
  Say "Installing $AppTitle into $Root"
  Write-Host '    (no Administrator password needed; your system setup is not modified)'
  Write-Host ''
  Invoke-Preflight
  Install-Node
  Install-Yarn
  Get-App
  Build-App
  Stop-RunningService   # must precede Swap-App - see the note there
  Swap-App
  Install-Service
  Wait-ForServer
  New-Launcher
  Write-Host ''
  Say "Done! Opening http://localhost:$Port ..."
  Write-Host ''
  Write-Host "  * The app now runs in the background, and starts again when you sign in."
  Write-Host "  * Open it any time at http://localhost:$Port (bookmark it!) or via"
  Write-Host "    `"$AppTitle`" in your Start Menu."
  Write-Host '  * First time? The app will ask for your Gate.io API keys in the browser.'
  Write-Host '  * Update any time by re-running the install command.'
  Write-Host ''
  Start-Process "http://localhost:$Port" | Out-Null
} finally {
  Remove-Temp
}
