/**
 * HashService: Криптографические сервисы для резервного копирования и медиа-пайплайна.
 * 
 * 1. SHA-1 расчет идентификатора файла в iOS Manifest.db:
 *    fileID = SHA-1(domain + "-" + relativePath)
 * 2. SHA-256 контентно-адресуемое хранилище (CAS) для медиафайлов.
 * 3. Дедупликационный фингерпринт сообщений.
 */

const crypto = require('node:crypto');

/**
 * Рассчитывает 40-символьный hex SHA-1 fileID для iOS Manifest.db
 * @param {string} domain - например: "AppDomainGroup-group.viber"
 * @param {string} relativePath - например: "database/Chat.data"
 * @returns {string} 40-значный hex хеш
 */
function computeManifestFileId(domain, relativePath) {
  if (!domain || typeof domain !== 'string') {
    throw new TypeError(`Invalid domain: expected non-empty string, got ${domain}`);
  }
  if (!relativePath || typeof relativePath !== 'string') {
    throw new TypeError(`Invalid relativePath: expected non-empty string, got ${relativePath}`);
  }
  const rawKey = `${domain}-${relativePath}`;
  return crypto.createHash('sha1').update(rawKey, 'utf8').digest('hex');
}

/**
 * Возвращает путь файла внутри каталога бэкапа iTunes (2-символьная подпапка + хеш)
 * @param {string} fileId - 40-значный SHA-1 хеш
 * @returns {{ folder: string, filename: string, fullRelative: string }}
 */
function getBackupHashedPath(fileId) {
  if (!fileId || typeof fileId !== 'string' || fileId.length !== 40) {
    throw new Error(`Invalid fileId: expected 40-char hex string, got "${fileId}"`);
  }
  const folder = fileId.slice(0, 2);
  return {
    folder,
    filename: fileId,
    fullRelative: `${folder}/${fileId}`
  };
}

/**
 * Рассчитывает SHA-256 хеш содержимого буфера или строки
 * @param {Buffer|string} content 
 * @returns {string} 64-значный hex хеш
 */
function computeContentHash(content) {
  if (content === undefined || content === null) {
    throw new TypeError('Content cannot be null or undefined');
  }
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Генерирует дедупликационный отпечаток сообщения для проверки повторов
 * @param {string} senderId - идентификатор автора
 * @param {number} timestampMs - время в мс
 * @param {string} text - текст сообщения
 * @returns {string} 32-значный hex MD5 фингерпринт
 */
function computeMessageFingerprint(senderId, timestampMs, text = '') {
  const normalizedText = (text || '').trim();
  const raw = `${senderId}|${timestampMs}|${normalizedText}`;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

module.exports = {
  computeManifestFileId,
  getBackupHashedPath,
  computeContentHash,
  computeMessageFingerprint
};
