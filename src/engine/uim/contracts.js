/**
 * UIM Contracts: Канонические контракты промежуточной модели данных (Unified Intermediate Model).
 * Изолирует особенности хранения Android SQLite от iOS CoreData SQLite.
 */

const CONVERSATION_TYPES = Object.freeze({
  DIRECT: 'direct',        // 1-на-1 диалог
  GROUP: 'group',          // Групповой чат
  BOT: 'bot',              // Чат-бот
  COMMUNITY: 'community'   // Сообщество/канал
});

const MESSAGE_TYPES = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  VOICE: 'voice',          // PTT голосовое сообщение
  STICKER: 'sticker',
  FILE: 'file',
  LOCATION: 'location',
  SYSTEM: 'system'
});

const MESSAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read'
});

/**
 * Фабрика участника чата
 */
function createParticipant({ id, phoneNumber = '', displayName = '', isOwner = false }) {
  return {
    id: String(id),
    phoneNumber: String(phoneNumber || '').trim(),
    displayName: String(displayName || '').trim() || 'Viber User',
    isOwner: Boolean(isOwner)
  };
}

/**
 * Фабрика сообщения
 */
function createMessage({
  id,
  senderId,
  timestampMs,
  text = '',
  type = MESSAGE_TYPES.TEXT,
  status = MESSAGE_STATUS.READ,
  isIncoming = false,
  attachment = null,
  reactions = []
}) {
  return {
    id: String(id),
    senderId: String(senderId),
    timestampMs: Number(timestampMs),
    text: String(text || ''),
    type,
    status,
    isIncoming: Boolean(isIncoming),
    attachment: attachment ? {
      filename: String(attachment.filename || ''),
      localPath: String(attachment.localPath || ''),
      mimeType: String(attachment.mimeType || 'application/octet-stream'),
      fileSize: Number(attachment.fileSize || 0),
      durationSec: Number(attachment.durationSec || 0),
      contentHash: attachment.contentHash ? String(attachment.contentHash) : null
    } : null,
    reactions: Array.isArray(reactions) ? reactions.map(r => ({
      userId: String(r.userId),
      emoji: String(r.emoji)
    })) : []
  };
}

/**
 * Фабрика сессии диалога
 */
function createChatSession({
  id,
  originalId,
  type = CONVERSATION_TYPES.DIRECT,
  title = '',
  iconUri = null,
  participants = [],
  messages = []
}) {
  return {
    id: String(id),
    originalId: String(originalId || id),
    type,
    title: String(title || ''),
    iconUri: iconUri ? String(iconUri) : null,
    participants: participants.map(createParticipant),
    messages: messages.map(createMessage)
  };
}

module.exports = {
  CONVERSATION_TYPES,
  MESSAGE_TYPES,
  MESSAGE_STATUS,
  createParticipant,
  createMessage,
  createChatSession
};
