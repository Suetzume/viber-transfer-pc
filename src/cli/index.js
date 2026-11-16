#!/usr/bin/env node

/**
 * Viber Transfer CLI: Консольный интерфейс ядра миграции Viber.
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  detectLocalViberDesktop,
  migrateAndroidToIOS,
  migrateIOSToAndroid
} = require('../engine/pipeline/migration-engine');

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
============================================================
  Viber Transfer PC Bridge (CLI Engine v1.1.0)
============================================================

Использование:
  node src/cli/index.js [команды] [параметры]

Команды:
  --detect-desktop          Сканировать систему на наличие баз Viber Desktop
  --direction <направление>  Направление миграции:
                            'android-to-ios' (по умолчанию) или 'ios-to-android'
  --source <путь>           Путь к исходной базе (Android viber_messages.db / iOS Chat.data)
  --target <путь>           Путь к целевой базе или каталогу бэкапа
  --zip <путь>              Путь для сохранения viber_backup.zip (для iOS -> Android)
  --help                    Показать справку

Примеры:
  node src/cli/index.js --detect-desktop
  node src/cli/index.js --direction android-to-ios --source ./viber_messages.db --target ./Chat.data
`);
}

function run() {
  if (args.includes('--help') || args.length === 0) {
    printHelp();
    return;
  }

  if (args.includes('--detect-desktop')) {
    console.log('[*] Поиск установленных баз Viber Desktop в %AppData%\\ViberPC...');
    const detected = detectLocalViberDesktop();
    if (detected.length === 0) {
      console.log('[-] Локальные базы Viber Desktop не найдены.');
    } else {
      console.log(`[+] Найдено аккаунтов Viber Desktop: ${detected.length}`);
      detected.forEach((acc, i) => {
        console.log(`  ${i + 1}. Номер: ${acc.phone} | Файл: ${acc.dbPath} (${Math.round(acc.sizeBytes / 1024)} KB)`);
      });
    }
    return;
  }

  let direction = 'android-to-ios';
  let sourcePath = null;
  let targetPath = null;
  let zipPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--direction' && args[i + 1]) direction = args[++i];
    if (args[i] === '--source' && args[i + 1]) sourcePath = args[++i];
    if (args[i] === '--target' && args[i + 1]) targetPath = args[++i];
    if (args[i] === '--zip' && args[i + 1]) zipPath = args[++i];
  }

  if (!sourcePath || !targetPath) {
    console.error('[!] Ошибка: необходимо указать --source <путь> и --target <путь>');
    process.exit(1);
  }

  console.log(`[*] Запуск миграции [${direction}]...`);
  console.log(`    Источник: ${sourcePath}`);
  console.log(`    Приемник: ${targetPath}`);

  const onProgress = (evt) => {
    console.log(`    [${evt.percent}%] ${evt.message}`);
  };

  try {
    let report;
    if (direction === 'android-to-ios') {
      const iosDdlPath = path.join(__dirname, '../../fixtures/schemas/ios_viber_chat.sql');
      report = migrateAndroidToIOS({
        androidDb: sourcePath,
        targetIosDb: targetPath,
        iosDdlPath,
        onProgress
      });
    } else if (direction === 'ios-to-android') {
      const androidDdlPath = path.join(__dirname, '../../fixtures/schemas/android_viber_messages.sql');
      report = migrateIOSToAndroid({
        iosDb: sourcePath,
        targetAndroidDb: targetPath,
        androidDdlPath,
        outputZipPath: zipPath,
        onProgress
      });
    } else {
      console.error(`[!] Неизвестное направление: ${direction}`);
      process.exit(1);
    }

    console.log('\n[+] МИГРАЦИЯ УСПЕШНО ЗАВЕРШЕНА:');
    console.log(`    Диалогов перенесено: ${report.chatsCount}`);
    console.log(`    Сообщений перенесено: ${report.messagesCount}`);
    console.log(`    Дубликатов устранено: ${report.deduplicatedCount}`);
    console.log(`    Время выполнения: ${report.durationMs} мс`);
    if (report.zipPath) {
      console.log(`    Архив создан: ${report.zipPath}`);
    }
  } catch (err) {
    console.error(`[!] Сбой миграции: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
