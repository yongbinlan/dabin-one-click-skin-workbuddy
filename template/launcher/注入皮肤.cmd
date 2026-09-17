@echo off
setlocal
rem ---- 路径全部运行时推导（可移植），说明见 换壁纸.cmd ----
for %%I in ("%~dp0..") do set "SKIN_ROOT=%%~fI"
if exist "%~dp0env.cmd" call "%~dp0env.cmd"
if not defined SKIN_NODE set "SKIN_NODE=node"
set NODE_EXE=%SKIN_NODE%
set LAUNCHER=%SKIN_ROOT%\tools\launcher.mjs

echo ============================================
echo  注入「夜街」皮肤到 WorkBuddy
echo ============================================
echo.
echo  WorkBuddy 未运行时会自动拉起（用户级环境变量已保证 CDP=9342）
echo.

"%NODE_EXE%" "%LAUNCHER%" %*
set RC=%ERRORLEVEL%
echo.
echo 退出码：%RC%
echo   0=成功  2=主题包缺失^(仍会启动应用^)  5=CDP未就绪  6=界面未就绪  7=注入失败  8=自检未通过
echo.
pause
endlocal
