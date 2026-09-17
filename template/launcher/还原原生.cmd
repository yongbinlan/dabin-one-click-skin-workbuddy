@echo off
setlocal
rem ---- 路径全部运行时推导（可移植），说明见 换壁纸.cmd ----
for %%I in ("%~dp0..") do set "SKIN_ROOT=%%~fI"
if exist "%~dp0env.cmd" call "%~dp0env.cmd"
if not defined SKIN_NODE set "SKIN_NODE=node"
set NODE_EXE=%SKIN_NODE%
set LAUNCHER=%SKIN_ROOT%\tools\launcher.mjs

echo ============================================
echo  还原 WorkBuddy 原生界面
echo ============================================
echo.
echo  仅移除 CodeDrobe 注入的样式与标记，不动任何应用文件。
echo.

"%NODE_EXE%" "%LAUNCHER%" --restore
set RC=%ERRORLEVEL%
echo.
echo 退出码：%RC%  ^(0=已还原^)
echo.
pause
endlocal
