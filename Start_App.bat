@echo off
chcp 65001 >nul
title Viber Transfer PC - Desktop Application
echo ============================================================
echo   Viber Transfer PC - Desktop Application
echo ============================================================
echo.

:: Auto-kill any orphaned background process on port 34567
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :34567 2^>nul') do (
    if not "%%a"=="" (
        echo [+] Освобождение порта 34567 (завершение старого процесса PID: %%a)...
        taskkill /f /pid %%a >nul 2>&1
    )
)

echo [+] Запуск Viber Transfer PC Bridge Server на http://localhost:34567
echo [+] Приложение откроется в браузере автоматически...
echo.

"C:\Program Files\nodejs\node.exe" src\server\bridge-server.js
if errorlevel 1 (
    echo.
    echo [!] Ошибка запуска сервера. Попробуйте запустить от имени Администратора.
)
pause
