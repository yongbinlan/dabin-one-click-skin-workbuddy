# _fix-cmd.ps1 -- normalize launcher/*.cmd: GBK encoding + CRLF line endings.
#
# Two independent requirements, both learned the hard way on this machine:
#
# 1) GBK, NOT UTF-8.
#    Write tools emit UTF-8, but cmd.exe reads .cmd in the ANSI codepage (936
#    here). A UTF-8 .cmd containing Chinese shows garbage the moment it is
#    double-clicked -- no error, just unreadable menus.
#
# 2) CRLF, NOT bare LF.
#    cmd.exe expects CRLF. With bare LF it does not split lines reliably and
#    starts executing fragments of comments and echo text as commands, reporting
#    a pile of "is not recognized as an internal or external command".
#    That looks like a content bug but is purely line endings.
#    Diagnosed with a hexdump: the bytes were correct GBK, only the 0x0A was
#    missing its 0x0D. Do not trust "the Chinese looks fine", check the bytes.
#
# Both steps are idempotent, and every file is re-read and verified after
# writing. The log is the only evidence -- this machine's PowerShell tool does
# NOT return stdout, and exit code 0 proves nothing.
#
# MUST STAY PURE ASCII: Windows PowerShell 5.1 parses .ps1 as ANSI unless the
# file carries a UTF-8 BOM. Any non-ASCII byte here corrupts the paths.
# Chinese filenames are handled by enumerating the directory, never by
# hardcoding them.
#
# USAGE -- via the PowerShell tool, NOT from bash (bash invocation is blocked):
#   & "<project root>\tools\_fix-cmd.ps1"
# Then read the log with node:  logs/fix-cmd.log
#
# PORTABLE: no machine-specific path here -- the project root is derived from
# this script's own location (<root>\tools\*.ps1 -> <root>).

$root = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $root 'logs\fix-cmd.log'
$dir  = Join-Path $root 'launcher'
$L = New-Object System.Collections.ArrayList
function AddL($s) { [void]$L.Add([string]$s) }

AddL ('PSVersion=' + $PSVersionTable.PSVersion.ToString())
AddL ('DirExists=' + (Test-Path -LiteralPath $dir))

$gbk = $null
try { $gbk = [System.Text.Encoding]::GetEncoding(936); AddL ('GBK=' + $gbk.WebName) }
catch { AddL ('GBK_FAIL=' + $_.Exception.Message) }

$strict = $null
try { $strict = New-Object System.Text.UTF8Encoding($false, $true); AddL 'StrictUtf8=OK' }
catch { AddL ('StrictUtf8_FAIL=' + $_.Exception.Message) }

$files = @(Get-ChildItem -LiteralPath $dir -Filter '*.cmd')
AddL ('CmdCount=' + $files.Count)

$i = 0
foreach ($f in $files) {
  $i++
  $p = $f.FullName
  $b = [System.IO.File]::ReadAllBytes($p)
  $tag = '[' + $i + ']'

  # --- source encoding: strict UTF-8 decode succeeding means it IS UTF-8 ---
  $src = 'gbk'
  try { [void]$strict.GetString($b); $src = 'utf8' } catch { $src = 'gbk' }

  if ($src -eq 'utf8') { $t = [System.Text.Encoding]::UTF8.GetString($b) }
  else { $t = $gbk.GetString($b) }

  # --- line endings: collapse then re-expand, so this is idempotent ---
  $lfBefore = 0
  for ($k = 0; $k -lt $b.Length; $k++) {
    if ($b[$k] -eq 10 -and ($k -eq 0 -or $b[$k-1] -ne 13)) { $lfBefore++ }
  }
  $t = $t -replace "`r`n", "`n"
  $t = $t -replace "`n", "`r`n"

  [System.IO.File]::WriteAllText($p, $t, $gbk)

  # --- verify by re-reading, never by assuming the write worked ---
  $nb = [System.IO.File]::ReadAllBytes($p)
  $lfAfter = 0
  for ($k = 0; $k -lt $nb.Length; $k++) {
    if ($nb[$k] -eq 10 -and ($k -eq 0 -or $nb[$k-1] -ne 13)) { $lfAfter++ }
  }
  $nowUtf8 = $true
  try { [void]$strict.GetString($nb) } catch { $nowUtf8 = $false }
  $bom = ($nb.Length -ge 3 -and $nb[0] -eq 239 -and $nb[1] -eq 187 -and $nb[2] -eq 191)

  $verdict = 'OK'
  if ($lfAfter -gt 0) { $verdict = 'FAIL_BARE_LF=' + $lfAfter }
  elseif ($bom) { $verdict = 'FAIL_BOM' }
  elseif ($nowUtf8 -and $nb.Length -gt 0) { $verdict = 'WARN_STILL_UTF8_OR_PURE_ASCII' }

  AddL ($tag + ' ' + $f.Name + ' src=' + $src + ' lf_before=' + $lfBefore + ' lf_after=' + $lfAfter +
        ' bytes=' + $nb.Length + ' verdict=' + $verdict)
}

$L | Out-File -FilePath $log -Encoding ASCII
