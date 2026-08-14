<#
  CrossEx-Boros Terminal - Windows uninstaller.

    irm https://raw.githubusercontent.com/pendle-finance/crossex-boros-terminal/main/uninstall.ps1 | iex

  Removes the background task, the app, and its private Node.js runtime.
  Your API keys (config\) and trade history (data\) are KEPT unless you pass
  -Purge:

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/pendle-finance/crossex-boros-terminal/main/uninstall.ps1))) -Purge

  This is the Windows counterpart of uninstall.sh; the two are kept in step.
#>

[CmdletBinding()]
param([switch]$Purge)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root     = if ($env:BOROS_ROOT) { $env:BOROS_ROOT } else { Join-Path $env:LOCALAPPDATA 'CrossEx-Boros' }
# Resolved exactly as install.ps1 resolves it: the last-resort port guard below
# must check the port the server was actually installed on.
$Port     = if ($env:BOROS_PORT) { [int]$env:BOROS_PORT } else { 6688 }
$TaskName = 'CrossEx-Boros Terminal'
$AppTitle = 'CrossEx-Boros Terminal'
$ServerEntry = Join-Path $Root 'app\src\server\index.ts'
$RunnerPath  = Join-Path $Root 'run-server.ps1'

function Say { param([string]$m) Write-Host '==> ' -ForegroundColor Cyan -NoNewline; Write-Host $m }

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

# Unregistering the Scheduled Task stops the MANAGED instance only: a wedged one,
# one started by hand, or an orphan left by a previous crash survives it. Deleting
# the app folder around a live process would leave the reconcile loop placing,
# cancelling and hedging REAL orders against files that no longer exist - and with
# -Purge it would delete the trade journal out from under it, destroying the
# write-ahead order reservations anyone would need to reconcile against.
# So: stop it first, and if it will not stop, remove nothing.
function Stop-StaleServer {
  $procs = @(Get-ServerProcess)
  if ($procs.Count -eq 0) { return }
  Say 'Stopping a server instance that survived the service stop...'
  # Supervisor first, or killing node merely triggers a restart. The sort key
  # must tolerate a null CommandLine now that Get-ServerProcess can match on
  # ExecutablePath alone - and null sorts as "not the supervisor", which is
  # right: only powershell running the runner is the supervisor.
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

Say 'Stopping the background service...'
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
Stop-StaleServer

if (@(Get-ServerProcess).Count -gt 0) {
  # '' doubles a literal quote for the single-quoted -like patterns printed
  # below, so a root like C:\Users\O'Brien does not break the pasted command.
  $qRunner = $RunnerPath.Replace("'", "''")
  $qEntry  = $ServerEntry.Replace("'", "''")
  Write-Host ''
  Write-Host '  The trading server is STILL RUNNING and could not be stopped.' -ForegroundColor Red
  Write-Host '  Nothing was removed - it would keep trading against deleted files.' -ForegroundColor Red
  Write-Host '  Stop it manually, then re-run this uninstaller:' -ForegroundColor Red
  # The pasted command must take out the SUPERVISOR too, and FIRST: advice that
  # kills only node.exe cannot work - the supervisor loop respawns node within
  # seconds and the re-run uninstaller finds it running all over again.
  Write-Host "    Get-CimInstance Win32_Process |" -ForegroundColor Red
  Write-Host "      Where-Object { ('node.exe','powershell.exe','pwsh.exe') -contains `$_.Name -and `$_.CommandLine -and" -ForegroundColor Red
  Write-Host "        (`$_.CommandLine -like '*$qRunner*' -or `$_.CommandLine -like '*$qEntry*') } |" -ForegroundColor Red
  Write-Host "      Sort-Object { `$_.CommandLine -like '*$qRunner*' } -Descending |" -ForegroundColor Red
  Write-Host "      ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }" -ForegroundColor Red
  # throw, not exit: run via `irm | iex`, `exit` would close the user's session.
  throw 'refusing to remove anything while the trading server is still running'
}

# Belt-and-suspenders, and the LAST line of defence before anything is deleted:
# an ELEVATED server is invisible to the non-elevated WMI query above - Windows
# returns null for both its CommandLine and its ExecutablePath - so the process
# scan can come up empty while a live engine is still trading. What elevation
# cannot hide is the LISTENING PORT. The task is unregistered and the stale-server
# reap has run, so nothing of ours should be listening; if something still is,
# refuse to delete. Yes, this also trips if some unrelated program happens to sit
# on the port - a false positive that merely makes the user look is an acceptable
# cost for an uninstaller whose one job is to never delete the app, the API keys,
# or the ledger out from under a live trading engine.
$stillListening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($stillListening.Count -gt 0) {
  $ownerPids = ($stillListening | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique) -join ', '
  Write-Host ''
  Write-Host "  Something is STILL LISTENING on port $Port (PID $ownerPids) - most likely the" -ForegroundColor Red
  Write-Host '  trading server running elevated, where this uninstaller can neither see nor' -ForegroundColor Red
  Write-Host '  stop it. Nothing was removed - it would keep trading against deleted files.' -ForegroundColor Red
  Write-Host '  Stop it (from an elevated PowerShell if it is elevated), then re-run this' -ForegroundColor Red
  Write-Host '  uninstaller:' -ForegroundColor Red
  Write-Host "    Stop-Process -Id $ownerPids -Force" -ForegroundColor Red
  Write-Host '  (If the port fills again seconds later, an elevated supervisor is respawning' -ForegroundColor Red
  Write-Host '  the server: from that elevated shell, stop the powershell.exe running' -ForegroundColor Red
  Write-Host '  run-server.ps1 first, then node.exe.)' -ForegroundColor Red
  # throw, not exit: run via `irm | iex`, `exit` would close the user's session.
  throw "refusing to remove anything while port $Port is still in use"
}

Say 'Removing the app and its private Node.js runtime...'
foreach ($d in @('app', 'app.new', 'app.old', 'node', 'logs')) {
  $p = Join-Path $Root $d
  if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
$runner = Join-Path $Root 'run-server.ps1'
if (Test-Path $runner) { Remove-Item -Force $runner -ErrorAction SilentlyContinue }

$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppTitle.url"
if (Test-Path $lnk) { Remove-Item -Force $lnk -ErrorAction SilentlyContinue }

if ($Purge) {
  Say 'Removing API keys and trade history (-Purge)...'
  if (Test-Path $Root) { Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue }
} else {
  # Gone entirely if config/data were never created.
  if ((Test-Path $Root) -and -not (Get-ChildItem -Path $Root -Force | Select-Object -First 1)) {
    Remove-Item -Force $Root -ErrorAction SilentlyContinue
  }
  if (Test-Path $Root) {
    Write-Host ''
    Write-Host "  Kept your API keys and trade history in $Root"
    Write-Host "  Remove them too with: Remove-Item -Recurse -Force '$Root'"
  }
}

Write-Host ''
Say 'Uninstalled.'
