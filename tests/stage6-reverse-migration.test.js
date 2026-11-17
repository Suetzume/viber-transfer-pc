/**
 * Stage 6 Test Suite: Реверс миграции (iPhone ➔ Android) & Финализация v3.0.0
 * 
 * Проверяет:
 * 1. UI Contract двустороннего переключения направления (кнопка ⇄, смена блоков источника и приемника).
 * 2. REST API /api/migrate в режиме ios-to-android (демо и реальный режимы).
 * 3. Полный цикл реального извлечения из бэкапа iTunes (Manifest.db + hashed Chat.data + media)
 *    в официальный Google Drive архив viber_backup.zip.
 * 4. 100% побайтовую сохранность данных и вложений (Zero Data Loss Bitwise Fidelity).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const { startServer } = require('../src/server/bridge-server');
const { computeManifestFileId, getBackupHashedPath } = require('../src/engine/foundation/hash-service');
const { openManifestDatabase, createManifestFileDescriptor, upsertManifestRecord } = require('../src/engine/manifest/manifest-builder');
const { unpackZip } = require('../src/engine/backup/zip-handler');

const TEST_PORT = 34586;

function getFixture(filename) {
  const p = path.resolve(__dirname, '../fixtures/schemas', filename);
  return fs.readFileSync(p, 'utf8');
}

function postJson(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body || '{}') });
        } catch (_) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Stage 6: Bidirectional iOS to Android Migration & Final Enterprise Release', () => {
  let serverInstance = null;

  before(async () => {
    serverInstance = await startServer(TEST_PORT);
  });

  after(() => {
    if (serverInstance && serverInstance.close) {
      serverInstance.close();
    }
  });

  it('UI Contract: index.html содержит кнопку ⇄, переключатель направления и блоки реверс-миграции', () => {
    const htmlPath = path.join(__dirname, '../src/renderer/index.html');
    const content = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(content.includes('swapDirectionBtn'), 'Должна присутствовать кнопка swapDirectionBtn');
    assert.ok(content.includes('swapMigrationDirection'), 'Должна присутствовать функция swapMigrationDirection');
    assert.ok(content.includes('androidSourceBlock'), 'Блок источника Android');
    assert.ok(content.includes('iosSourceBlock'), 'Блок источника iOS');
    assert.ok(content.includes('iosTargetBlock'), 'Блок приемника iOS');
    assert.ok(content.includes('androidTargetBlock'), 'Блок приемника Android');
    assert.ok(content.includes('targetAndroidZipInput'), 'Поле ввода целевого архива Android');
    assert.ok(content.includes('browseAndroidZipBtn'), 'Кнопка выбора пути сохранения архива Android');
  });

  it('/api/migrate: успешно выполняет реверс-миграцию в демо-режиме (ios-to-android)', async () => {
    const resp = await postJson('/api/migrate', {
      demo: true,
      direction: 'ios-to-android'
    });

    assert.equal(resp.status, 200);
    assert.equal(resp.data.success, true);
    assert.equal(resp.data.report.direction, 'ios-to-android');
    assert.ok(resp.data.report.chatsCount >= 1);
    assert.ok(resp.data.report.messagesCount >= 1);
  });

  it('/api/migrate: полноценный сквозной реверс из бэкапа iTunes в архив viber_backup.zip', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage6-e2e-'));
    const itunesBackupDir = path.join(tempDir, 'iTunesBackup');
    fs.mkdirSync(itunesBackupDir, { recursive: true });

    // 1. Создаем Manifest.db
    const manifestPath = path.join(itunesBackupDir, 'Manifest.db');
    const mDb = openManifestDatabase(manifestPath);

    // 2. Создаем хешированную базу Chat.data
    const chatDomain = 'AppDomainGroup-group.viber';
    const chatRelative = 'database/Chat.data';
    const chatFileId = computeManifestFileId(chatDomain, chatRelative);
    const chatPathInfo = getBackupHashedPath(chatFileId);
    const chatFolder = path.join(itunesBackupDir, chatPathInfo.folder);
    fs.mkdirSync(chatFolder, { recursive: true });
    const fullChatPath = path.join(chatFolder, chatPathInfo.filename);

    const iosDb = new DatabaseSync(fullChatPath);
    iosDb.exec(getFixture('ios_viber_chat.sql'));
    iosDb.exec(`
      INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
      VALUES (1, 1, 1, 0, 736692800.0, 'Чат с айфона', 0);
      INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
      VALUES (1, 2, 1, 1, '+380991112233', 'Сергей', 0);
      INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING, ZATTACHMENTPATH, ZMEDIAFILESIZE)
      VALUES (1, 3, 1, 1, 1, 736692800.0, 'Вот документ и проект', 0, 2, 1, 'Attachments/project_doc.pdf', 32);
    `);
    iosDb.close();

    const chatDesc = createManifestFileDescriptor({
      domain: chatDomain,
      relativePath: chatRelative,
      fileSize: 65536
    });
    upsertManifestRecord(mDb, chatDesc);

    // 3. Создаем медиафайл вложений в структуре бэкапа
    const docBytes = Buffer.from('PDF_DOCUMENT_BINARY_PAYLOAD_TEST');
    const mediaRelative = 'Attachments/project_doc.pdf';
    const mediaFileId = computeManifestFileId(chatDomain, mediaRelative);
    const mediaPathInfo = getBackupHashedPath(mediaFileId);
    const mediaFolder = path.join(itunesBackupDir, mediaPathInfo.folder);
    fs.mkdirSync(mediaFolder, { recursive: true });
    const fullMediaPath = path.join(mediaFolder, mediaPathInfo.filename);
    fs.writeFileSync(fullMediaPath, docBytes);

    const mediaDesc = createManifestFileDescriptor({
      domain: chatDomain,
      relativePath: mediaRelative,
      fileSize: docBytes.length
    });
    upsertManifestRecord(mDb, mediaDesc);
    mDb.close();

    // 4. Целевой архив viber_backup.zip
    const outZip = path.join(tempDir, 'output_viber_backup.zip');

    // 5. Запуск миграции через API
    const resp = await postJson('/api/migrate', {
      direction: 'ios-to-android',
      sourcePath: itunesBackupDir,
      targetPath: outZip
    });

    assert.equal(resp.status, 200);
    assert.equal(resp.data.success, true);
    assert.equal(resp.data.report.chatsCount, 1);
    assert.equal(resp.data.report.messagesCount, 1);
    assert.equal(resp.data.report.mediaCount, 1);
    assert.ok(fs.existsSync(outZip), 'Архив viber_backup.zip должен быть физически создан');

    // 6. Проверяем структуру созданного архива (Zero Data Loss)
    const zipBytes = fs.readFileSync(outZip);
    const entries = unpackZip(zipBytes);

    const msgEntry = entries.find(e => e.name === 'viber_messages');
    assert.ok(msgEntry, 'В архиве должен быть файл viber_messages');

    const mediaEntry = entries.find(e => e.name === 'media/project_doc.pdf');
    assert.ok(mediaEntry, 'В архиве должен быть медиафайл media/project_doc.pdf');
    assert.deepEqual(mediaEntry.data, docBytes, 'Побайтовая идентичность медиафайла при реверсе');

    // Проверяем, что в распакованной базе сообщения присутствуют
    const unzippedDbPath = path.join(tempDir, 'checked_messages.db');
    fs.writeFileSync(unzippedDbPath, msgEntry.data);
    const checkDb = new DatabaseSync(unzippedDbPath);
    const row = checkDb.prepare('SELECT body, media_path FROM messages WHERE _id = 1').get();
    assert.equal(row.body, 'Вот документ и проект');
    assert.ok(row.media_path.includes('project_doc.pdf'));
    checkDb.close();

    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  });

});
