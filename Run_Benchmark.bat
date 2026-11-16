@echo off
title Viber Transfer PC - Stress & Scalability Benchmark
echo ============================================================
echo   Запуск нагрузочного стресс-теста на 50 000 сообщений
echo ============================================================
echo.
"C:\Program Files\nodejs\node.exe" scripts\run-benchmark.js
echo.
pause
