@echo off
title Viber Transfer PC - Unit Test Suite
echo ============================================================
echo   Running Automated Unit Tests (node:test)
echo ============================================================
echo.
"C:\Program Files\nodejs\node.exe" --test tests/**/*.test.js
echo.
echo ============================================================
pause
