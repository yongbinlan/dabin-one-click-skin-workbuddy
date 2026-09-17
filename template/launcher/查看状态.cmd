@echo off
setlocal
rem ---- 路径全部运行时推导（可移植），说明见 换壁纸.cmd ----
for %%I in ("%~dp0..") do set "SKIN_ROOT=%%~fI"
if exist "%~dp0env.cmd" call "%~dp0env.cmd"
if not defined SKIN_NODE set "SKIN_NODE=node"
set NODE_EXE=%SKIN_NODE%
set LAUNCHER=%SKIN_ROOT%\tools\launcher.mjs

echo ============================================
echo  WorkBuddy 皮肤状态（只读）
echo ============================================
echo.

"%NODE_EXE%" "%LAUNCHER%" --status
echo.
echo ---- 最近 20 行启动日志 ----
if exist "%SKIN_ROOT%\logs\launcher.log" (
  powershell -NoProfile -Command "Get-Content '%SKIN_ROOT%\logs\launcher.log' -Tail 20"
) else (
  echo ^(暂无日志^)
)
echo.
pause
endlocal
