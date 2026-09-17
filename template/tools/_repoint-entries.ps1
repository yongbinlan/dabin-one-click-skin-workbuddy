param(
  [string]$Exe = ""
)
$ErrorActionPreference = "Stop"
# NOTE: param() MUST be the first statement in the file. Anything executable
# above it -- even $ErrorActionPreference = "Stop" -- makes PowerShell stop
# seeing a param block at all and parse the parentheses as a command call,
# which fails with "InvalidLeftHandSide" pointing at the first default value.
# So the settings line lives *below* the param block, not above it.
#
# NOTE: intentionally pure ASCII -- PowerShell 5.1 parses a BOM-less .ps1 as
# ANSI/GBK on this machine, so non-ASCII literals here would corrupt paths.
#
# PORTABLE: nothing below is tied to one machine.
#   * $root comes from this script's own location (<root>\tools\*.ps1 -> <root>)
#   * user folders (Desktop / Start Menu / TaskBar) come from the environment
#   * the app exe is auto-detected, with an optional -Exe override
$ws = New-Object -ComObject WScript.Shell

$root   = Split-Path -Parent $PSScriptRoot
$backup = Join-Path $root "backup"
if (-not (Test-Path -LiteralPath $backup)) { New-Item -ItemType Directory -Path $backup | Out-Null }
$vbs = Join-Path $root "launcher\workbuddy-skin-launcher.vbs"

if (-not $Exe) {
  $cand = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'),
    (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'WorkBuddy\WorkBuddy.exe')
  )
  foreach ($c in $cand) { if ($c -and (Test-Path -LiteralPath $c)) { $Exe = $c; break } }
}

$desktop  = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$taskbar  = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'

$entries = @(
  @{ path = (Join-Path $desktop  'WorkBuddy.lnk'); tag = "desktop" },
  @{ path = (Join-Path $programs 'WorkBuddy.lnk'); tag = "startmenu" },
  @{ path = (Join-Path $taskbar  'WorkBuddy.lnk'); tag = "taskbar" }
)

Write-Output "--- step 1: repoint native entries at the skin launcher ---"
foreach ($e in $entries) {
  if (-not (Test-Path -LiteralPath $e.path)) { Write-Output ("SKIP-MISSING " + $e.tag); continue }
  $sc  = $ws.CreateShortcut($e.path)
  $old = $sc.TargetPath
  Write-Output ("BEFORE " + $e.tag + " | targetWasExe=" + ($old -match "WorkBuddy\.exe") + " | argsWasEmpty=" + [string]::IsNullOrEmpty($sc.Arguments))

  $bak = Join-Path $backup ("WorkBuddy.lnk." + $e.tag + ".original")
  if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $e.path -Destination $bak -Force }

  $sc.TargetPath       = Join-Path $env:SystemRoot "System32\wscript.exe"
  $sc.Arguments        = '"' + $vbs + '"'
  $sc.WorkingDirectory = $root
  if ($Exe) { $sc.IconLocation = ($Exe + ",0") }
  $sc.Save()

  $chk = $ws.CreateShortcut($e.path)
  Write-Output ("AFTER  " + $e.tag + " | targetIsWscript=" + ($chk.TargetPath -match "wscript\.exe") + " | pointsAtOurVbs=" + ($chk.Arguments -match "workbuddy-skin-launcher\.vbs"))
}

Write-Output "--- step 2: archive the throwaway test shortcut (WorkBuddy*.lnk except WorkBuddy.lnk) ---"
$testDirs = @(
  @{ dir = $desktop;  tag = "desktop" },
  @{ dir = $programs; tag = "startmenu" }
)
foreach ($d in $testDirs) {
  if (-not (Test-Path -LiteralPath $d.dir)) { continue }
  Get-ChildItem -LiteralPath $d.dir -Filter "WorkBuddy*.lnk" |
    Where-Object { $_.Name -ne "WorkBuddy.lnk" } |
    ForEach-Object {
      $dst = Join-Path $backup ($_.BaseName + "." + $d.tag + ".lnk.archived")
      Move-Item -LiteralPath $_.FullName -Destination $dst -Force
      Write-Output ("ARCHIVED " + $d.tag + " | size=" + (Get-Item -LiteralPath $dst).Length)
    }
}

Write-Output "--- step 3: final state ---"
foreach ($e in $entries) {
  if (Test-Path -LiteralPath $e.path) {
    $c = $ws.CreateShortcut($e.path)
    Write-Output ($e.tag + " -> " + (Split-Path $c.TargetPath -Leaf))
  }
}
Write-Output "DONE"
