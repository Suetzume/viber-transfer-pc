/**
 * Stage 2 Verification Test Suite:
 * Интерактивный 3-шаговый мастер (Wizard), честная работа с файловой системой,
 * нативный диалог выбора файлов и полное исключение скрытого демо-режима.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const { startServer, stopServer } = require('../src/server/bridge-server');
const { packViberBackupZip } = require('../src/engine/backup/zip-handler');
const { computeManifestFileId } = require('../src/engine/foundation/hash-service');

const TEST_PORT = 34571;
let testTmpDir = null;

function postJson(urlPath, payload) {
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

describe('Stage 2: Interactive Wizard & Real File Migration Pipeline', () => {
  before(async () => {
    testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage2-test-'));
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

  test('UI Contract: index.html содержит 3 шага, индикаторы и исключает скрытый demo: true', () => {
    const htmlPath = path.join(__dirname, '../src/renderer/index.html');
    assert.ok(fs.existsSync(htmlPath), 'index.html должен существовать');
    const content = fs.readFileSync(htmlPath, 'utf8');

    // Проверка версии
    assert.ok(content.includes('v2.3.0'), 'Версия в UI должна быть v2.3.0');

    // Проверка 3 шагов мастера
    assert.ok(content.includes('stepSection1'), 'Должен присутствовать Шаг 1 (Источник)');
    assert.ok(content.includes('stepSection2'), 'Должен присутствовать Шаг 2 (Приемник)');
    assert.ok(content.includes('stepSection3'), 'Должен присутствовать Шаг 3 (Сводка и запуск)');

    // Проверка кнопок выбора файлов и папок
    assert.ok(content.includes("browseFile('db')"), 'Кнопка выбора базы данных viber.db');
    assert.ok(content.includes("browseFile('zip')"), 'Кнопка выбора архива zip');
    assert.ok(content.includes('browseFolder()'), 'Кнопка выбора папки бэкапа iPhone');

    // Проверка отсутствия принудительного демо-режима
    assert.ok(!content.includes('demo: true'), 'Принудительный demo: true должен быть удален из вызова миграции');
    assert.ok(content.includes('demo: isDemo'), 'Флаг demo должен зависеть от активной вкладки');
  });

  test('/api/browse: возвращает корректную структуру ответа', async () => {
    const res = await postJson('/api/browse', { type: 'file', mockPath: 'C:\\test\\viber.db' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.selectedPath, 'C:\\test\\viber.db');
  });

  test('/api/migrate: отказ (400) при отсутствии источника в не-демо режиме', async () => {
    const res = await postJson('/api/migrate', {
      direction: 'android-to-ios',
      demo: false,
      sourcePath: null
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.success, false);
    assert.ok(res.data.error.includes('Укажите источник данных'), 'Должна быть понятная ошибка отсутствия источника');
  });

  test('/api/migrate: отказ (400) при несуществующем пути к файлу базы', async () => {
    const fakePath = path.join(testTmpDir, 'non_existent_viber_messages.db');
    const res = await postJson('/api/migrate', {
      direction: 'android-to-ios',
      demo: false,
      sourcePath: fakePath
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.data.success, false);
    assert.ok(res.data.error.includes('Файл не найден'), 'Должна быть ошибка об отсутствии файла');
  });

  test('/api/migrate: успешная миграция реального SQLite файла на диске (Zero Data Loss)', async () => {
    // 1. Создаем реальную базу данных SQLite на диске
    const realDbPath = path.join(testTmpDir, 'real_phone_viber.db');
    const ddlPath = path.join(__dirname, '../fixtures/schemas/android_viber_messages.sql');
    const ddl = fs.readFileSync(ddlPath, 'utf8');

    const db = new DatabaseSync(realDbPath);
    db.exec(ddl);

    // Добавляем 2 реальных диалога и 4 реальных сообщения
    db.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'Мария Рабочий', 1716000000000, 'Привет', 0),
             (2, 'Семья Чат', 1716000050000, 'Купил', 0);

      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1),
             (2, 2, 0, 1);

      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+380501112233', 'Мария', 'Mary'),
             (2, '+380504445566', 'Иван', 'Ivan');

      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime)
      VALUES (101, 1, 1, 'Привет! Документы отправлены.', 1716000001000, 0, 2, 0, 0),
             (102, 1, 1, 'Жду подтверждения от бухгалтерии.', 1716000002000, 0, 2, 0, 0),
             (103, 2, 2, 'Купил продукты к ужину.', 1716000051000, 0, 2, 0, 0),
             (104, 2, 2, 'Буду дома через 15 минут.', 1716000052000, 0, 2, 0, 0);
    `);
    db.close();

    // 2. Вызываем /api/migrate с РЕАЛЬНЫМ файлом и demo: false
    const res = await postJson('/api/migrate', {
      direction: 'android-to-ios',
      demo: false,
      sourcePath: realDbPath
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.report, 'Должен вернуть итоговый отчет report');
    
    // Проверяем, что перенесены именно НАШИ 2 чата и 4 сообщения, а не синтетический макет (3 чата/5 сообщ.)
    assert.strictEqual(res.data.report.chatsCount, 2, 'Должно быть ровно 2 перенесенных чата');
    assert.strictEqual(res.data.report.messagesCount, 4, 'Должно быть ровно 4 перенесенных сообщения');
    assert.strictEqual(res.data.report.deduplicatedCount, 0, 'Дубликатов не должно быть');
  });

  test('/api/migrate: распаковка и миграция официального архива Google Drive (zip)', async () => {
    // 1. Создаем временную базу сообщений
    const rawDbPath = path.join(testTmpDir, 'viber_messages.db');
    const ddl = fs.readFileSync(path.join(__dirname, '../fixtures/schemas/android_viber_messages.sql'), 'utf8');
    const db = new DatabaseSync(rawDbPath);
    db.exec(ddl);
    db.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'Чат из Архива', 1716000000000, 'Сообщение', 0);
      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1);
      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+1234567890', 'Google Drive Контакт', 'GDrive');
      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime)
      VALUES (1, 1, 1, 'Сообщение восстановлено из облачного архива', 1716000001000, 0, 2, 0, 0);
    `);
    db.close();

    // 2. Упаковываем базу в zip-архив
    const zipBuf = packViberBackupZip({
      viberDataDb: Buffer.from(''),
      viberMessagesDb: fs.readFileSync(rawDbPath)
    });
    const zipPath = path.join(testTmpDir, 'viber_backup.zip');
    fs.writeFileSync(zipPath, zipBuf);

    assert.ok(fs.existsSync(zipPath), 'Архив viber_backup.zip должен быть создан');

    // 3. Вызываем миграцию архива
    const res = await postJson('/api/migrate', {
      direction: 'android-to-ios',
      demo: false,
      sourcePath: zipPath
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.report.chatsCount, 1);
    assert.strictEqual(res.data.report.messagesCount, 1);
  });

  test('/api/migrate: внедрение в реальный бэкап iTunes (Manifest.db + hashed Chat.data)', async () => {
    // 1. Создаем каталог бэкапа iTunes
    const mockBackupDir = path.join(testTmpDir, 'mock_iphone_backup');
    fs.mkdirSync(mockBackupDir, { recursive: true });

    // Инициализируем Manifest.db в бэкапе
    const manifestPath = path.join(mockBackupDir, 'Manifest.db');
    const mDdl = fs.readFileSync(path.join(__dirname, '../fixtures/schemas/sample_manifest.sql'), 'utf8');
    const mDb = new DatabaseSync(manifestPath);
    mDb.exec(mDdl);
    mDb.close();

    // 2. Исходная база Android
    const sourceDb = path.join(testTmpDir, 'source_for_itunes.db');
    const aDdl = fs.readFileSync(path.join(__dirname, '../fixtures/schemas/android_viber_messages.sql'), 'utf8');
    const aDb = new DatabaseSync(sourceDb);
    aDb.exec(aDdl);
    aDb.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'Инъекция в бэкап', 1716000000000, 'Внедрение', 0);
      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1);
      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+999', 'Тест Инъекции', 'Test');
      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime)
      VALUES (1, 1, 1, 'Внедрение через Manifest.db успешно!', 1716000001000, 0, 2, 0, 0);
    `);
    aDb.close();

    // 3. Вызываем миграцию с указанием targetPath
    const res = await postJson('/api/migrate', {
      direction: 'android-to-ios',
      demo: false,
      sourcePath: sourceDb,
      targetPath: mockBackupDir
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);

    // 4. Проверяем, что в каталоге бэкапа появился хешированный файл iOS
    const expectedFileId = computeManifestFileId('AppDomainGroup-group.viber', 'database/Chat.data');
    const subFolder = path.join(mockBackupDir, expectedFileId.slice(0, 2));
    const injectedFilePath = path.join(subFolder, expectedFileId);

    assert.ok(fs.existsSync(injectedFilePath), `Файл ${injectedFilePath} должен существовать на диске в бэкапе`);
    const injectedSize = fs.statSync(injectedFilePath).size;
    assert.ok(injectedSize > 0, 'Размер внедренной базы Chat.data должен быть больше 0');

    // 5. Проверяем, что Manifest.db содержит обновленную запись
    const checkDb = new DatabaseSync(manifestPath);
    const row = checkDb.prepare('SELECT fileID, domain, relativePath FROM Files WHERE fileID = ?').get(expectedFileId);
    checkDb.close();

    assert.ok(row, 'Запись о Chat.data должна быть зарегистрирована в таблице Files Manifest.db');
    assert.strictEqual(row.domain, 'AppDomainGroup-group.viber');
    assert.strictEqual(row.relativePath, 'database/Chat.data');
  });
});
