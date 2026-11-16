/**
 * TimeEngine: Двусторонний конвертер временных шкал между Unix Epoch (Android/Desktop)
 * и Apple Cocoa CoreData Epoch (iOS).
 * 
 * Unix Epoch: отсчет в миллисекундах от 01.01.1970 00:00:00 UTC.
 * Apple Cocoa Epoch: отсчет в секундах от 01.01.2001 00:00:00 UTC.
 * Смещение: 978,307,200 секунд (31 год, включая 8 високосных дней).
 */

const APPLE_COCOA_OFFSET_SECONDS = 978307200;

/**
 * Преобразует Unix миллисекунды в секунды Apple Cocoa Epoch (с плавающей точкой)
 * @param {number} unixMs - время в мс от 1970 года
 * @returns {number} секунды от 2001 года
 */
function unixMsToAppleSec(unixMs) {
  if (typeof unixMs !== 'number' || !Number.isFinite(unixMs)) {
    throw new TypeError(`Invalid Unix timestamp: expected finite number, got ${typeof unixMs} (${unixMs})`);
  }
  return (unixMs / 1000) - APPLE_COCOA_OFFSET_SECONDS;
}

/**
 * Преобразует секунды Apple Cocoa Epoch в Unix миллисекунды (округление до целых мс)
 * @param {number} appleSec - секунды от 2001 года
 * @returns {number} время в мс от 1970 года
 */
function appleSecToUnixMs(appleSec) {
  if (typeof appleSec !== 'number' || !Number.isFinite(appleSec)) {
    throw new TypeError(`Invalid Apple Cocoa timestamp: expected finite number, got ${typeof appleSec} (${appleSec})`);
  }
  return Math.round((appleSec + APPLE_COCOA_OFFSET_SECONDS) * 1000);
}

/**
 * Форматирует таймстамп в ISO 8601 строку
 * @param {number} timestamp - таймстамп
 * @param {boolean} isApple - флаг, является ли исходный таймстамп яблочным (Cocoa)
 * @returns {string} ISO-строка (UTC)
 */
function toIsoString(timestamp, isApple = false) {
  const unixMs = isApple ? appleSecToUnixMs(timestamp) : timestamp;
  return new Date(unixMs).toISOString();
}

module.exports = {
  APPLE_COCOA_OFFSET_SECONDS,
  unixMsToAppleSec,
  appleSecToUnixMs,
  toIsoString
};
