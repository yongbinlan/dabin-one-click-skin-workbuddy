@echo off
setlocal
rem ---- 路径全部运行时推导（可移植），说明见 换壁纸.cmd ----
for %%I in ("%~dp0..") do set "SKIN_ROOT=%%~fI"
if exist "%~dp0env.cmd" call "%~dp0env.cmd"
if not defined SKIN_NODE set "SKIN_NODE=node"
set NODE_EXE=%SKIN_NODE%
set WALLPAPER=%SKIN_ROOT%\tools\set-wallpaper.mjs

if not exist "%NODE_EXE%" (
  echo.
  echo  [错误] 找不到 node：
  echo         %NODE_EXE%
  echo         请检查运行时目录是否被移动过。
  goto :done
)

:menu
cls
echo ============================================
echo   WorkBuddy 壁纸透出强度
echo ============================================
echo.
echo    [1] 淡    壁纸最明显，氛围最好
echo    [2] 中    默认，平衡（推荐日常用）
echo    [3] 浓    文字最清楚，看代码时用
echo    [0] 退出
echo.
set "CH="
set /p "CH=  选择 1/2/3/0 并回车: "

rem 空输入必须给出口。少了这一行，输入被重定向或被吞掉时，
rem 就会变成 set/p → goto menu 的无限转圈：屏幕上什么都看不出来，
rem 只在后台疯狂刷菜单（实测一次能刷出 885KB 输出）。
if "%CH%"=="" goto :done
if "%CH%"=="1" (set "P=light"  & goto :apply)
if "%CH%"=="2" (set "P=medium" & goto :apply)
if "%CH%"=="3" (set "P=strong" & goto :apply)
if "%CH%"=="0" goto :done
goto :menu

:apply
echo.
echo 正在调整...
echo.
"%NODE_EXE%" "%WALLPAPER%" intensity %P%
echo.
echo   （按任意键回到菜单，或直接关掉本窗口）
pause
goto :menu

:done
echo.
echo   （看完直接关掉本窗口即可）
pause
endlocal
