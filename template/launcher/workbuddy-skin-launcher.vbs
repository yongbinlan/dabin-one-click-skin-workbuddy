' ============================================================
'  WorkBuddy Skin Launcher (no-window shell)
'
'  Invoked by: wscript.exe workbuddy-skin-launcher.vbs
'  (called from the desktop / start-menu shortcut)
'
'  RESPONSIBILITY SPLIT (deliberate):
'    - THIS FILE starts WorkBuddy. It uses a plain sh.Run on the
'      app exe - the most basic call Windows offers - so starting
'      the app never depends on node, on launcher.mjs, or on CDP.
'    - node / launcher.mjs only INJECTS the skin afterwards.
'
'  DESIGN RULE: the skin layer must never be able to block the
'  app from opening. If node or launcher.mjs is missing or broken,
'  WorkBuddy still opens normally; the reason goes into the log.
'
'  The node process exits by itself when done - no daemon, no
'  polling, nothing left running.
'
'  NOTE: this file is intentionally pure ASCII. wscript.exe parses
'  .vbs using the system ANSI code page (GBK on this machine), so
'  UTF-8 non-ASCII text here would be mis-decoded and break the
'  script (or raise a blocking message box).
' ============================================================
Option Explicit

Dim fso, sh, rc, HERE, ROOT, ENV_CMD
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' ---------- portable path resolution ----------
'   ROOT = the parent of this file's folder (this file lives in <ROOT>\launcher\).
'   Everything inside the project is derived from that, so the whole tree can be
'   moved to any directory on any machine. Only two things cannot be derived and
'   therefore come from env.cmd, which the one-click initializer writes after
'   probing this machine: the node binary and the app executable.
'   If env.cmd is absent, node falls back to whatever "node" resolves to on PATH.
HERE = fso.GetParentFolderName(WScript.ScriptFullName)
ROOT = fso.GetParentFolderName(HERE)
ENV_CMD = fso.BuildPath(HERE, "env.cmd")

Dim NODE_EXE, LAUNCHER, APP_EXE, LOG_FILE
NODE_EXE = ReadEnvCmd(ENV_CMD, "SKIN_NODE")
APP_EXE  = ReadEnvCmd(ENV_CMD, "SKIN_APP")
If NODE_EXE = "" Then NODE_EXE = "node"
LAUNCHER = fso.BuildPath(ROOT, "tools\launcher.mjs")
LOG_FILE = fso.BuildPath(ROOT, "logs\launcher.log")

' ---------- step 1: make sure WorkBuddy is up (never depends on node) ----------
If (APP_EXE = "") Or (Not fso.FileExists(APP_EXE)) Then
  LogLine "FATAL: app exe not found: [" & APP_EXE & "]"
  MsgBox "WorkBuddy could not be started." & vbCrLf & vbCrLf & _
         "App not found at:" & vbCrLf & APP_EXE & vbCrLf & vbCrLf & _
         "Fix it by running the one-click initializer:" & vbCrLf & _
         "    node scripts\init.mjs" & vbCrLf & vbCrLf & _
         "(it probes this machine and writes launcher\env.cmd)", 16, "WorkBuddy Skin Launcher"
  Set sh = Nothing
  Set fso = Nothing
  WScript.Quit 1
End If

If AppRunning() Then
  LogLine "WorkBuddy already running - skipping start"
Else
  LogLine "starting WorkBuddy: " & APP_EXE
  sh.Run """" & APP_EXE & """", 1, False
End If

' ---------- step 2: inject the skin (best effort, app is already safe) ----------
If Not NodeUsable() Then
  LogLine "SKIN SKIPPED: node.exe not found (" & NODE_EXE & ") - app started without skin"
ElseIf Not fso.FileExists(LAUNCHER) Then
  LogLine "SKIN SKIPPED: launcher.mjs not found (" & LAUNCHER & ") - app started without skin"
Else
  ' windowStyle 0 = hidden, bWaitOnReturn True = wait so we can read the
  ' exit code. wscript has no window of its own, so this wait is invisible.
  ' --no-launch: step 1 already handled starting the app; launcher.mjs only
  ' waits for CDP and injects.
  rc = sh.Run("""" & NODE_EXE & """ """ & LAUNCHER & """ --no-launch", 0, True)
  LogLine "launcher.mjs(--no-launch) exit code = " & rc
End If

Set sh = Nothing
Set fso = Nothing
WScript.Quit 0

' ------------------------------------------------------------------

' Reads a value out of env.cmd, whose lines look like:
'   set "SKIN_NODE=C:\path\to\node.exe"
' Returns "" when the file is missing or the key is absent.
Function ReadEnvCmd(p, key)
  Dim f, line, eq, val
  ReadEnvCmd = ""
  On Error Resume Next
  Set f = fso.OpenTextFile(p, 1)
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  Do While Not f.AtEndOfStream
    line = f.ReadLine
    If InStr(LCase(line), LCase(key)) > 0 Then
      eq = InStr(line, "=")
      If eq > 0 Then
        val = Mid(line, eq + 1)
        val = Replace(val, """", "")
        ReadEnvCmd = Trim(val)
        Exit Do
      End If
    End If
  Loop
  f.Close
  On Error GoTo 0
End Function

' A bare command name (no backslash) is left for sh.Run to resolve via PATH;
' only an absolute path can be checked with FileExists.
Function NodeUsable()
  If InStr(NODE_EXE, "\") = 0 Then
    NodeUsable = True
  Else
    NodeUsable = fso.FileExists(NODE_EXE)
  End If
End Function

Sub LogLine(msg)
  Dim f
  On Error Resume Next
  Set f = fso.OpenTextFile(LOG_FILE, 8, True)
  f.WriteLine "[" & Now & "] [vbs] " & msg
  f.Close
  On Error GoTo 0
End Sub

' Returns True if WorkBuddy.exe is running.
' Defaults to TRUE (conservative): an unavailable WMI must not be read as
' "not running", because that would start a second instance.
Function AppRunning()
  Dim wmi, col, n
  AppRunning = True
  n = -1
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='WorkBuddy.exe'")
  If Err.Number = 0 Then n = col.Count
  Err.Clear
  On Error GoTo 0
  If n >= 0 Then
    If n > 0 Then
      AppRunning = True
    Else
      AppRunning = False
    End If
  Else
    LogLine "WARN: WMI unavailable, assuming WorkBuddy is running"
  End If
End Function
