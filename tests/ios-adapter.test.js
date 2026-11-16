const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const {
  importIOSToUIM,
  exportUIMToIOS,
  resolveIOSMessageType,
  toIOSMessageType
} = require('../src/engine/adapters/ios-adapter');
const { inspectKeyOffsets, getRebalancedKey } = require('../src/engine/adapters/key-rebalancer');
const { MESSAGE_TYPES, CONVERSATION_TYPES } = require('../src/engine/uim/contracts');
const { unixMsToAppleSec, appleSecToUnixMs } = require('../src/engine/foundation/time-engine');

const DDL_PATH = path.join(__dirname, '../fixtures/schemas/ios_viber_chat.sql');

describe('Layer 3: iOS CoreData Adapter & KeyRebalancer', () => {
  it('correctly maps raw ZMESSAGETYPE to canonical MESSAGE_TYPES and back', () => {
    assert.strictEqual(resolveIOSMessageType(0), MESSAGE_TYPES.TEXT);
    assert.strictEqual(resolveIOSMessageType(1), MESSAGE_TYPES.IMAGE);
    assert.strictEqual(resolveIOSMessageType(2), MESSAGE_TYPES.VIDEO);
    assert.strictEqual(resolveIOSMessageType(3), MESSAGE_TYPES.VOICE);
    assert.strictEqual(resolveIOSMessageType(1000), MESSAGE_TYPES.STICKER);

    assert.strictEqual(toIOSMessageType(MESSAGE_TYPES.IMAGE), 1);
    assert.strictEqual(toIOSMessageType(MESSAGE_TYPES.VIDEO), 2);
    assert.strictEqual(toIOSMessageType(MESSAGE_TYPES.VOICE), 3);
    assert.strictEqual(toIOSMessageType(MESSAGE_TYPES.STICKER), 1000);
    assert.strictEqual(toIOSMessageType(MESSAGE_TYPES.TEXT), 0);
  });

  it('KeyRebalancer correctly inspects existing offsets and generates shifted keys', () => {
    const db = new DatabaseSync(':memory:');
    const ddl = fs.readFileSync(DDL_PATH, 'utf8');
    db.exec(ddl);

    // Вставляем существующие служебные записи (например, приветственный бот Viber)
    db.exec(`
      INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
      VALUES (5, 1, 1, 0, 700000000.0, 'Viber Service', 0);

      INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
      VALUES (12, 2, 1, 5, 'viber', 'Viber', 0);

      INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING)
      VALUES (42, 3, 1, 5, 12, 700000000.0, 'Welcome to Viber', 0, 2, 1);
    `);

    const offsets = inspectKeyOffsets(db);
    assert.strictEqual(offsets.convOffset, 5);
    assert.strictEqual(offsets.partOffset, 12);
    assert.strictEqual(offsets.msgOffset, 42);

    assert.strictEqual(getRebalancedKey(1, offsets.convOffset), 6);
    assert.strictEqual(getRebalancedKey(2, offsets.convOffset), 7);
  });

  it('imports raw iOS CoreData SQLite into valid UIMChatSession objects with date conversion', () => {
    const db = new DatabaseSync(':memory:');
    const ddl = fs.readFileSync(DDL_PATH, 'utf8');
    db.exec(ddl);

    const testUnixMs = 1715000000000;
    const testAppleSec = unixMsToAppleSec(testUnixMs);

    db.exec(`
      INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
      VALUES (1, 1, 1, 0, ${testAppleSec}, 'Елена iOS', 0);

      INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZVIBERNAME, ZISOWNER)
      VALUES (1, 2, 1, 1, '+380991234567', 'Елена', 'Elena', 0);

      INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING, ZATTACHMENTPATH)
      VALUES 
        (1, 3, 1, 1, 1, ${testAppleSec}, 'Привет из Купертино!', 0, 2, 1, NULL),
        (2, 3, 1, 1, 1, ${testAppleSec + 10}, '', 1, 2, 1, 'Attachments/photo_ios.jpg');
    `);

    const sessions = importIOSToUIM(db);

    assert.strictEqual(sessions.length, 1);
    const session = sessions[0];
    assert.strictEqual(session.title, 'Елена iOS');
    assert.strictEqual(session.type, CONVERSATION_TYPES.DIRECT);
    assert.strictEqual(session.messages.length, 2);

    // Проверяем преобразование временной метки Apple -> Unix
    const m1 = session.messages[0];
    assert.strictEqual(m1.text, 'Привет из Купертино!');
    assert.strictEqual(m1.timestampMs, testUnixMs);
    assert.strictEqual(m1.isIncoming, true);

    // Проверяем медиавложение
    const m2 = session.messages[1];
    assert.strictEqual(m2.type, MESSAGE_TYPES.IMAGE);
    assert.ok(m2.attachment);
    assert.strictEqual(m2.attachment.filename, 'photo_ios.jpg');
  });

  it('guarantees collision-free export into iOS DB and 100% round-trip fidelity', () => {
    // 1. Создаем базу с уже существующим сообщением
    const targetDb = new DatabaseSync(':memory:');
    const ddl = fs.readFileSync(DDL_PATH, 'utf8');
    targetDb.exec(ddl);

    targetDb.exec(`
      INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
      VALUES (1, 1, 1, 0, 0.0, 'Существующий чат', 0);

      INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
      VALUES (1, 2, 1, 1, '000', 'Бот', 0);

      INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING)
      VALUES (1, 3, 1, 1, 1, 0.0, 'Системное сообщение', 0, 2, 1);
    `);

    // 2. Формируем тестовую UIM-сессию для переноса
    const importSessions = [{
      id: 'android_conv_99',
      originalId: 'android_conv_99',
      type: CONVERSATION_TYPES.DIRECT,
      title: 'Перенесенный чат',
      participants: [{
        id: 'user_1',
        phoneNumber: '+380509998877',
        displayName: 'Михаил',
        isOwner: false
      }],
      messages: [{
        id: 'msg_99',
        senderId: 'user_1',
        timestampMs: 1716000000000,
        text: 'Тест переноса на iPhone',
        type: MESSAGE_TYPES.TEXT,
        status: 'read',
        isIncoming: true
      }]
    }];

    // 3. Экспорт с пересчетом ключей KeyRebalancer
    const res = exportUIMToIOS(importSessions, targetDb, null, true);
    assert.strictEqual(res.conversationsCount, 1);
    assert.strictEqual(res.messagesCount, 1);

    // 4. Проверяем, что коллизии не произошло и новые ключи сдвинулись (Z_PK = 2)
    const convRows = targetDb.prepare('SELECT Z_PK, ZNAME FROM ZCONVERSATION ORDER BY Z_PK ASC').all();
    assert.strictEqual(convRows.length, 2);
    assert.strictEqual(convRows[0].Z_PK, 1);
    assert.strictEqual(convRows[1].Z_PK, 2);
    assert.strictEqual(convRows[1].ZNAME, 'Перенесенный чат');

    const msgRows = targetDb.prepare('SELECT Z_PK, ZTEXT FROM ZMESSAGE ORDER BY Z_PK ASC').all();
    assert.strictEqual(msgRows.length, 2);
    assert.strictEqual(msgRows[0].Z_PK, 1);
    assert.strictEqual(msgRows[1].Z_PK, 2);
    assert.strictEqual(msgRows[1].ZTEXT, 'Тест переноса на iPhone');

    // 5. Обратный импорт и проверка совпадения
    const reimported = importIOSToUIM(targetDb);
    assert.strictEqual(reimported.length, 2);
    const transferred = reimported.find(s => s.title === 'Перенесенный чат');
    assert.ok(transferred);
    assert.strictEqual(transferred.messages[0].text, 'Тест переноса на iPhone');
    assert.strictEqual(transferred.messages[0].timestampMs, 1716000000000);
  });
});
