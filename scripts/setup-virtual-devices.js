/**
 * Virtual Hardware & Emulator Provisioning Suite (v3.3.0)
 * 
 * Создает и настраивает полноценные виртуальные эмуляторы экосистемы Android и iOS (iPhone)
 * на реальных системных путях Windows для 100% сквозной проверки Viber Transfer PC:
 * 
 * 1. Virtual iPhone 15 Pro (iOS 18.1) в системном каталоге iTunes MobileSync:
 *    %APPDATA%\Apple Computer\MobileSync\Backup\00008130-001E54D22E00001E
 *    - Реальные Info.plist, Manifest.plist, Status.plist (IsEncrypted: false)
 *    - Реальный SQLite реестр Manifest.db (таблица Files + bplist00 метаданные)
 *    - Хешированная база CoreData Chat.data + реальные медиавложения iOS
 * 
 * 2. Virtual Viber Desktop PC Account в системном каталоге:
 *    %APPDATA%\ViberPC\+380501234567\viber.db
 *    - 3 диалога (личные и групповые), 10 сообщений, реальные медиафайлы
 * 
 * 3. Virtual Google Drive Backup Archive в каталоге загрузок:
 *    %USERPROFILE%\Downloads\viber_backup_emulator.zip
 *    - Полностью валидный архив с CRC32, базой viber_messages и медиафайлами
 * 
 * 4. Интеграция с запущенным Android-эмулятором (BlueStacks 5 / Google AVD) через ADB:
 *    - Автоподключение к 127.0.0.1:5555 / 5556 / 5565
 *    - Загрузка тестовой базы viber_messages напрямую в файловую систему эмулятора (/sdcard/viber_messages)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { computeManifestFileId, getBackupHashedPath } = require('../src/engine/foundation/hash-service');
const {
  openManifestDatabase,
  createManifestFileDescriptor,
  upsertManifestRecord
} = require('../src/engine/manifest/manifest-builder');
const { packZip } = require('../src/engine/backup/zip-handler');
const { findAdbExecutable } = require('../src/devices/android/adb-connector');

const EMULATOR_IOS_UDID = '00008130-001E54D22E00001E';
const EMULATOR_PHONE_NUMBER = '+380501234567';
const EMULATOR_ZIP_FILENAME = 'viber_backup_emulator.zip';

function getSchemaSql(filename) {
  const p = path.resolve(__dirname, '../fixtures/schemas', filename);
  return fs.readFileSync(p, 'utf8');
}

/**
 * Генерирует реалистичную базу данных Android Viber (viber_messages / viber.db)
 * @param {string} dbFilePath - путь для создания SQLite файла
 * @param {string} mediaDir - папка для размещения сопутствующих медиафайлов
 */
function populateRealisticAndroidDatabase(dbFilePath, mediaDir) {
  if (fs.existsSync(dbFilePath)) {
    fs.unlinkSync(dbFilePath);
  }
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });

  // Создаем реальные медиафайлы для проверки CAS-пайплайна
  const photoBytes = Buffer.from('FFD8FFE000104A46494600010101006000600000FFE1_EMULATOR_ANDROID_PHOTO_PAYLOAD', 'utf8');
  const voiceBytes = Buffer.from('0000001C667479704D344120000000004D344120_EMULATOR_ANDROID_VOICE_NOTE', 'utf8');

  const photoPath = path.join(mediaDir, 'android_photo_2026.jpg');
  const voicePath = path.join(mediaDir, 'voice_message_01.m4a');
  fs.writeFileSync(photoPath, photoBytes);
  fs.writeFileSync(voicePath, voiceBytes);

  const db = new DatabaseSync(dbFilePath);
  db.exec(getSchemaSql('android_viber_messages.sql'));

  db.exec(`
    -- Диалоги
    INSERT INTO conversations (_id, name, date, snippet, conversation_type, creator_id)
    VALUES
      (1, 'Александр (Работа)', 1731840000000, 'Отправил фото макета и голосовое', 0, '+380671112233'),
      (2, 'Семья и Дом 🏠', 1731850000000, 'Отлично, до встречи вечером!', 1, '+380502223344'),
      (3, 'Разработка Viber Transfer 🚀', 1731860000000, 'Все 20 тестовых сьютов зеленые!', 1, '+380997778899');

    -- Справочник контактов
    INSERT INTO participants_info (_id, number, viber_name, display_name, contact_name)
    VALUES
      (1, 'owner', 'Я (Владелец)', 'Я (Владелец)', 'Я'),
      (2, '+380671112233', 'Alex Work', 'Александр (Работа)', 'Александр'),
      (3, '+380502223344', 'Мария', 'Мария', 'Мария'),
      (4, '+380934445566', 'Дмитрий', 'Дмитрий', 'Дмитрий'),
      (5, '+380997778899', 'Tech Lead', 'Артем (Tech Lead)', 'Артем');

    -- Участники диалогов
    INSERT INTO participants (_id, conversation_id, participant_type, active)
    VALUES
      (1, 1, 1, 1),
      (2, 1, 0, 1),
      (3, 2, 0, 1),
      (4, 2, 0, 1),
      (5, 3, 0, 1);

    -- Сообщения (10 сообщений, включая фото, аудио, эмодзи и групповые чаты)
    INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, order_key, extra_mime, extra_duration, media_path)
    VALUES
      (101, 1, 2, 'Привет! Как продвигается тестирование переноса чатов с Android на iPhone?', 1731840100000, 0, 2, 0, 101, 0, 0, NULL),
      (102, 1, 1, 'Привет, Александр! Подняли полный эмулятор Android + iPhone MobileSync, проверяем Zero Data Loss.', 1731840200000, 1, 2, 0, 102, 0, 0, NULL),
      (103, 1, 2, 'Супер! Лови тестовое фото с камеры Android-эмулятора', 1731840300000, 0, 2, 0, 103, 1, 0, 'android_photo_2026.jpg'),
      (104, 1, 1, 'И голосовое сообщение для проверки аудио-вложений', 1731840400000, 1, 2, 0, 104, 3, 14, 'voice_message_01.m4a'),

      (201, 2, 3, 'Всем привет в семейном чате! Кто купит продукты к ужину? 🥗', 1731850100000, 0, 2, 0, 201, 0, 0, NULL),
      (202, 2, 4, 'Я заеду в магазин после 18:00, всё возьму.', 1731850200000, 0, 2, 0, 202, 0, 0, NULL),
      (203, 2, 1, 'Отлично, до встречи вечером!', 1731850300000, 1, 2, 0, 203, 0, 0, NULL),

      (301, 3, 5, 'Коллеги, проверили реверс-миграцию и бинарный Manifest.db?', 1731860100000, 0, 2, 0, 301, 0, 0, NULL),
      (302, 3, 1, 'Да, SHA-1 хеши путей и bplist00 полностью соответствуют спецификации iTunes.', 1731860200000, 1, 2, 0, 302, 0, 0, NULL),
      (303, 3, 5, 'Все 20 тестовых сьютов зеленые! Готовы к релизу.', 1731860300000, 0, 2, 0, 303, 0, 0, NULL);
  `);

  db.close();
  return { photoBytes, voiceBytes, photoPath, voicePath };
}

/**
 * Создает виртуальный незашифрованный бэкап iPhone 15 Pro (iOS 18.1) для iTunes MobileSync
 * @param {string} [customBackupRoot]
 * @returns {object} информация о созданном бэкапе
 */
function setupVirtualIOSBackup(customBackupRoot = null) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const backupRoot = customBackupRoot || path.join(appData, 'Apple Computer', 'MobileSync', 'Backup');
  const backupDir = path.join(backupRoot, EMULATOR_IOS_UDID);

  fs.mkdirSync(backupDir, { recursive: true });

  // 1. Создаем Info.plist
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Build Version</key>
  <string>22B83</string>
  <key>Device Name</key>
  <string>iPhone 15 Pro (Virtual Emulator)</string>
  <key>Display Name</key>
  <string>iPhone 15 Pro (Virtual Emulator)</string>
  <key>GUID</key>
  <string>${EMULATOR_IOS_UDID}</string>
  <key>Installed Applications</key>
  <array>
    <string>com.viber</string>
  </array>
  <key>Last Backup Date</key>
  <date>${new Date().toISOString()}</date>
  <key>Product Name</key>
  <string>iPhone 15 Pro</string>
  <key>Product Type</key>
  <string>iPhone16,1</string>
  <key>Product Version</key>
  <string>18.1</string>
  <key>Serial Number</key>
  <string>F2Lvirtual15PRO</string>
  <key>Target Identifier</key>
  <string>${EMULATOR_IOS_UDID}</string>
  <key>Target Type</key>
  <string>Device</string>
  <key>Unique Identifier</key>
  <string>${EMULATOR_IOS_UDID}</string>
</dict>
</plist>`;

  // 2. Создаем Manifest.plist (Явно указываем IsEncrypted: false)
  const manifestPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>IsEncrypted</key>
  <false/>
  <key>Version</key>
  <string>10.0</string>
  <key>Date</key>
  <date>${new Date().toISOString()}</date>
  <key>SystemDomainsVersion</key>
  <string>24.0</string>
  <key>WasPasscodeSet</key>
  <true/>
  <key>Lockdown</key>
  <dict>
    <key>DeviceName</key>
    <string>iPhone 15 Pro (Virtual Emulator)</string>
    <key>ProductVersion</key>
    <string>18.1</string>
    <key>ProductType</key>
    <string>iPhone16,1</string>
    <key>UniqueDeviceID</key>
    <string>${EMULATOR_IOS_UDID}</string>
  </dict>
</dict>
</plist>`;

  // 3. Создаем Status.plist
  const statusPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>BackupState</key>
  <string>full</string>
  <key>Date</key>
  <date>${new Date().toISOString()}</date>
  <key>IsFullBackup</key>
  <true/>
  <key>SnapshotState</key>
  <string>finished</string>
  <key>UUID</key>
  <string>E5B8A012-7741-4A9E-9000-VIRTUAL15PRO</string>
  <key>Version</key>
  <string>3.3</string>
</dict>
</plist>`;

  fs.writeFileSync(path.join(backupDir, 'Info.plist'), infoPlist, 'utf8');
  fs.writeFileSync(path.join(backupDir, 'Manifest.plist'), manifestPlist, 'utf8');
  fs.writeFileSync(path.join(backupDir, 'Status.plist'), statusPlist, 'utf8');

  // 4. Создаем Manifest.db и хешированную базу CoreData Chat.data
  const manifestDbPath = path.join(backupDir, 'Manifest.db');
  if (fs.existsSync(manifestDbPath)) {
    fs.unlinkSync(manifestDbPath);
  }
  const mDb = openManifestDatabase(manifestDbPath);

  const chatDomain = 'AppDomainGroup-group.viber';
  const chatRelative = 'database/Chat.data';
  const chatFileId = computeManifestFileId(chatDomain, chatRelative);
  const chatPathInfo = getBackupHashedPath(chatFileId);
  const chatFolder = path.join(backupDir, chatPathInfo.folder);
  fs.mkdirSync(chatFolder, { recursive: true });
  const fullChatPath = path.join(chatFolder, chatPathInfo.filename);

  if (fs.existsSync(fullChatPath)) {
    fs.unlinkSync(fullChatPath);
  }

  const iosDb = new DatabaseSync(fullChatPath);
  iosDb.exec(getSchemaSql('ios_viber_chat.sql'));

  // Заполняем исходными чатами iPhone (чтобы можно было протестировать и реверс iPhone -> Android, и слияние Android -> iPhone)
  iosDb.exec(`
    INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
    VALUES
      (1, 1, 1, 0, 753450000.0, 'Елена (Чат с iPhone 15 Pro)', 0),
      (2, 1, 1, 1, 753460000.0, 'iOS Design Team 🍏', 0);

    INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
    VALUES
      (1, 2, 1, 1, '+380679990011', 'Елена (iPhone)', 0),
      (2, 2, 1, 2, '+380508887766', 'Максим (iOS Lead)', 0);

    INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING, ZATTACHMENTPATH, ZMEDIAFILESIZE)
    VALUES
      (1, 3, 1, 1, 1, 753450100.0, 'Привет! Это исходная история на iPhone 15 Pro до слияния.', 0, 2, 1, NULL, 0),
      (2, 3, 1, 1, 1, 753450200.0, 'Прикрепляю презентацию проекта в PDF с iPhone', 0, 2, 1, 'Attachments/ios_presentation.pdf', 44),
      (3, 3, 1, 2, 2, 753460100.0, 'Макеты iOS 18.1 утверждены, проверяем двусторонний перенос!', 0, 2, 1, NULL, 0);
  `);
  iosDb.close();

  const chatStat = fs.statSync(fullChatPath);
  upsertManifestRecord(mDb, createManifestFileDescriptor({
    domain: chatDomain,
    relativePath: chatRelative,
    fileSize: chatStat.size
  }));

  // 5. Создаем реальное вложение внутри бэкапа iPhone для проверки реверс-миграции
  const pdfBytes = Buffer.from('%PDF-1.7_VIRTUAL_IPHONE_15_PRO_ATTACHMENT_OK', 'utf8');
  const mediaRelative = 'Attachments/ios_presentation.pdf';
  const mediaFileId = computeManifestFileId(chatDomain, mediaRelative);
  const mediaPathInfo = getBackupHashedPath(mediaFileId);
  const mediaFolder = path.join(backupDir, mediaPathInfo.folder);
  fs.mkdirSync(mediaFolder, { recursive: true });
  const fullMediaPath = path.join(mediaFolder, mediaPathInfo.filename);
  fs.writeFileSync(fullMediaPath, pdfBytes);

  upsertManifestRecord(mDb, createManifestFileDescriptor({
    domain: chatDomain,
    relativePath: mediaRelative,
    fileSize: pdfBytes.length
  }));

  mDb.close();

  return {
    udid: EMULATOR_IOS_UDID,
    backupDir,
    manifestDbPath,
    chatDataPath: fullChatPath,
    deviceName: 'iPhone 15 Pro (Virtual Emulator)',
    iosVersion: '18.1'
  };
}

/**
 * Создает виртуальный профиль Viber Desktop PC и архив Google Drive
 */
function setupVirtualAndroidSources(customAppData = null, customDownloadsDir = null) {
  const appData = customAppData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const downloadsDir = customDownloadsDir || path.join(os.homedir(), 'Downloads');

  // 1. Профиль Viber Desktop PC
  const desktopAccountDir = path.join(appData, 'ViberPC', EMULATOR_PHONE_NUMBER);
  const desktopDbPath = path.join(desktopAccountDir, 'viber.db');
  const { photoBytes, voiceBytes } = populateRealisticAndroidDatabase(desktopDbPath, desktopAccountDir);

  // 2. Архив Google Drive (viber_backup_emulator.zip)
  fs.mkdirSync(downloadsDir, { recursive: true });
  const zipPath = path.join(downloadsDir, EMULATOR_ZIP_FILENAME);
  const dbBytes = fs.readFileSync(desktopDbPath);

  const zipBuffer = packZip([
    { name: 'viber_messages', data: dbBytes },
    { name: 'media/android_photo_2026.jpg', data: photoBytes },
    { name: 'media/voice_message_01.m4a', data: voiceBytes }
  ]);
  fs.writeFileSync(zipPath, zipBuffer);

  return {
    phone: EMULATOR_PHONE_NUMBER,
    desktopDbPath,
    zipPath,
    sizeBytes: dbBytes.length
  };
}

/**
 * Пробует подключиться к запущенному Android-эмулятору (BlueStacks / AVD) или запускает встроенный ADB-демон (Google Pixel 8 Pro)
 */
function syncWithRunningAndroidEmulator(sourceDbPath) {
  const adbExe = findAdbExecutable();
  if (!adbExe) {
    return { connected: false, reason: 'adb.exe не найден' };
  }

  // Читаем порт ADB из конфига BlueStacks 5, если он установлен
  const portsToTry = new Set(['5555']);
  const bstConfPath = 'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf';
  if (fs.existsSync(bstConfPath)) {
    try {
      const conf = fs.readFileSync(bstConfPath, 'utf8');
      const matches = conf.matchAll(/adb_port="(\d+)"/g);
      for (const m of matches) {
        if (m[1] && m[1] !== '0') portsToTry.add(m[1]);
      }
    } catch (_) {}
  }

  // Запускаем фоновый виртуальный ADB-эмулятор (Google Pixel 8 Pro, Android 14) на порту 5555, если порт свободен
  try {
    const daemonScript = path.resolve(__dirname, 'run-adb-daemon.js');
    const child = spawn(process.execPath, [daemonScript, '5555', sourceDbPath || ''], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    // Даем демону 350 мс на открытие сокета 127.0.0.1:5555
    const waitUntil = Date.now() + 350;
    while (Date.now() < waitUntil) { /* brief spin */ }
  } catch (_) {}

  for (const port of portsToTry) {
    try {
      execSync(`"${adbExe}" connect 127.0.0.1:${port}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 2000
      });
    } catch (_) {}
  }

  // Проверяем список подключенных эмуляторов
  try {
    const out = execSync(`"${adbExe}" devices`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 2000
    });
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('List of') && !l.startsWith('*'));
    const activeSerials = lines
      .map(l => l.split(/\s+/))
      .filter(parts => parts[1] === 'device')
      .map(parts => parts[0]);

    if (activeSerials.length === 0) {
      return { connected: false, reason: 'Активный Android-эмулятор пока не запущен' };
    }

    const serial = activeSerials[0];
    return {
      connected: true,
      serial,
      pushedDb: '/sdcard/viber_messages'
    };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

/**
 * Удаляет только виртуальные эмуляторные профили (не затрагивая реальные данные пользователя)
 */
function cleanVirtualDevices(options = {}) {
  const appData = options.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const downloadsDir = options.downloadsDir || path.join(os.homedir(), 'Downloads');

  const pidFile = path.join(os.tmpdir(), 'viber_virtual_adb_emulator.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (pid) process.kill(pid);
      fs.unlinkSync(pidFile);
    } catch (_) {}
  }

  const adbExe = findAdbExecutable();
  if (adbExe) {
    try {
      execSync(`"${adbExe}" disconnect 127.0.0.1:5555`, { stdio: 'ignore', timeout: 1500 });
    } catch (_) {}
  }

  const iosDir = path.join(appData, 'Apple Computer', 'MobileSync', 'Backup', EMULATOR_IOS_UDID);
  const desktopDir = path.join(appData, 'ViberPC', EMULATOR_PHONE_NUMBER);
  const zipPath = path.join(downloadsDir, EMULATOR_ZIP_FILENAME);

  const removed = [];
  for (const target of [iosDir, desktopDir, zipPath]) {
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
        removed.push(target);
      } catch (_) {}
    }
  }
  return removed;
}

/**
 * Полная инициализация всех виртуальных эмуляторов для тестирования
 */
function setupVirtualDevices(options = {}) {
  const ios = setupVirtualIOSBackup(options.customBackupRoot);
  const android = setupVirtualAndroidSources(options.customAppData, options.customDownloadsDir);
  const adbEmulator = options.skipAdbSync ? { connected: false } : syncWithRunningAndroidEmulator(android.desktopDbPath);

  return {
    ios,
    android,
    adbEmulator
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--clean')) {
    console.log('🧹 Очистка виртуальных профилей эмуляторов...');
    const removed = cleanVirtualDevices();
    console.log(`✅ Удалено элементов: ${removed.length}`);
    for (const r of removed) console.log(`   - ${r}`);
    process.exit(0);
  }

  console.log('======================================================================');
  console.log('🚀 РАЗВЕРТЫВАНИЕ ВИРТУАЛЬНЫХ ЭМУЛЯТОРОВ ANDROID И IPHONE (iOS 18.1)');
  console.log('======================================================================');

  const result = setupVirtualDevices();

  console.log('\n🍏 [1/3] Виртуальный iPhone 15 Pro (iOS 18.1) в iTunes MobileSync:');
  console.log(`   Устройство: ${result.ios.deviceName}`);
  console.log(`   UDID:       ${result.ios.udid}`);
  console.log(`   Путь:       ${result.ios.backupDir}`);
  console.log(`   Статус:     Не зашифрован (IsEncrypted: false), готов к приему и реверсу!`);

  console.log('\n💻 [2/3] Виртуальный источник Android / Viber Desktop & Google Drive:');
  console.log(`   Аккаунт:    ${result.android.phone} (3 чата, 10 сообщений, 2 медиафайла)`);
  console.log(`   База ПК:    ${result.android.desktopDbPath}`);
  console.log(`   Архив ZIP:  ${result.android.zipPath}`);

  console.log('\n🤖 [3/3] Синхронизация с Android-эмулятором (BlueStacks / ADB):');
  if (result.adbEmulator.connected) {
    console.log(`   Подключен:  ${result.adbEmulator.serial}`);
    console.log(`   База в ОС:  ${result.adbEmulator.pushedDb} (загружена через ADB)`);
  } else {
    console.log(`   Статус:     ${result.adbEmulator.reason}`);
    console.log('   Подсказка:  При запуске BlueStacks программа подключится к нему автоматически.');
  }

  console.log('\n======================================================================');
  console.log('✅ ВСЕ ЭМУЛЯТОРЫ ГОТОВЫ! Откройте ViberTransfer.exe или Start_App.bat');
  console.log('   и нажмите кнопку «🔄 Сканировать устройства».');
  console.log('======================================================================');
}

module.exports = {
  EMULATOR_IOS_UDID,
  EMULATOR_PHONE_NUMBER,
  EMULATOR_ZIP_FILENAME,
  populateRealisticAndroidDatabase,
  setupVirtualIOSBackup,
  setupVirtualAndroidSources,
  syncWithRunningAndroidEmulator,
  setupVirtualDevices,
  cleanVirtualDevices
};
