const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const {
  importAndroidToUIM,
  exportUIMToAndroid,
  resolveMessageType,
  resolveExtraMime
} = require('../src/engine/adapters/android-adapter');
const { MESSAGE_TYPES, MESSAGE_STATUS, CONVERSATION_TYPES } = require('../src/engine/uim/contracts');

const DDL_PATH = path.join(__dirname, '../fixtures/schemas/android_viber_messages.sql');

describe('Layer 3: Android SQLite Adapter', () => {
  it('correctly maps raw extra_mime values to canonical MESSAGE_TYPES', () => {
    assert.strictEqual(resolveMessageType(0, 0), MESSAGE_TYPES.TEXT);
    assert.strictEqual(resolveMessageType(0, 1), MESSAGE_TYPES.IMAGE);
    assert.strictEqual(resolveMessageType(0, 2), MESSAGE_TYPES.VIDEO);
    assert.strictEqual(resolveMessageType(0, 3), MESSAGE_TYPES.VOICE);
    assert.strictEqual(resolveMessageType(0, 1000), MESSAGE_TYPES.STICKER);
    assert.strictEqual(resolveMessageType(2, 0), MESSAGE_TYPES.SYSTEM);
  });

  it('correctly maps canonical MESSAGE_TYPES back to extra_mime', () => {
    assert.strictEqual(resolveExtraMime(MESSAGE_TYPES.IMAGE), 1);
    assert.strictEqual(resolveExtraMime(MESSAGE_TYPES.VIDEO), 2);
    assert.strictEqual(resolveExtraMime(MESSAGE_TYPES.VOICE), 3);
    assert.strictEqual(resolveExtraMime(MESSAGE_TYPES.STICKER), 1000);
    assert.strictEqual(resolveExtraMime(MESSAGE_TYPES.TEXT), 0);
  });

  it('imports raw Android SQLite fixtures into valid UIMChatSession objects', () => {
    const db = new DatabaseSync(':memory:');
    const ddl = fs.readFileSync(DDL_PATH, 'utf8');
    db.exec(ddl);

    // Вставляем тестовый диалог
    db.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'Анна Смирнова', 1715000000000, 'Привет!', 0);

      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1), (2, 1, 1, 1);

      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+380501112233', 'Анна Смирнова', 'Anna'),
             (2, 'owner', 'Я', 'Owner');

      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime, media_path)
      VALUES 
        (101, 1, 1, 'Привет, как дела?', 1715000000000, 0, 2, 0, 0, NULL),
        (102, 1, 2, 'Привет! Все отлично, вот фото', 1715000010000, 1, 2, 0, 1, '/sdcard/viber/media/photo.jpg'),
        (103, 1, 1, '', 1715000020000, 0, 2, 0, 3, '/sdcard/viber/media/voice_note.ptt');
    `);

    const sessions = importAndroidToUIM(db);

    assert.strictEqual(sessions.length, 1);
    const session = sessions[0];
    assert.strictEqual(session.id, '1');
    assert.strictEqual(session.type, CONVERSATION_TYPES.DIRECT);
    assert.strictEqual(session.title, 'Анна Смирнова');
    assert.strictEqual(session.participants.length, 2);
    assert.strictEqual(session.messages.length, 3);

    // Проверяем 1-е сообщение (текст, входящее)
    const m1 = session.messages[0];
    assert.strictEqual(m1.text, 'Привет, как дела?');
    assert.strictEqual(m1.type, MESSAGE_TYPES.TEXT);
    assert.strictEqual(m1.isIncoming, true);
    assert.strictEqual(m1.timestampMs, 1715000000000);

    // Проверяем 2-е сообщение (фото, исходящее)
    const m2 = session.messages[1];
    assert.strictEqual(m2.type, MESSAGE_TYPES.IMAGE);
    assert.strictEqual(m2.isIncoming, false);
    assert.ok(m2.attachment);
    assert.strictEqual(m2.attachment.filename, 'photo.jpg');

    // Проверяем 3-е сообщение (голосовое PTT)
    const m3 = session.messages[2];
    assert.strictEqual(m3.type, MESSAGE_TYPES.VOICE);
    assert.strictEqual(m3.isIncoming, true);
    assert.ok(m3.attachment);
    assert.strictEqual(m3.attachment.filename, 'voice_note.ptt');
  });

  it('guarantees 100% round-trip fidelity (Android -> UIM -> Android -> UIM)', () => {
    // Исходная база
    const sourceDb = new DatabaseSync(':memory:');
    const ddl = fs.readFileSync(DDL_PATH, 'utf8');
    sourceDb.exec(ddl);

    sourceDb.exec(`
      INSERT INTO conversations (_id, name, date, snippet, conversation_type)
      VALUES (1, 'Рабочая группа', 1716000000000, 'Отчет готов', 1);

      INSERT INTO participants (_id, conversation_id, participant_type, active)
      VALUES (1, 1, 0, 1);

      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+380671234567', 'Коллега', 'Colleague');

      INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime)
      VALUES 
        (1, 1, 1, 'Доброе утро!', 1716000000000, 0, 2, 0, 0),
        (2, 1, 1, 'Отчет готов', 1716000050000, 0, 2, 0, 0);
    `);

    // Шаг 1: Чтение в UIM
    const initialUIM = importAndroidToUIM(sourceDb);
    assert.strictEqual(initialUIM.length, 1);
    assert.strictEqual(initialUIM[0].messages.length, 2);

    // Шаг 2: Экспорт UIM в новую чистую базу
    const targetDb = new DatabaseSync(':memory:');
    const exportResult = exportUIMToAndroid(initialUIM, targetDb, ddl);
    assert.strictEqual(exportResult.conversationsCount, 1);
    assert.strictEqual(exportResult.messagesCount, 2);

    // Шаг 3: Повторный импорт из целевой базы и сравнение
    const restoredUIM = importAndroidToUIM(targetDb);
    assert.strictEqual(restoredUIM.length, 1);

    const sInitial = initialUIM[0];
    const sRestored = restoredUIM[0];

    assert.strictEqual(sRestored.title, sInitial.title);
    assert.strictEqual(sRestored.type, sInitial.type);
    assert.strictEqual(sRestored.messages.length, sInitial.messages.length);

    for (let i = 0; i < sInitial.messages.length; i++) {
      assert.strictEqual(sRestored.messages[i].text, sInitial.messages[i].text);
      assert.strictEqual(sRestored.messages[i].timestampMs, sInitial.messages[i].timestampMs);
      assert.strictEqual(sRestored.messages[i].type, sInitial.messages[i].type);
      assert.strictEqual(sRestored.messages[i].isIncoming, sInitial.messages[i].isIncoming);
    }
  });
});
