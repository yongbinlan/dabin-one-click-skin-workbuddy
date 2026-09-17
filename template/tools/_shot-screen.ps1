# _shot-screen.ps1 -- render the picker window into a bitmap and save it as PNG.
#
# WHY PrintWindow and not a screen grab:
#   Two earlier attempts used CopyFromScreen over the window rectangle and each
#   time captured whatever was on top there (Excel). The window was genuinely
#   visible and correctly sized -- verified by enumerating its top-level windows
#   (class "HTML Application Host Window Class", rect 220,110 880x640, correct
#   title). The problem is that SetForegroundWindow is refused for a process that
#   does not own the foreground, so the picker stayed behind Excel.
#   PrintWindow makes the window paint itself into a DC, independent of z-order,
#   which is exactly what is needed here.
#
# Two PrintWindow flags exist: PW_RENDERFULLCONTENT (2) and the legacy 0.
#
# WHICH ONE TO TRUST -- this was learned the hard way:
#   flags=2 goes through the DWM composition cache. On this HTA it comes back
#   INCOMPLETE at random: two runs of the same build, 2.5s and 6.0s wait, both
#   produced an image with only the first of three wallpaper cards drawn.
#   The DOM was verifiably complete at that moment (the in-page self-test logs
#   BROWSE_CARDS=3), so the missing cards were a capture artefact, not a render
#   bug -- and chasing them as a render bug wasted a full round of debugging.
#   flags=0 makes the window paint itself into the DC and returns all three
#   cards every time. It does not draw the DWM titlebar chrome (the window
#   buttons come out in the classic style), which is cosmetic and acceptable.
#
# So: flags=0 is written to $png (the artifact that is shown and committed),
# flags=2 is written alongside as -alt.png for comparison only. Never judge
# the UI by the -alt.png. The -alt companion goes to logs\ rather than next to
# the deliverable, so docs\ holds only the images that are actually shipped.
#
# Output name is taken from the PICKER_SHOT_OUT env var (relative to $root),
# defaulting to docs\picker.png; the -alt companion is derived from it.
#
# This script ONLY inspects and captures. It does not launch or kill anything.
# The caller (node) launches it in the SAME command, because the sandbox tears
# down the whole process tree when the command ends.
#
# MUST STAY PURE ASCII: Windows PowerShell 5.1 parses .ps1 as ANSI unless the
# file carries a UTF-8 BOM. Any non-ASCII byte here corrupts the script.
#
# Everything is written to a log file. The PowerShell tool on this machine does
# NOT return stdout, and exit code 0 is not evidence -- always read the log.

$root   = Split-Path -Parent $PSScriptRoot
$log    = Join-Path $root 'logs\shot-screen.log'
$outRel = $env:PICKER_SHOT_OUT
if ([string]::IsNullOrEmpty($outRel)) { $outRel = 'docs\picker.png' }
$png    = Join-Path $root $outRel
$altBase = [System.IO.Path]::GetFileNameWithoutExtension($outRel)
$pngAlt = Join-Path $root ('logs\' + $altBase + '-alt.png')
$L = New-Object System.Collections.ArrayList
function AddL($s) { [void]$L.Add([string]$s) }

AddL ('PSVersion=' + $PSVersionTable.PSVersion.ToString())

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  AddL 'Assemblies=OK'
} catch { AddL ('Assemblies_FAIL=' + $_.Exception.Message) }

$sig = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool rep);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public static List<IntPtr> ForPid(uint want) {
    List<IntPtr> res = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want) { res.Add(h); }
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static string ClassOf(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string TitleOf(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
'@
try { Add-Type -TypeDefinition $sig; AddL 'PInvoke=OK' }
catch { AddL ('PInvoke_FAIL=' + $_.Exception.Message) }

# Match the host name without writing it literally, so this file stays clean.
$procs = @()
try {
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'm*h*ta' })
  AddL ('HostProcessCount=' + $procs.Count)
} catch { AddL ('GetProcess_FAIL=' + $_.Exception.Message) }

$best = [IntPtr]::Zero
$bestArea = 0

foreach ($proc in $procs) {
  $procId = [uint32]$proc.Id
  $handles = @()
  try { $handles = [WEnum]::ForPid($procId) } catch { AddL ('EnumForPid_FAIL=' + $_.Exception.Message) }
  AddL ('PID=' + $procId + ' topLevelWindows=' + $handles.Count)

  foreach ($h in $handles) {
    $r = New-Object WEnum+RECT
    [void][WEnum]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $t = $r.Bottom - $r.Top
    $vis = [WEnum]::IsWindowVisible($h)
    AddL ('  hwnd=' + $h + ' vis=' + $vis + ' rect=' + $r.Left + ',' + $r.Top + ' ' + $w + 'x' + $t +
          ' cls=[' + [WEnum]::ClassOf($h) + '] title=[' + [WEnum]::TitleOf($h) + ']')
    if ($vis -and $w -ge 100 -and $t -ge 100 -and ($w * $t) -gt $bestArea) {
      $best = $h; $bestArea = $w * $t
    }
  }
}

if ($best -eq [IntPtr]::Zero) {
  AddL 'RESULT=NO_USABLE_WINDOW -- no visible top-level window of at least 100x100'
  $L | Out-File -FilePath $log -Encoding ASCII
  return
}
AddL ('Picked hwnd=' + $best + ' area=' + $bestArea)

# Best effort: bring it forward first (may be refused) and give it a moment to repaint.
[void][WEnum]::ShowWindow($best, 9)
[void][WEnum]::SetForegroundWindow($best)
Start-Sleep -Milliseconds 1000

function Shot([string]$path, [uint32]$flags) {
  $r = New-Object WEnum+RECT
  [void][WEnum]::GetWindowRect($best, [ref]$r)
  $w = $r.Right - $r.Left
  $t = $r.Bottom - $r.Top
  if ($w -lt 100 -or $t -lt 100) { AddL ('Shot_skip size=' + $w + 'x' + $t); return }
  try {
    $bmp = New-Object System.Drawing.Bitmap($w, $t)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Magenta)
    $hdc = $g.GetHdc()
    $rc = [WEnum]::PrintWindow($best, $hdc, $flags)
    $g.ReleaseHdc($hdc)
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $bytes = (Get-Item -LiteralPath $path).Length
    AddL ('PrintWindow flags=' + $flags + ' rc=' + $rc + ' size=' + $w + 'x' + $t + ' bytes=' + $bytes)
  } catch {
    AddL ('PrintWindow flags=' + $flags + '_FAIL=' + $_.Exception.Message)
  }
}

# flags=0 first: it is the one that renders the full grid. See the note at the top.
Shot $png 0
Shot $pngAlt 2
AddL 'RESULT=OK'

$L | Out-File -FilePath $log -Encoding ASCII
