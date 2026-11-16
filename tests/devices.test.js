/**
 * Unit Tests: Подсистема обнаружения устройств и резервных копий (Android ADB & iOS MobileSync)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const {
  parseAdbDevicesOutput,
  findAdbExecutable,
  scanAndroidDevices,
  detectAndroidDataSources
} = require('../src/devices/android/adb-connector');

const {
  getMobileSyncBackupRoots,
  parsePlistMetadata,
  inspectIOSBackup,
  scanIOSBackups,
  validateBackupForRestore,
  detectAppleServices
} = require('../src/devices/ios/ios-connector');

const { scanAllDevicesAndBackups } = require('../src/devices/index');

describe('Layer 6: Android ADB Device Connector', () => {
  test('parseAdbDevicesOutput: корректно обрабатывает пустой ввод и заголовок', () => {
    assert.deepEqual(parseAdbDevicesOutput(''), []);
    assert.deepEqual(parseAdbDevicesOutput(null), []);
    assert.deepEqual(parseAdbDevicesOutput('List of devices attached\n\n'), []);
  });

  test('parseAdbDevicesOutput: фильтрует системные сообщения демона ADB', () => {
    const raw = `
* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
`;
    assert.deepEqual(parseAdbDevicesOutput(raw), []);
  });

  test('parseAdbDevicesOutput: парсит несколько устройств разных типов и состояний', () => {
    const sampleOutput = `
List of devices attached
RF8M30XYZAB            device product:panther model:Pixel_7 device:panther transport_id:1
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2
192.168.1.55:5555      offline transport_id:3
UNAUTH99999            unauthorized transport_id:4
`;

    const devices = parseAdbDevicesOutput(sampleOutput);
    assert.equal(devices.length, 4);

    // Устройство 1: Pixel 7 (авторизовано)
    assert.equal(devices[0].serial, 'RF8M30XYZAB');
    assert.equal(devices[0].state, 'device');
    assert.equal(devices[0].isAuthorized, true);
    assert.equal(devices[0].model, 'Pixel 7');
    assert.equal(devices[0].product, 'panther');
    assert.equal(devices[0].transportId, '1');

    // Устройство 2: Эмулятор
    assert.equal(devices[1].serial, 'emulator-5554');
    assert.equal(devices[1].isAuthorized, true);

    // Устройство 3: Offline
    assert.equal(devices[2].serial, '192.168.1.55:5555');
    assert.equal(devices[2].state, 'offline');
    assert.equal(devices[2].isAuthorized, false);

    // Устройство 4: Unauthorized (требуется подтверждение на экране смартфона)
    assert.equal(devices[3].serial, 'UNAUTH99999');
    assert.equal(devices[3].state, 'unauthorized');
    assert.equal(devices[3].isAuthorized, false);
  });

  test('detectAndroidDataSources: возвращает структурированный отчет обо всех уровнях', () => {
    const report = detectAndroidDataSources();
    assert.ok(report.recommendedStrategy);
    assert.ok(report.tier1_desktop);
    assert.ok(report.tier2_archives);
    assert.ok(report.tier3_adb);
    assert.ok(Array.isArray(report.tier1_desktop.accounts));
  });
});

describe('Layer 6: iOS MobileSync & Backup Connector', () => {
  test('parsePlistMetadata: корректно извлекает поля из XML plist', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Device Name</key>
  <string>iPhone 15 Pro Max</string>
  <key>Product Type</key>
  <string>iPhone16,2</string>
  <key>Product Version</key>
  <string>17.5.1</string>
  <key>IsEncrypted</key>
  <false/>
</dict>
</plist>`;

    const meta = parsePlistMetadata(xml);
    assert.equal(meta.deviceName, 'iPhone 15 Pro Max');
    assert.equal(meta.productType, 'iPhone16,2');
    assert.equal(meta.productVersion, '17.5.1');
    assert.equal(meta.isEncrypted, false);
  });

  test('parsePlistMetadata: определяет зашифрованный бэкап в XML', () => {
    const xml = `<plist><dict><key>IsEncrypted</key><true/></dict></plist>`;
    const meta = parsePlistMetadata(xml);
    assert.equal(meta.isEncrypted, true);
  });

  test('inspectIOSBackup & validateBackupForRestore: корректная валидация синтетического бэкапа', () => {
    // Создаем временную структуру бэкапа
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-test-backup-'));
    const manifestPath = path.join(tempDir, 'Manifest.db');

    // Инициализируем тестовый Manifest.db
    const db = new DatabaseSync(manifestPath);
    db.exec(`
      CREATE TABLE Files (
        fileID TEXT PRIMARY KEY,
        domain TEXT,
        relativePath TEXT,
        flags INTEGER,
        file BLOB
      );

      INSERT INTO Files (fileID, domain, relativePath, flags)
      VALUES 
        ('11223344556677889900aabbccddeeff11223344', 'AppDomainGroup-group.viber', 'Documents/Contacts.data', 1),
        ('223344556677889900aabbccddeeff1122334455', 'AppDomainGroup-group.viber', 'Documents/Chat.data', 1),
        ('3344556677889900aabbccddeeff112233445566', 'CameraRollDomain', 'DCIM/100APPLE/IMG_0001.JPG', 1);
    `);
    db.close();

    // Создаем тестовый Info.plist
    const infoPlistContent = `<?xml version="1.0" encoding="UTF-8"?>
    <plist><dict>
      <key>Device Name</key><string>Test iPhone</string>
      <key>Product Type</key><string>iPhone14,5</string>
      <key>Product Version</key><string>17.2</string>
      <key>IsEncrypted</key><false/>
    </dict></plist>`;
    fs.writeFileSync(path.join(tempDir, 'Info.plist'), infoPlistContent, 'utf8');

    // Инспектируем бэкап
    const inspection = inspectIOSBackup(tempDir);
    assert.equal(inspection.manifestExists, true);
    assert.equal(inspection.isEncrypted, false);
    assert.equal(inspection.deviceName, 'Test iPhone');
    assert.equal(inspection.productType, 'iPhone14,5');
    assert.equal(inspection.totalFiles, 3);
    assert.equal(inspection.hasViberData, true);
    assert.equal(inspection.viberFiles.length, 2);
    assert.equal(inspection.status, 'ready');

    // Валидируем перед восстановлением
    const validation = validateBackupForRestore(tempDir);
    assert.equal(validation.ok, true);
    assert.equal(validation.errors.length, 0);
    // Проверяем обязательное предупреждение о Find My iPhone (FMEA)
    assert.ok(validation.warnings.some(w => w.includes('Find My iPhone') || w.includes('Локатор')));

    // Очистка
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('validateBackupForRestore: возвращает ошибку при зашифрованном бэкапе', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-enc-backup-'));
    fs.writeFileSync(path.join(tempDir, 'Info.plist'), '<plist><dict><key>IsEncrypted</key><true/></dict></plist>');
    
    // Manifest.db пустой или отсутствует
    const validation = validateBackupForRestore(tempDir);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some(e => e.includes('зашифрована') || e.includes('Manifest.db')));

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('detectAppleServices: безопасно проверяет наличие iTunes и драйверов на хосте', () => {
    const res = detectAppleServices();
    assert.ok('appleMobileDeviceInstalled' in res);
    assert.ok('itunesInstalled' in res);
    assert.equal(typeof res.appleMobileDeviceInstalled, 'boolean');
    assert.equal(typeof res.itunesInstalled, 'boolean');
  });
});

describe('Layer 6: Unified System Scanner', () => {
  test('scanAllDevicesAndBackups: возвращает целостный статус всей экосистемы', () => {
    const status = scanAllDevicesAndBackups();
    assert.ok(status.timestamp > 0);
    assert.ok(status.android);
    assert.ok(Array.isArray(status.android.devices));
    assert.ok(status.ios);
    assert.ok(Array.isArray(status.ios.backups));
    assert.ok(status.ios.appleServices);
  });
});
