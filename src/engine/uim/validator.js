/**
 * UIM Validator & Deduplicator: Проверка целостности и устранение дубликатов.
 * Гарантирует корректность данных перед трансляцией в базу целевой ОС.
 */

const { CONVERSATION_TYPES, MESSAGE_TYPES, MESSAGE_STATUS } = require('./contracts');
const { computeMessageFingerprint } = require('../foundation/hash-service');

class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Валидирует отдельного участника
 */
function validateParticipant(participant, path = 'participant') {
  const errors = [];
  if (!participant || typeof participant !== 'object') {
    return ['Invalid participant: expected object'];
  }
  if (!participant.id) errors.push(`${path}.id is required`);
  return errors;
}

/**
 * Валидирует отдельное сообщение
 */
function validateMessage(message, path = 'message') {
  const errors = [];
  if (!message || typeof message !== 'object') {
    return ['Invalid message: expected object'];
  }
  if (!message.id) errors.push(`${path}.id is required`);
  if (!message.senderId) errors.push(`${path}.senderId is required`);
  if (typeof message.timestampMs !== 'number' || !Number.isFinite(message.timestampMs) || message.timestampMs <= 0) {
    errors.push(`${path}.timestampMs must be a positive finite number`);
  }
  if (!Object.values(MESSAGE_TYPES).includes(message.type)) {
    errors.push(`${path}.type "${message.type}" is not a valid MESSAGE_TYPES`);
  }
  if (!Object.values(MESSAGE_STATUS).includes(message.status)) {
    errors.push(`${path}.status "${message.status}" is not a valid MESSAGE_STATUS`);
  }
  return errors;
}

/**
 * Валидирует полную сессию диалога
 */
function validateChatSession(session) {
  const errors = [];
  if (!session || typeof session !== 'object') {
    throw new ValidationError('Invalid session: expected object');
  }
  if (!session.id) errors.push('session.id is required');
  if (!Object.values(CONVERSATION_TYPES).includes(session.type)) {
    errors.push(`session.type "${session.type}" is not a valid CONVERSATION_TYPES`);
  }
  if (!Array.isArray(session.participants)) {
    errors.push('session.participants must be an array');
  } else {
    session.participants.forEach((p, idx) => {
      errors.push(...validateParticipant(p, `session.participants[${idx}]`));
    });
  }

  if (!Array.isArray(session.messages)) {
    errors.push('session.messages must be an array');
  } else {
    session.messages.forEach((m, idx) => {
      errors.push(...validateMessage(m, `session.messages[${idx}]`));
    });
  }

  if (errors.length > 0) {
    throw new ValidationError(`ChatSession validation failed with ${errors.length} error(s)`, errors);
  }
  return true;
}

/**
 * Выполняет дедупликацию сообщений внутри диалога
 * @param {Array<object>} messages - массив UIMMessage
 * @returns {{ deduplicated: Array<object>, removedCount: number }}
 */
function deduplicateMessages(messages) {
  if (!Array.isArray(messages)) return { deduplicated: [], removedCount: 0 };
  const seenFingerprints = new Set();
  const deduplicated = [];
  let removedCount = 0;

  for (const msg of messages) {
    const fp = computeMessageFingerprint(msg.senderId, msg.timestampMs, msg.text);
    if (seenFingerprints.has(fp)) {
      removedCount++;
    } else {
      seenFingerprints.add(fp);
      deduplicated.push(msg);
    }
  }

  return { deduplicated, removedCount };
}

module.exports = {
  ValidationError,
  validateParticipant,
  validateMessage,
  validateChatSession,
  deduplicateMessages
};
