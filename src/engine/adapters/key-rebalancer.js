/**
 * KeyRebalancer: Модуль сдвига и переиндексации первичных и внешних ключей CoreData.
 * 
 * Предотвращает фатальные сбои `UNIQUE constraint failed: Z_PK` при инъекции
 * данных в существующую базу данных целевого iPhone.
 */

/**
 * Сканирует целевую базу данных и определяет максимальные занятые первичные ключи
 * @param {DatabaseSync} db - открытый экземпляр SQLite целевой базы
 * @returns {{ convOffset: number, partOffset: number, msgOffset: number }}
 */
function inspectKeyOffsets(db) {
  let convOffset = 0;
  let partOffset = 0;
  let msgOffset = 0;

  try {
    const convRow = db.prepare('SELECT COALESCE(MAX(Z_PK), 0) AS maxVal FROM ZCONVERSATION').get();
    if (convRow && typeof convRow.maxVal === 'number') convOffset = convRow.maxVal;
  } catch (_) {}

  try {
    const partRow = db.prepare('SELECT COALESCE(MAX(Z_PK), 0) AS maxVal FROM ZPARTICIPANT').get();
    if (partRow && typeof partRow.maxVal === 'number') partOffset = partRow.maxVal;
  } catch (_) {}

  try {
    const msgRow = db.prepare('SELECT COALESCE(MAX(Z_PK), 0) AS maxVal FROM ZMESSAGE').get();
    if (msgRow && typeof msgRow.maxVal === 'number') msgOffset = msgRow.maxVal;
  } catch (_) {}

  return { convOffset, partOffset, msgOffset };
}

/**
 * Вычисляет сбалансированные ID для новой сущности со сдвигом
 * @param {number} localIndex - локальный порядковый номер в батче (начиная с 1)
 * @param {number} baseOffset - базовый сдвиг существующей базы
 * @returns {number} новый бесконфликтный Z_PK
 */
function getRebalancedKey(localIndex, baseOffset = 0) {
  return baseOffset + localIndex;
}

module.exports = {
  inspectKeyOffsets,
  getRebalancedKey
};
