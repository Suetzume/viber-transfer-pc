@echo off
@chcp 65001 > nul
title Viber Transfer PC - Desktop Application
echo ============================================================
echo   Запуск Viber Transfer PC Bridge Server на порту 34567
echo   Приложение откроется в вашем браузере автоматически...
echo ============================================================
echo.
"C:\Program Files\nodejs\node.exe" src\server\bridge-server.js
pause
