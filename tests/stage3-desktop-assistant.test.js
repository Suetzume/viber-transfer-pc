/**
 * Stage 3 Verification Test Suite:
 * Помощник извлечения чатов через официальную синхронизацию Viber Desktop
 * (Tier 1 No-Root канал для Android 11–16).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const { startServer, stopServer } = require('../src/server/bridge-server');
const { getViberDesktopLauncherStatus } = require('../src/devices/desktop/viber-desktop-launcher');

const TEST_PORT = 34572;
let testTmpDir = null;

function postJson(urlPath, payload = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      `http://localhost:${TEST_PORT}${urlPath}`,
      {
        method: 'POST',
        agent: false,
        headers: {
          'Connection': 'close',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${TEST_PORT}${urlPath}`, { agent: false, headers: { 'Connection': 'close' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: body });
        }
      });
    }).on('error', reject);
  });
}

describe('Stage 3: Android No-Root Viber Desktop Assistant & WAL Snapshotting', () => {
  before(async () => {
    testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage3-test-'));
    await startServer(TEST_PORT);
  });

  after(async () => {
    await stopServer();
    if (testTmpDir && fs.existsSync(testTmpDir)) {
      try {
        fs.rmSync(testTmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  test('UI Contract: index.html содержит карточку ассистента Desktop, кнопки запуска и версию v2.4+ / v2.5+', () => {
    const htmlPath = path.join(__dirname, '../src/renderer/index.html');
    const content = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(content.includes('v2.'), 'UI должен содержать актуальную версию v2.x');
    assert.ok(content.includes('desktopSyncAssistantBox'), 'Должна присутствовать карточка ассистента синхронизации');
    assert.ok(content.includes('launchViberBtn'), 'Кнопка быстрого запуска Viber Desktop');
    assert.ok(content.includes('launchViberDesktopApp'), 'Функция запуска Viber Desktop');
    assert.ok(content.includes('startDesktopAutoPolling'), 'Фоновый авто-мониторинг появления базы');
  });

  test('viber-desktop-launcher: корректно определяет статус лаунчера или инсталлятора', () => {
    const status = getViberDesktopLauncherStatus();
    assert.ok(typeof status.available === 'boolean');
    assert.ok(['installed', 'installer', 'download_needed'].includes(status.type));
    assert.ok(typeof status.label === 'string');

    // Если на ПК есть ViberSetup.exe в Downloads, должен распознавать тип 'installer'
    const downloadsSetup = path.join(process.env.USERPROFILE || '', 'Downloads', 'ViberSetup.exe');
    if (fs.existsSync(downloadsSetup) && status.type !== 'installed') {
      assert.strictEqual(status.type, 'installer');
      assert.strictEqual(status.path, downloadsSetup);
    }
  });

  test('/api/launch-desktop: отвечает корректным JSON со статусом запуска', async () => {
    const res = await postJson('/api/launch-desktop', {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.status, 'Должен вернуть объект status');
    assert.ok(res.data.status.type);
  });

  test('/api/detect-desktop: корректно возвращает список локальных баз', async () => {
    const res = await getJson('/api/detect-desktop');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.accounts));
  });

  test('/api/migrate: безопасное чтение и миграция базы Viber Desktop с активным WAL-файлом', async () => {
    // 1. Создаем тестовую БД
    const testDbPath = path.join(testTmpDir, 'viber.db');
    const ddl = fs.readFileSync(path.join(__dirname, '../fixtures/schemas/android_viber_messages.sql'), 'utf8');
    const db = new DatabaseSync(testDbPath);
    db.exec(ddl);
    db.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'WAL Тест Чат', 1716000000000, 'Сообщение WAL', 0);
      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1);
      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+380509990000', 'WAL Контакт', 'WALUser');
      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime)
      VALUES (1, 1, 1, 'Сообщение зафиксировано в WAL режиме', 1716000001000, 0, 2, 0, 0);
    `);
    db.close();

    // 2. Создаем симуляцию открытого WAL файла рядом с базой
    const walPath = testDbPath + '-wal';
    const shmPath = testDbPath + '-shm';
    fs.writeFileSync(walPath, Buffer.from('WAL_SIMULATION_HEADER'));
    fs.writeFileSync(shmPath, Buffer.from('SHM_SIMULATION_HEADER'));

    assert.ok(fs.existsSync(walPath), 'WAL файл должен существовать');

    // 3. Вызываем миграцию
    const res = await postJson('/api/migrate', {
      direction: 'android-to-ios',
      demo: false,
      sourcePath: testDbPath
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.report.chatsCount, 1);
    assert.strictEqual(res.data.report.messagesCount, 1);
  });
});
