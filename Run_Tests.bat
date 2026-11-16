@echo off
@chcp 65001 > nul
title Viber Transfer PC - Unit Test Suite
echo ============================================================
echo   Запуск автоматических тестов (node:test)
echo ============================================================
echo.
"C:\Program Files\nodejs\node.exe" --test tests/**/*.test.js
echo.
echo ============================================================
pause
