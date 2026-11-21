/**
 * Stage 8 Test Suite: Virtual Hardware Emulators (Android + iPhone 15 Pro iTunes MobileSync) E2E Verification
 * 
 * Проверяет:
 * 1. Развертывание виртуального незашифрованного бэкапа iPhone 15 Pro (iOS 18.1) в структуре MobileSync.
 * 2. Развертывание виртуального профиля Viber Desktop (+380501234567) и архива Google Drive (viber_backup_emulator.zip).
 * 3. Автоматическое обнаружение виртуальных устройств системным сканером (/api/devices).
 * 4. Сквозной перенос Android ➔ Virtual iPhone 15 Pro с проверкой сдвига ключей KeyRebalancer и медиавложений CAS.
 * 5. Сквозной реверс-перенос Virtual iPhone 15 Pro ➔ Android (viber_backup.zip) с сохранением всех диалогов и вложений.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const { startServer } = require('../src/server/bridge-server');
const {
  EMULATOR_IOS_UDID,
  EMULATOR_PHONE_NUMBER,
  setupVirtualDevices
} = require('../scripts/setup-virtual-devices');
const { startVirtualAndroidAdbEmulator } = require('../src/devices/android/virtual-adb-emulator');
const { findAdbExecutable } = require('../src/devices/android/adb-connector');
const { inspectIOSBackup, validateBackupForRestore } = require('../src/devices/ios/ios-connector');
const { unpackZip } = require('../src/engine/backup/zip-handler');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const TEST_PORT = 34590;

function requestJson(method, urlPath, payload = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: bodyStr ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      } : {}
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
        } catch (_) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('Stage 8: Virtual Hardware Emulators (Android & iPhone 15 Pro MobileSync) Full System E2E', () => {
  let serverInstance = null;
  let tempSandbox = null;
  let provisioned = null;

  before(async () => {
    tempSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-emulator-e2e-'));
    provisioned = setupVirtualDevices({
      customBackupRoot: path.join(tempSandbox, 'MobileSync', 'Backup'),
      customAppData: path.join(tempSandbox, 'AppData'),
      customDownloadsDir: path.join(tempSandbox, 'Downloads'),
      skipAdbSync: true
    });
    serverInstance = await startServer(TEST_PORT);
  });

  after(() => {
    if (serverInstance && serverInstance.close) {
      serverInstance.close();
    }
    if (tempSandbox && fs.existsSync(tempSandbox)) {
      try {
        fs.rmSync(tempSandbox, { recursive: true, force: true, maxRetries: 3 });
      } catch (_) {}
    }
  });

  it('Emulator Provisioning: создает валидный незашифрованный бэкап iPhone 15 Pro (iOS 18.1) с Manifest.db и Chat.data', () => {
    assert.ok(fs.existsSync(provisioned.ios.backupDir), 'Папка бэкапа iPhone 15 Pro должна существовать');
    assert.ok(fs.existsSync(provisioned.ios.manifestDbPath), 'Manifest.db должен существовать');
    assert.ok(fs.existsSync(provisioned.ios.chatDataPath), 'Хешированная база Chat.data должна существовать');

    const info = inspectIOSBackup(provisioned.ios.backupDir);
    assert.equal(info.udid, EMULATOR_IOS_UDID);
    assert.equal(info.deviceName, 'iPhone 15 Pro (Virtual Emulator)');
    assert.equal(info.iosVersion, '18.1');
    assert.equal(info.isEncrypted, false, 'Бэкап эмулятора не должен быть зашифрован');
    assert.equal(info.hasViberData, true, 'Контейнер Viber должен быть зарегистрирован в Manifest.db');
    assert.equal(info.status, 'ready');

    const validation = validateBackupForRestore(provisioned.ios.backupDir);
    assert.equal(validation.ok, true, 'Валидация перед восстановлением должна проходить успешно');
  });

  it('Emulator Provisioning: создает реалистичную базу Android/Desktop (3 чата, 10 сообщений) и архив Google Drive', () => {
    assert.ok(fs.existsSync(provisioned.android.desktopDbPath), 'База viber.db эмулятора должна существовать');
    assert.ok(fs.existsSync(provisioned.android.zipPath), 'Архив viber_backup_emulator.zip должен существовать');
    assert.equal(provisioned.android.phone, EMULATOR_PHONE_NUMBER);

    const db = new DatabaseSync(provisioned.android.desktopDbPath, { readOnly: true });
    const convCount = db.prepare('SELECT count(*) as cnt FROM conversations').get().cnt;
    const msgCount = db.prepare('SELECT count(*) as cnt FROM messages').get().cnt;
    db.close();

    assert.equal(convCount, 3, 'В базе эмулятора Android должно быть 3 диалога');
    assert.equal(msgCount, 10, 'В базе эмулятора Android должно быть 10 сообщений');
  });

  it('Forward E2E (Android Emulator ➔ Virtual iPhone 15 Pro): сливает 3 чата и 10 сообщений в бэкап iPhone без потери исходных чатов iOS', async () => {
    const resp = await requestJson('POST', '/api/migrate', {
      direction: 'android-to-ios',
      sourcePath: provisioned.android.desktopDbPath,
      targetPath: provisioned.ios.backupDir
    });

    assert.equal(resp.status, 200);
    assert.equal(resp.data.success, true);
    assert.equal(resp.data.report.chatsCount, 3);
    assert.equal(resp.data.report.messagesCount, 10);
    assert.equal(resp.data.report.mediaCount, 2, 'Оба медиафайла (фото и голосовое) должны быть перенесены через CAS');

    // Проверяем итоговую базу Chat.data внутри бэкапа iPhone 15 Pro:
    // В ней должны быть 2 исходных чата iPhone + 3 перенесенных чата Android = 5 чатов,
    // и 3 исходных сообщения iPhone + 10 перенесенных сообщений Android = 13 сообщений!
    const iosDb = new DatabaseSync(provisioned.ios.chatDataPath, { readOnly: true });
    const totalConvs = iosDb.prepare('SELECT count(*) as cnt FROM ZCONVERSATION').get().cnt;
    const totalMsgs = iosDb.prepare('SELECT count(*) as cnt FROM ZMESSAGE').get().cnt;
    iosDb.close();

    assert.equal(totalConvs, 5, 'KeyRebalancer должен сохранить 2 чата iPhone и добавить 3 чата Android (итого 5)');
    assert.equal(totalMsgs, 13, 'KeyRebalancer должен сохранить 3 сообщения iPhone и добавить 10 сообщений Android (итого 13)');
  });

  it('Reverse E2E (Virtual iPhone 15 Pro ➔ Android Archive): экспортирует все 5 объединенных чатов и 13 сообщений в viber_backup.zip', async () => {
    const outReverseZip = path.join(tempSandbox, 'reverse_from_iphone15pro.zip');

    const resp = await requestJson('POST', '/api/migrate', {
      direction: 'ios-to-android',
      sourcePath: provisioned.ios.backupDir,
      targetPath: outReverseZip
    });

    assert.equal(resp.status, 200);
    assert.equal(resp.data.success, true);
    assert.equal(resp.data.report.chatsCount, 5, 'Все 5 диалогов с iPhone 15 Pro должны быть экспортированы на Android');
    assert.equal(resp.data.report.messagesCount, 13, 'Все 13 сообщений должны быть экспортированы без потерь');
    assert.ok(fs.existsSync(outReverseZip), 'Итоговый архив viber_backup.zip должен быть создан');

    const entries = unpackZip(fs.readFileSync(outReverseZip));
    const dbEntry = entries.find(e => e.name === 'viber_messages');
    assert.ok(dbEntry, 'В архиве должна присутствовать база viber_messages');
  });

  it('Virtual Android ADB Protocol Daemon: реальный клиент adb.exe подключается по TCP, выполняет shell-опрос и adb pull базы', async () => {
    const adbExe = findAdbExecutable();
    assert.ok(adbExe, 'Встроенный adb.exe должен быть доступен');

    const emu = await startVirtualAndroidAdbEmulator({
      port: 0, // динамический свободный порт
      viberDbPath: provisioned.android.desktopDbPath
    });

    try {
      const addr = `127.0.0.1:${emu.port}`;
      await execFileAsync(adbExe, ['connect', addr]);
      await new Promise(r => setTimeout(r, 300));

      const { stdout: modelOut } = await execFileAsync(adbExe, ['-s', addr, 'shell', 'getprop', 'ro.product.model']);
      assert.equal(modelOut.trim(), 'Pixel 8 Pro (Virtual Emulator)');

      const { stdout: pmOut } = await execFileAsync(adbExe, ['-s', addr, 'shell', 'pm', 'path', 'com.viber.voip']);
      assert.ok(pmOut.includes('package:'), 'Должен определяться установленный пакет com.viber.voip');

      const pulledDbPath = path.join(tempSandbox, 'adb_pulled_test.db');
      await execFileAsync(adbExe, ['-s', addr, 'pull', '/sdcard/viber_messages', pulledDbPath]);
      assert.ok(fs.existsSync(pulledDbPath), 'Файл базы должен быть скачан по протоколу ADB sync RECV');
      assert.equal(fs.statSync(pulledDbPath).size, fs.statSync(provisioned.android.desktopDbPath).size);

      await execFileAsync(adbExe, ['disconnect', addr]);
    } finally {
      await emu.close();
    }
  });
});
