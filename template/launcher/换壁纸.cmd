@echo off
setlocal
rem ---- 路径全部运行时推导，所以本文件可以整体搬到任何目录、任何机器 ----
rem   SKIN_ROOT = 本文件所在目录（launcher\）的上一级
rem   SKIN_NODE = env.cmd 里 init 探测到的 node；取不到就退回 PATH 里的 node
for %%I in ("%~dp0..") do set "SKIN_ROOT=%%~fI"
if exist "%~dp0env.cmd" call "%~dp0env.cmd"
if not defined SKIN_NODE set "SKIN_NODE=node"
set NODE_EXE=%SKIN_NODE%
set WALLPAPER=%SKIN_ROOT%\tools\set-wallpaper.mjs
title WorkBuddy 换壁纸

if not exist "%NODE_EXE%" (
  echo.
  echo  [错误] 找不到 node：
  echo         %NODE_EXE%
  echo         请检查运行时目录是否被移动过。
  goto :DONE
)

rem 有参数 = 把拖进来的图片收进壁纸库并立刻启用
if not "%~1"=="" goto :ADD

rem 无参数 = 列出壁纸库，并允许直接输入编号切换
echo ============================================
echo   WorkBuddy 壁纸库
echo ============================================
echo.
echo   想点着换？双击本目录的「壁纸选择器.hta」，有缩略图，更直观。
echo.
"%NODE_EXE%" "%WALLPAPER%"
echo.
echo --------------------------------------------
echo   换成上面某一张：输入编号后回车
echo   想加入新图：把图片文件拖到本文件图标上
echo   直接回车 = 什么都不做
echo --------------------------------------------
echo.
set "PICK="
set /p "PICK=   编号: "
echo.
if "%PICK%"=="" goto :DONE
echo 正在切换...
echo.
"%NODE_EXE%" "%WALLPAPER%" use %PICK%
goto :DONE

:ADD
echo ============================================
echo   收图进壁纸库并立即启用
echo ============================================
echo    图片：%~nx1
echo.
"%NODE_EXE%" "%WALLPAPER%" add "%~1"

:DONE
rem 所有出口都必须汇到这里 —— 少一个 pause 出口 = 窗口一闪而过，
rem 用户看到的就是「点了没反应」。这个 bug 真实发生过一次（直接回车那条路）。
echo.
echo   （看完直接关掉本窗口即可）
pause
endlocal
