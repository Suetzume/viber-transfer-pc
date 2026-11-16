const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const {
  migrateAndroidToIOS,
  migrateIOSToAndroid,
  detectLocalViberDesktop
} = require('../src/engine/pipeline/migration-engine');
const { importIOSToUIM } = require('../src/engine/adapters/ios-adapter');
const { importAndroidToUIM } = require('../src/engine/adapters/android-adapter');
const { unpackZip } = require('../src/engine/backup/zip-handler');

const ANDROID_DDL_PATH = path.join(__dirname, '../fixtures/schemas/android_viber_messages.sql');
const IOS_DDL_PATH = path.join(__dirname, '../fixtures/schemas/ios_viber_chat.sql');
const MANIFEST_DDL_PATH = path.join(__dirname, '../fixtures/schemas/sample_manifest.sql');

describe('Layer 5: End-to-End Migration Engine (Global Milestone v1.1.0)', () => {
  it('successfully detects local desktop environments or returns empty safely', () => {
    const detected = detectLocalViberDesktop();
    assert.ok(Array.isArray(detected));
  });

  it('executes full end-to-end migration: Android -> iOS with Manifest.db integration', () => {
    // 1. Создаем исходную базу Android с реальными тестовыми данными
    const androidDb = new DatabaseSync(':memory:');
    androidDb.exec(fs.readFileSync(ANDROID_DDL_PATH, 'utf8'));

    androidDb.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'Семейный чат', 1715000000000, 'Привет из Берлина!', 1);

      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1), (2, 1, 1, 1);

      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+380501112233', 'Мама', 'Mama'),
             (2, 'owner', 'Я', 'Me');

      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime, media_path)
      VALUES 
        (10, 1, 1, 'Привет из Берлина!', 1715000000000, 0, 2, 0, 0, NULL),
        (11, 1, 2, 'Отличное фото!', 1715000020000, 1, 2, 0, 1, '/sdcard/viber/media/berlin.jpg');
    `);

    // 2. Создаем целевую базу iOS и Manifest.db
    const iosDb = new DatabaseSync(':memory:');
    iosDb.exec(fs.readFileSync(IOS_DDL_PATH, 'utf8'));

    const manifestDb = new DatabaseSync(':memory:');
    manifestDb.exec(fs.readFileSync(MANIFEST_DDL_PATH, 'utf8'));

    // 3. Запуск сквозного конвейера миграции
    const progressEvents = [];
    const report = migrateAndroidToIOS({
      androidDb,
      targetIosDb: iosDb,
      manifestDb,
      onProgress: (evt) => progressEvents.push(evt)
    });

    // 4. Проверка отчета о миграции
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.direction, 'android-to-ios');
    assert.strictEqual(report.chatsCount, 1);
    assert.strictEqual(report.messagesCount, 2);
    assert.ok(progressEvents.length >= 4);

    // 5. Проверка целевой базы iOS
    const iosSessions = importIOSToUIM(iosDb);
    assert.strictEqual(iosSessions.length, 1);
    assert.strictEqual(iosSessions[0].title, 'Семейный чат');
    assert.strictEqual(iosSessions[0].messages.length, 2);
    assert.strictEqual(iosSessions[0].messages[0].text, 'Привет из Берлина!');
    assert.strictEqual(iosSessions[0].messages[0].timestampMs, 1715000000000);
    assert.strictEqual(iosSessions[0].messages[1].attachment.filename, 'berlin.jpg');

    // 6. Проверка записи в Manifest.db
    const manifestRows = manifestDb.prepare('SELECT * FROM Files WHERE domain = ?').all('AppDomainGroup-group.viber');
    assert.strictEqual(manifestRows.length, 1);
    assert.strictEqual(manifestRows[0].relativePath, 'database/Chat.data');
  });

  it('executes full end-to-end migration: iOS -> Android with zip backup creation', () => {
    // 1. Создаем исходную базу iOS
    const iosDb = new DatabaseSync(':memory:');
    iosDb.exec(fs.readFileSync(IOS_DDL_PATH, 'utf8'));

    // 1715000000000 ms -> Apple Cocoa seconds: (1715000000 - 978307200) = 736692800.0
    const appleSec = 736692800.0;

    iosDb.exec(`
      INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
      VALUES (1, 1, 1, 0, ${appleSec}, 'Дмитрий', 0);

      INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
      VALUES (1, 2, 1, 1, '+380679998877', 'Дмитрий', 0);

      INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING)
      VALUES (1, 3, 1, 1, 1, ${appleSec}, 'Сообщение с iPhone', 0, 2, 1);
    `);

    // 2. Создаем целевую базу Android
    const androidDb = new DatabaseSync(':memory:');
    androidDb.exec(fs.readFileSync(ANDROID_DDL_PATH, 'utf8'));

    const tmpZipPath = path.join(__dirname, 'test_output_viber_backup.zip');

    // 3. Запуск миграции
    const report = migrateIOSToAndroid({
      iosDb,
      targetAndroidDb: androidDb,
      outputZipPath: tmpZipPath
    });

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.direction, 'ios-to-android');
    assert.strictEqual(report.chatsCount, 1);
    assert.strictEqual(report.messagesCount, 1);
    assert.strictEqual(report.zipPath, tmpZipPath);

    // 4. Проверка базы Android
    const androidSessions = importAndroidToUIM(androidDb);
    assert.strictEqual(androidSessions.length, 1);
    assert.strictEqual(androidSessions[0].title, 'Дмитрий');
    assert.strictEqual(androidSessions[0].messages[0].text, 'Сообщение с iPhone');
    assert.strictEqual(androidSessions[0].messages[0].timestampMs, 1715000000000);

    // 5. Проверка распаковки zip архива
    assert.ok(fs.existsSync(tmpZipPath));
    const zipBuf = fs.readFileSync(tmpZipPath);
    const unzipped = unpackZip(zipBuf);
    assert.strictEqual(unzipped.length, 2);
    assert.ok(unzipped.some(f => f.name === 'viber_messages'));

    // Удаляем временный zip
    fs.unlinkSync(tmpZipPath);
  });

  it('guarantees Zero Data Loss Round-Trip across both operating systems: Android -> iOS -> Android', () => {
    // Этап 1: Исходный Android
    const originalAndroidDb = new DatabaseSync(':memory:');
    originalAndroidDb.exec(fs.readFileSync(ANDROID_DDL_PATH, 'utf8'));

    originalAndroidDb.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'Критический проект', 1720000000000, 'Все в порядке', 0);

      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1);

      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+380505554433', 'Партнер', 'Partner');

      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime)
      VALUES (1, 1, 1, 'Все в порядке', 1720000000000, 0, 2, 0, 0);
    `);

    // Этап 2: Android -> iOS
    const intermediateIosDb = new DatabaseSync(':memory:');
    intermediateIosDb.exec(fs.readFileSync(IOS_DDL_PATH, 'utf8'));
    migrateAndroidToIOS({
      androidDb: originalAndroidDb,
      targetIosDb: intermediateIosDb
    });

    // Этап 3: iOS -> Финальный Android
    const finalAndroidDb = new DatabaseSync(':memory:');
    finalAndroidDb.exec(fs.readFileSync(ANDROID_DDL_PATH, 'utf8'));
    migrateIOSToAndroid({
      iosDb: intermediateIosDb,
      targetAndroidDb: finalAndroidDb
    });

    // Этап 4: Верификация равенства сущностей
    const original = importAndroidToUIM(originalAndroidDb)[0];
    const restored = importAndroidToUIM(finalAndroidDb)[0];

    assert.strictEqual(restored.title, original.title);
    assert.strictEqual(restored.messages.length, original.messages.length);
    assert.strictEqual(restored.messages[0].text, original.messages[0].text);
    assert.strictEqual(restored.messages[0].timestampMs, original.messages[0].timestampMs);
    assert.strictEqual(restored.messages[0].isIncoming, original.messages[0].isIncoming);
  });
});
