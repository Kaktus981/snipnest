@echo off
chcp 65001 >nul
title 文栈 SnipNest 测试网站
cd /d "%~dp0"
echo.
echo ========================================
echo   文栈 SnipNest 测试网站正在启动
echo ========================================
echo.
echo 请不要关闭这个窗口。
echo 当你看到 Local 地址后，请在 Edge 打开：
echo.
echo   http://127.0.0.1:4173/test-site/
echo.
call npm run test-site
echo.
echo 测试网站已经停止。按任意键关闭窗口。
pause >nul
