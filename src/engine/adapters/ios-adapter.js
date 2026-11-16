/**
 * iOS CoreData Adapter: Чтение и запись баз данных iOS Viber (Chat.data / Contacts.data).
 * 
 * Отвечает за:
 * 1. Чтение сущностей CoreData (ZCONVERSATION, ZPARTICIPANT, ZMESSAGE).
 * 2. Конвертацию Apple Cocoa Epoch (секунды от 2001 г.) в канонические Unix миллисекунды.
 * 3. Экспорт UIM в схему iOS с динамическим сдвигом первичных ключей (KeyRebalancer).
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { unixMsToAppleSec, appleSecToUnixMs } = require('../foundation/time-engine');
const {
  CONVERSATION_TYPES,
  MESSAGE_TYPES,
  MESSAGE_STATUS,
  createParticipant,
  createMessage,
  createChatSession
} = require('../uim/contracts');
const { validateChatSession } = require('../uim/validator');
const { inspectKeyOffsets, getRebalancedKey } = require('./key-rebalancer');

/**
 * Сопоставляет тип контента iOS Viber с каноническим MESSAGE_TYPES
 */
function resolveIOSMessageType(rawType) {
  switch (rawType) {
    case 1: return MESSAGE_TYPES.IMAGE;
    case 2: return MESSAGE_TYPES.VIDEO;
    case 3: return MESSAGE_TYPES.VOICE;
    case 1000: return MESSAGE_TYPES.STICKER;
    case 999: return MESSAGE_TYPES.SYSTEM;
    default: return MESSAGE_TYPES.TEXT;
  }
}

/**
 * Сопоставляет канонический MESSAGE_TYPES с кодами iOS ZMESSAGETYPE
 */
function toIOSMessageType(uimType) {
  switch (uimType) {
    case MESSAGE_TYPES.IMAGE: return 1;
    case MESSAGE_TYPES.VIDEO: return 2;
    case MESSAGE_TYPES.VOICE: return 3;
    case MESSAGE_TYPES.STICKER: return 1000;
    case MESSAGE_TYPES.SYSTEM: return 999;
    default: return 0;
  }
}

/**
 * Открывает базу данных SQLite
 */
function openDatabase(dbOrPath) {
  if (typeof dbOrPath === 'string') {
    return new DatabaseSync(dbOrPath);
  }
  return dbOrPath;
}

/**
 * Импортирует данные из базы iOS Viber в каноническую UIM-модель
 * @param {string|DatabaseSync} dbOrPath - путь к файлу БД или экземпляр DatabaseSync
 * @returns {Array<object>} массив сессий UIMChatSession
 */
function importIOSToUIM(dbOrPath) {
  const db = openDatabase(dbOrPath);
  const sessions = [];

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  if (!tables.includes('ZCONVERSATION') || !tables.includes('ZMESSAGE')) {
    throw new Error('Invalid iOS Viber database: missing "ZCONVERSATION" or "ZMESSAGE" tables');
  }

  const hasParticipants = tables.includes('ZPARTICIPANT');
  const convRows = db.prepare('SELECT * FROM ZCONVERSATION').all();

  for (const conv of convRows) {
    const convPk = conv.Z_PK;
    const participants = [];

    if (hasParticipants) {
      const partRows = db.prepare('SELECT * FROM ZPARTICIPANT WHERE ZCONVERSATION = ?').all(convPk);
      for (const p of partRows) {
        participants.push(createParticipant({
          id: String(p.Z_PK),
          phoneNumber: p.ZPHONENUMBER || '',
          displayName: p.ZDISPLAYNAME || p.ZVIBERNAME || 'iPhone User',
          isOwner: Boolean(p.ZISOWNER)
        }));
      }
    }

    if (participants.length === 0) {
      participants.push(createParticipant({
        id: '1',
        phoneNumber: 'owner',
        displayName: 'Владелец iPhone',
        isOwner: true
      }));
    }

    const msgRows = db.prepare('SELECT * FROM ZMESSAGE WHERE ZCONVERSATION = ? ORDER BY ZDATE ASC').all(convPk);
    const messages = [];

    for (const m of msgRows) {
      const uimType = resolveIOSMessageType(m.ZMESSAGETYPE || 0);
      const isIncoming = Boolean(m.ZISINCOMING);
      const timestampMs = appleSecToUnixMs(m.ZDATE);

      let status = MESSAGE_STATUS.READ;
      if (m.ZSTATE === 0) status = MESSAGE_STATUS.SENT;
      else if (m.ZSTATE === 1) status = MESSAGE_STATUS.DELIVERED;

      const attachment = m.ZATTACHMENTPATH ? {
        filename: path.basename(m.ZATTACHMENTPATH),
        localPath: m.ZATTACHMENTPATH,
        mimeType: uimType === MESSAGE_TYPES.IMAGE ? 'image/jpeg' : (uimType === MESSAGE_TYPES.VIDEO ? 'video/mp4' : 'application/octet-stream'),
        fileSize: m.ZMEDIAFILESIZE || 0,
        durationSec: m.ZDURATION ? Math.round(m.ZDURATION) : 0
      } : null;

      messages.push(createMessage({
        id: String(m.Z_PK),
        senderId: String(m.ZSENDER || participants[0].id),
        timestampMs,
        text: m.ZTEXT || '',
        type: uimType,
        status,
        isIncoming,
        attachment
      }));
    }

    const convType = conv.ZTYPE === 1 ? CONVERSATION_TYPES.GROUP : CONVERSATION_TYPES.DIRECT;
    const session = createChatSession({
      id: String(conv.Z_PK),
      originalId: String(conv.Z_PK),
      type: convType,
      title: conv.ZNAME || (participants[0] ? participants[0].displayName : 'Диалог iOS'),
      participants,
      messages
    });

    validateChatSession(session);
    sessions.push(session);
  }

  return sessions;
}

/**
 * Экспортирует сессии UIM в базу данных формата iOS Viber (CoreData SQLite)
 * @param {Array<object>} sessions - массив сессий UIMChatSession
 * @param {string|DatabaseSync} dbOrPath - путь к файлу БД или экземпляр DatabaseSync
 * @param {string} ddlPathOrSql - SQL DDL схема (опционально)
 * @param {boolean} rebalanceKeys - включить сдвиг ключей для избежания коллизий
 * @returns {{ conversationsCount: number, messagesCount: number }}
 */
function exportUIMToIOS(sessions, dbOrPath, ddlPathOrSql = null, rebalanceKeys = true) {
  const db = openDatabase(dbOrPath);

  if (ddlPathOrSql) {
    const ddl = fs.existsSync(ddlPathOrSql) ? fs.readFileSync(ddlPathOrSql, 'utf8') : ddlPathOrSql;
    db.exec(ddl);
  }

  const { convOffset, partOffset, msgOffset } = rebalanceKeys
    ? inspectKeyOffsets(db)
    : { convOffset: 0, partOffset: 0, msgOffset: 0 };

  let localConvIdx = 0;
  let localPartIdx = 0;
  let localMsgIdx = 0;

  db.exec('BEGIN TRANSACTION');
  try {
    const insertConv = db.prepare(`
      INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
      VALUES (?, 1, 1, ?, ?, ?, 0)
    `);

    const insertPart = db.prepare(`
      INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZVIBERNAME, ZISOWNER)
      VALUES (?, 2, 1, ?, ?, ?, ?, ?)
    `);

    const insertMsg = db.prepare(`
      INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING, ZATTACHMENTPATH, ZMEDIAFILESIZE, ZDURATION)
      VALUES (?, 3, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const session of sessions) {
      validateChatSession(session);

      localConvIdx++;
      const convPk = getRebalancedKey(localConvIdx, convOffset);
      const convType = session.type === CONVERSATION_TYPES.GROUP ? 1 : 0;
      const lastMsg = session.messages[session.messages.length - 1];
      const convDateApple = lastMsg ? unixMsToAppleSec(lastMsg.timestampMs) : unixMsToAppleSec(Date.now());

      insertConv.run(convPk, convType, convDateApple, session.title || 'Диалог');

      const participantMap = new Map();
      for (const p of session.participants) {
        localPartIdx++;
        const partPk = getRebalancedKey(localPartIdx, partOffset);
        insertPart.run(
          partPk,
          convPk,
          p.phoneNumber || '',
          p.displayName || 'Viber User',
          p.displayName || 'Viber User',
          p.isOwner ? 1 : 0
        );
        participantMap.set(p.id, partPk);
      }

      const defaultSenderPk = participantMap.values().next().value || 1;

      for (const m of session.messages) {
        localMsgIdx++;
        const msgPk = getRebalancedKey(localMsgIdx, msgOffset);
        const senderPk = participantMap.get(m.senderId) || defaultSenderPk;
        const appleDate = unixMsToAppleSec(m.timestampMs);
        const iosMsgType = toIOSMessageType(m.type);
        const state = m.status === MESSAGE_STATUS.READ ? 2 : (m.status === MESSAGE_STATUS.DELIVERED ? 1 : 0);
        const isIncoming = m.isIncoming ? 1 : 0;
        const attachmentPath = m.attachment ? m.attachment.localPath : null;
        const fileSize = m.attachment ? m.attachment.fileSize : 0;
        const duration = m.attachment ? m.attachment.durationSec : 0;

        insertMsg.run(
          msgPk,
          convPk,
          senderPk,
          appleDate,
          m.text || '',
          iosMsgType,
          state,
          isIncoming,
          attachmentPath,
          fileSize,
          duration
        );
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    conversationsCount: sessions.length,
    messagesCount: localMsgIdx
  };
}

module.exports = {
  resolveIOSMessageType,
  toIOSMessageType,
  importIOSToUIM,
  exportUIMToIOS
};
