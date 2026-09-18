param(
  [string]$Name = "",
  [switch]$StartMenu,
  [string]$Into = ""
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
# WHY THIS EXISTS
#   Explorer decides a file's icon by its *extension association*, never by
#   anything inside the file. For .hta that means HKCR\htafile\DefaultIcon,
#   which ships as mshta.exe -- so the picker always looked like a plain
#   browser window no matter what <HTA:APPLICATION ICON="..."> said (that
#   attribute only affects the window/taskbar at run time, and on Win10 mshta
#   does not even honour it -- see SKILL.md 7.10.1).
#
#   There is no per-file icon mechanism on Windows. The two honest options are
#   (a) rewrite HKCU\Software\Classes\htafile\DefaultIcon -- which changes
#   EVERY .hta on the machine, so this skill must not do it behind the user's
#   back, or (b) hand the user a shell entry that carries its own icon.
#   This script does (b): a shortcut whose IconLocation points at picker.ico.
#   Zero footprint outside the user's own Desktop/Start Menu.
#
# PORTABLE: nothing below is tied to one machine.
#   * $root comes from this script's own location (<root>\tools\*.ps1 -> <root>)
#   * the shortcut name is derived from the produced .hta's filename, so this
#     ASCII-only script never needs to hard-code a non-ASCII name
#   * user folders come from the environment, not a hard-coded user name
$ws = New-Object -ComObject WScript.Shell

$root     = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "launcher"

if (-not (Test-Path -LiteralPath $launcher)) {
  Write-Output ("ERROR launcher dir not found: " + $launcher)
  exit 1
}

# Derive everything from the built artifact -- no non-ASCII literals here.
$hta = Get-ChildItem -LiteralPath $launcher -Filter "*.hta" -ErrorAction SilentlyContinue |
       Select-Object -First 1
if (-not $hta) {
  Write-Output ("ERROR no .hta produced in " + $launcher)
  exit 1
}

$ico   = Join-Path $launcher "picker.ico"
$mshta = Join-Path $env:SystemRoot "System32\mshta.exe"

if (-not (Test-Path -LiteralPath $ico)) {
  Write-Output ("WARN icon missing, shortcut will fall back to the default: " + $ico)
}

$linkName = $hta.BaseName + ".lnk"
if ($Name) { $linkName = $Name + ".lnk" }

$targets = @()
if ($Into) {
  # -Into exists so this script can be exercised against a scratch directory
  # instead of the user's real Desktop (tests must not touch personal folders).
  if (-not (Test-Path -LiteralPath $Into)) { New-Item -ItemType Directory -Path $Into | Out-Null }
  $targets += (Join-Path $Into $linkName)
} else {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) { $targets += (Join-Path $desktop $linkName) }
  if ($StartMenu) {
    $programs = [Environment]::GetFolderPath('Programs')
    if ($programs) { $targets += (Join-Path $programs $linkName) }
  }
}

if ($targets.Count -eq 0) {
  Write-Output "ERROR no user folder resolved (Desktop/Programs)"
  exit 1
}

foreach ($t in $targets) {
  $dir = Split-Path -Parent $t
  if (-not (Test-Path -LiteralPath $dir)) { Write-Output ("skip (no dir): " + $t); continue }

  $sc = $ws.CreateShortcut($t)
  $sc.TargetPath       = $mshta
  $sc.Arguments        = '"' + $hta.FullName + '"'
  $sc.WorkingDirectory = $launcher
  if (Test-Path -LiteralPath $ico) { $sc.IconLocation = ($ico + ",0") }
  $sc.Description      = "WorkBuddy wallpaper picker"
  $sc.Save()

  # Read back through the shell, not from what we just assigned -- a Save()
  # that silently drops IconLocation is exactly the failure mode this script
  # exists to prevent.
  $chk    = $ws.CreateShortcut($t)
  $icnOk  = ($chk.IconLocation -like "*picker.ico*")
  $tgtOk  = ($chk.TargetPath -like "*mshta.exe")
  $argOk  = ($chk.Arguments -like "*.hta*")
  Write-Output ("created: " + $t)
  Write-Output ("  icon=" + $chk.IconLocation + " iconOk=" + $icnOk)
  Write-Output ("  targetOk=" + $tgtOk + " argOk=" + $argOk)
}
Write-Output "DONE"
