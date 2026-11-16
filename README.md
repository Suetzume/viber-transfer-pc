# Viber Cross-Platform Transfer (Desktop PC Edition)

Автоматизированный инструмент для двустороннего переноса истории чатов, контактов и медиафайлов Viber между устройствами Android и iOS (iPhone).

## Архитектура и принципы работы

Проект решает фундаментальную проблему несовместимости резервных копий Viber (Google Drive vs iCloud) путем извлечения, нормализации в Unified Intermediate Model (UIM) и прямой конвертации баз данных SQLite с пересчетом таймстампов и контрольных сумм резервных копий.

В проекте используются открытые проверенные референсные схемы баз данных и наработки сообщества с GitHub (`ViberDBViewer`, `iPhone-Backup-Analyzer-2`, `watoi`, `WaBridge`, `libimobiledevice`).

Архитектура построена по принципу **Black-Box Isolation** с пошаговым модульным тестированием (TDD) каждого компонента на эталонных фикстурах без обязательного подключения физических телефонов при разработке.

Подробный финальный инженерный план: см. [Генеральный план архитектуры (v1.0.4-FINAL)](file:///C:/Users/mythi/.gemini/antigravity/brain/2fe6312d-3320-486f-bc41-9f368ef4600e/master_plan.md).

## Пользовательский интерфейс (Minimalist UI)

Прототип минималистичного одноэкранного интерфейса расположен в файле:
[src/renderer/index.html](file:///C:/Users/mythi/OneDrive/Desktop/YYY/viber-transfer-pc/src/renderer/index.html) (запускается через `Open_UI.bat` или в любом браузере).

## Структура репозитория

```
├── versions/              # Фиксация каждого изменения отдельным файлом версионирования
│   ├── 1.0.0.md           # Базовый релиз архитектуры и планирования
│   ├── 1.0.1.md           # Интеграция открытых БД и референсных схем с GitHub
│   ├── 1.0.2.md           # Архитектурная критика и аудит рисков (FMEA)
│   ├── 1.0.3.md           # Эталонный план и матрица TDD
│   ├── 1.0.4.md           # Каталог GitHub-решений и минималистичный UI
│   ├── 1.0.5.md           # Слой 1 (Time/Hash) и Слой 2 (UIM Contracts/Validator)
│   ├── 1.0.6.md           # Слой 3: Адаптер Android SQLite (100% Round-Trip Fidelity)
│   ├── 1.0.7.md           # Слой 3: Адаптер iOS CoreData SQLite и KeyRebalancer
│   └── 1.0.8.md           # Слой 4: Manifest.db Builder и ZipHandler [25/25 тестов]
├── fixtures/              # Эталонные схемы баз данных SQLite из открытых источников
│   └── schemas/           # DDL схемы: Android viber_messages, iOS Chat.data, Manifest.db
├── src/
│   ├── engine/            # Ядро конвертации
│   │   ├── foundation/    # TimeEngine (Unix<->Cocoa) и HashService (SHA-1/SHA-256)
│   │   ├── uim/           # UIM Contracts и UIM Validator
│   │   ├── adapters/      # Адаптеры Android и iOS + KeyRebalancer (сдвиг Z_PK)
│   │   ├── manifest/      # ManifestBuilder (таблица Files + генератор bplist00)
│   │   └── backup/        # ZipHandler (упаковка viber_backup.zip для Google Drive)
│   ├── devices/           # Драйверы взаимодействия с Android (ADB) и iOS (usbmuxd)
│   ├── renderer/          # Минималистичный графический интерфейс (index.html)
│   └── shared/            # Общие типы и контракты данных
└── tests/                 # Модульные и интеграционные тесты (node:test)
    ├── foundation.test.js       # Тесты фундамента ядра и валидатора
    ├── android-adapter.test.js  # Тесты импорта, экспорта и round-trip Android
    ├── ios-adapter.test.js      # Тесты импорта, экспорта, KeyRebalancer и round-trip iOS
    └── manifest-builder.test.js # Тесты упаковщика Manifest.db, bplist00 и ZipHandler
```

## Регламент версионирования

Каждое изменение в проекте:
1. Сохраняется как отдельный файл в директории `versions/<номер_версии>.md` с подробным описанием модификаций.
2. Маркируется Git-коммитом: `v<номер_версии>: Описание`.
3. Фиксируется Git-тегом: `v<номер_версии>`.
