/**
 * Android SQLite Adapter: Чтение и запись баз данных Android Viber (viber_messages.db / viber.db).
 * 
 * Отвечает за:
 * 1. Чтение реляционных таблиц (conversations, participants, participants_info, messages).
 * 2. Нормализацию в канонические сущности UIM (Unified Intermediate Model).
 * 3. Экспорт UIM обратно в SQLite схему Android с сохранением ссылочной целостности (FK).
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const {
  CONVERSATION_TYPES,
  MESSAGE_TYPES,
  MESSAGE_STATUS,
  createParticipant,
  createMessage,
  createChatSession
} = require('../uim/contracts');
const { validateChatSession } = require('../uim/validator');

/**
 * Сопоставляет тип контента Viber с каноническим MESSAGE_TYPES
 */
function resolveMessageType(rawType, extraMime = 0) {
  if (extraMime === 1) return MESSAGE_TYPES.IMAGE;
  if (extraMime === 2) return MESSAGE_TYPES.VIDEO;
  if (extraMime === 3) return MESSAGE_TYPES.VOICE; // PTT аудио
  if (extraMime === 1000) return MESSAGE_TYPES.STICKER;
  if (rawType === 2) return MESSAGE_TYPES.SYSTEM;
  return MESSAGE_TYPES.TEXT;
}

/**
 * Сопоставляет extra_mime с каноническим MESSAGE_TYPES при обратном экспорте
 */
function resolveExtraMime(uimType) {
  switch (uimType) {
    case MESSAGE_TYPES.IMAGE: return 1;
    case MESSAGE_TYPES.VIDEO: return 2;
    case MESSAGE_TYPES.VOICE: return 3;
    case MESSAGE_TYPES.STICKER: return 1000;
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
 * Импортирует данные из базы Android Viber в каноническую UIM-модель
 * @param {string|DatabaseSync} dbOrPath - путь к файлу БД или экземпляр DatabaseSync
 * @returns {Array<object>} массив сессий UIMChatSession
 */
function importAndroidToUIM(dbOrPath) {
  const isOwnedDb = typeof dbOrPath === 'string';
  const db = openDatabase(dbOrPath);
  const sessions = [];

  try {

  // 1. Проверяем наличие ключевых таблиц
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  if (!tables.includes('conversations') || !tables.includes('messages')) {
    throw new Error('Invalid Android Viber database: missing "conversations" or "messages" tables');
  }

  const hasParticipants = tables.includes('participants');
  const hasParticipantsInfo = tables.includes('participants_info');

  // 2. Считываем все диалоги
  const convRows = db.prepare('SELECT * FROM conversations').all();

  for (const conv of convRows) {
    const convId = conv._id;
    const participants = [];

    // Читаем участников диалога
    if (hasParticipants) {
      let partQuery = `
        SELECT p._id AS p_id, p.participant_type
        FROM participants p
        WHERE p.conversation_id = ?
      `;
      if (hasParticipantsInfo) {
        partQuery = `
          SELECT p._id AS p_id, p.participant_type,
                 pi.number, pi.display_name, pi.viber_name
          FROM participants p
          LEFT JOIN participants_info pi ON p._id = pi._id
          WHERE p.conversation_id = ?
        `;
      }

      const partRows = db.prepare(partQuery).all(convId);
      for (const p of partRows) {
        participants.push(createParticipant({
          id: String(p.p_id),
          phoneNumber: p.number || '',
          displayName: p.display_name || p.viber_name || 'Viber User',
          isOwner: p.participant_type === 1 || p.number === 'owner'
        }));
      }
    }

    // Если список участников пуст (например, служебный диалог), создаем дефолтного владельца
    if (participants.length === 0) {
      participants.push(createParticipant({
        id: '1',
        phoneNumber: 'owner',
        displayName: 'Владелец',
        isOwner: true
      }));
    }

    // 3. Считываем все сообщения диалога
    const msgRows = db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY msg_date ASC
    `).all(convId);

    const messages = [];
    for (const m of msgRows) {
      const extraMime = m.extra_mime || 0;
      const uimType = resolveMessageType(m.type, extraMime);
      const isIncoming = m.type === 0;

      let status = MESSAGE_STATUS.READ;
      if (m.status === 0) status = MESSAGE_STATUS.SENT;
      else if (m.status === 1) status = MESSAGE_STATUS.DELIVERED;
      else if (m.unread === 1) status = MESSAGE_STATUS.DELIVERED;

      const attachment = m.media_path ? {
        filename: path.basename(m.media_path),
        localPath: m.media_path,
        mimeType: extraMime === 1 ? 'image/jpeg' : (extraMime === 2 ? 'video/mp4' : 'application/octet-stream'),
        fileSize: 0,
        durationSec: m.extra_duration ? Math.round(m.extra_duration / 1000) : 0
      } : null;

      messages.push(createMessage({
        id: String(m._id),
        senderId: String(m.participant_id || (isIncoming ? participants[0].id : '1')),
        timestampMs: Number(m.msg_date),
        text: m.body || '',
        type: uimType,
        status,
        isIncoming,
        attachment
      }));
    }

    let convType = CONVERSATION_TYPES.DIRECT;
    if (conv.conversation_type === 1) convType = CONVERSATION_TYPES.GROUP;
    else if (conv.conversation_type === 2) convType = CONVERSATION_TYPES.BOT;

    const session = createChatSession({
      id: String(conv._id),
      originalId: String(conv._id),
      type: convType,
      title: conv.name || (participants[0] ? participants[0].displayName : 'Диалог'),
      participants,
      messages
    });

    validateChatSession(session);
    sessions.push(session);
  }

  return sessions;
} finally {
  if (isOwnedDb) {
    try { db.close(); } catch (_) {}
  }
}
}

/**
 * Экспортирует сессии UIM в базу данных формата Android Viber
 * @param {Array<object>} sessions - массив сессий UIMChatSession
 * @param {string|DatabaseSync} dbOrPath - путь к файлу БД или экземпляр DatabaseSync
 * @param {string} ddlPathOrSql - SQL DDL схема (опционально)
 * @returns {{ conversationsCount: number, messagesCount: number }}
 */
function exportUIMToAndroid(sessions, dbOrPath, ddlPathOrSql = null) {
  const isOwnedDb = typeof dbOrPath === 'string';
  const db = openDatabase(dbOrPath);

  try {

  // Инициализация схемы
  if (ddlPathOrSql) {
    const ddl = fs.existsSync(ddlPathOrSql) ? fs.readFileSync(ddlPathOrSql, 'utf8') : ddlPathOrSql;
    db.exec(ddl);
  }

  let totalMessages = 0;

  db.exec('BEGIN TRANSACTION');
  try {
    const insertConv = db.prepare(`
      INSERT INTO conversations (name, date, snippet, unread_events_count, conversation_type)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertPart = db.prepare(`
      INSERT INTO participants (conversation_id, participant_type, active)
      VALUES (?, ?, ?)
    `);

    const insertPartInfo = db.prepare(`
      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (?, ?, ?, ?)
    `);

    const insertMsg = db.prepare(`
      INSERT INTO messages (conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime, media_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const session of sessions) {
      validateChatSession(session);

      const convType = session.type === CONVERSATION_TYPES.GROUP ? 1 : 0;
      const lastMsg = session.messages[session.messages.length - 1];
      const convDate = lastMsg ? lastMsg.timestampMs : Date.now();
      const snippet = lastMsg ? (lastMsg.text || '[Вложение]') : '';

      const convRes = insertConv.run(
        session.title || 'Чат',
        convDate,
        snippet,
        0,
        convType
      );
      const convId = Number(convRes.lastInsertRowid);

      // Маппинг участников
      const participantIdMap = new Map();
      for (const p of session.participants) {
        const partRes = insertPart.run(convId, p.isOwner ? 1 : 0, 1);
        const pRowId = Number(partRes.lastInsertRowid);
        insertPartInfo.run(pRowId, p.phoneNumber || '', p.displayName || '', p.displayName || '');
        participantIdMap.set(p.id, pRowId);
      }

      const defaultSenderId = participantIdMap.values().next().value || 1;

      // Вставка сообщений
      for (const m of session.messages) {
        const pId = participantIdMap.get(m.senderId) || defaultSenderId;
        const msgType = m.isIncoming ? 0 : 1;
        const extraMime = resolveExtraMime(m.type);
        const status = m.status === MESSAGE_STATUS.READ ? 2 : (m.status === MESSAGE_STATUS.DELIVERED ? 1 : 0);
        const unread = (m.isIncoming && m.status !== MESSAGE_STATUS.READ) ? 1 : 0;
        const mediaPath = m.attachment ? m.attachment.localPath : null;

        insertMsg.run(
          convId,
          pId,
          m.text || '',
          m.timestampMs,
          msgType,
          status,
          unread,
          extraMime,
          mediaPath
        );
        totalMessages++;
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    conversationsCount: sessions.length,
    messagesCount: totalMessages
  };
} finally {
  if (isOwnedDb) {
    try { db.close(); } catch (_) {}
  }
}
}

module.exports = {
  resolveMessageType,
  resolveExtraMime,
  importAndroidToUIM,
  exportUIMToAndroid
};
