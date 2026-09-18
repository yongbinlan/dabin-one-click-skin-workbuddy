param(
  [string]$Exe  = "",
  [string]$Name = "WorkBuddy (skinned)"
)
$ErrorActionPreference = "Stop"
# NOTE: param() MUST be the first statement in the file. Anything executable
# above it -- even $ErrorActionPreference = "Stop" -- makes PowerShell stop
# seeing a param block at all and parse the parentheses as a command call,
# which fails with "InvalidLeftHandSide" pointing at the first default value.
# So the settings line lives *below* the param block, not above it.
#
# NOTE: intentionally pure ASCII -- PowerShell 5.1 parses a BOM-less .ps1 as
# ANSI/GBK on some machines, so any non-ASCII literal here would corrupt paths.
#
# PORTABLE: creates the skin-launcher shortcut (Desktop + Start Menu).
#   * $root comes from this script's own location (<root>\tools\*.ps1 -> <root>)
#   * user folders come from the environment, not from a hard-coded user name
#   * the app exe is auto-detected (for the icon), overridable with -Exe
#   * the shortcut name is overridable with -Name
$ws = New-Object -ComObject WScript.Shell

$root = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $root "launcher\workbuddy-skin-launcher.vbs"

if (-not (Test-Path -LiteralPath $vbs)) {
  Write-Output ("ERROR vbs not found: " + $vbs)
  exit 1
}

if (-not $Exe) {
  $cand = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\workbuddy\WorkBuddy.exe'),
    (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'WorkBuddy\WorkBuddy.exe')
  )
  foreach ($c in $cand) { if ($c -and (Test-Path -LiteralPath $c)) { $Exe = $c; break } }
}

$desktop  = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$lnk      = $Name + ".lnk"

$targets = @()
if ($desktop)  { $targets += (Join-Path $desktop  $lnk) }
if ($programs) { $targets += (Join-Path $programs $lnk) }

foreach ($t in $targets) {
  $dir = Split-Path -Parent $t
  if (-not (Test-Path -LiteralPath $dir)) { Write-Output ("skip (no dir): " + $t); continue }
  $sc = $ws.CreateShortcut($t)
  $sc.TargetPath       = Join-Path $env:SystemRoot "System32\wscript.exe"
  $sc.Arguments        = '"' + $vbs + '"'
  $sc.WorkingDirectory = $root
  if ($Exe) { $sc.IconLocation = ($Exe + ",0") }
  $sc.Description = "Launch WorkBuddy with the skin auto-injected"
  $sc.Save()
  Write-Output ("created: " + $t)
}
Write-Output "DONE"
