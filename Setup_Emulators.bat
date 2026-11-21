@echo off
@chcp 65001 >nul
title Viber Transfer PC - Развертывание эмуляторов Android и iPhone (iOS 18.1)
cd /d "%~dp0"

echo ======================================================================
echo   ПОДГОТОВКА ЭМУЛЯТОРОВ ANDROID (BlueStacks) И IPHONE (iTunes Backup)
echo ======================================================================
echo.

REM 1. Проверяем, запущен ли эмулятор BlueStacks 5, и запускаем его в фоне при наличии
set "BST_EXE=C:\Program Files\BlueStacks_nxt\HD-Player.exe"
if exist "%BST_EXE%" (
    tasklist /FI "IMAGENAME eq HD-Player.exe" /NH | find /I "HD-Player.exe" >nul
    if errorlevel 1 (
        echo [+] Запуск Android-эмулятора BlueStacks 5...
        start "" "%BST_EXE%" --instance Pie64
        echo [~] Ожидание инициализации ADB-моста BlueStacks ^(8 сек^)...
        timeout /t 8 /nobreak >nul
    ) else (
        echo [+] Android-эмулятор BlueStacks 5 уже активен.
    )
)

REM 2. Развертываем виртуальный бэкап iPhone 15 Pro в iTunes MobileSync и базы Android
if exist "C:\Program Files\nodejs\node.exe" (
    "C:\Program Files\nodejs\node.exe" scripts/setup-virtual-devices.js
) else (
    node scripts/setup-virtual-devices.js
)

echo.
pause
