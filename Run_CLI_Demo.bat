@echo off
@chcp 65001 > nul
title Viber Transfer CLI
echo ============================================================
echo   Viber Transfer PC Bridge - CLI Runner (v2.3.0)
echo ============================================================
echo.
"C:\Program Files\nodejs\node.exe" src\cli\index.js --help
echo.
echo ------------------------------------------------------------
echo Проверка локальных баз данных Viber Desktop:
"C:\Program Files\nodejs\node.exe" src\cli\index.js --detect-desktop
echo ------------------------------------------------------------
echo.
pause
