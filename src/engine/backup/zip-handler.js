/**
 * ZipHandler: Чистая Node.js реализация упаковщика и распаковщика PKZIP архивов
 * без сторонних зависимостей.
 * 
 * Используется для:
 * 1. Формирования и распаковки официального Google Drive архива Viber: `viber_backup.zip`.
 * 2. Упаковки баз данных viber_messages, viber_data и каталога медиафайлов.
 * 3. Побайтовой валидации CRC32 при распаковке.
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Упаковывает массив файлов в буфер PKZIP
 * @param {Array<{ name: string, data: Buffer|string }>} files
 * @returns {Buffer}
 */
function packZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data || ''), 'utf8');
    const nameBuf = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    // 1. Local File Header (30 байт + имя)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // Сигнатура PK\x03\x04
    lh.writeUInt16LE(20, 4);         // Минимальная версия 2.0
    lh.writeUInt16LE(0, 6);          // Флаги
    lh.writeUInt16LE(8, 8);          // Метод 8 (Deflate)
    lh.writeUInt16LE(0, 10);         // Время
    lh.writeUInt16LE(0, 12);         // Дата
    lh.writeUInt32LE(crc, 14);       // CRC32
    lh.writeUInt32LE(compressed.length, 18); // Сжатый размер
    lh.writeUInt32LE(data.length, 22);       // Исходный размер
    lh.writeUInt16LE(nameBuf.length, 26);    // Длина имени
    lh.writeUInt16LE(0, 28);                 // Extra field
    nameBuf.copy(lh, 30);

    // 2. Central Directory Header (46 байт + имя)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // Сигнатура PK\x01\x02
    ch.writeUInt16LE(20, 4);         // Версия создателя
    ch.writeUInt16LE(20, 6);         // Минимальная версия
    ch.writeUInt16LE(0, 8);          // Флаги
    ch.writeUInt16LE(8, 10);         // Метод сжатия (Deflate)
    ch.writeUInt16LE(0, 12);         // Время
    ch.writeUInt16LE(0, 14);         // Дата
    ch.writeUInt32LE(crc, 16);       // CRC32
    ch.writeUInt32LE(compressed.length, 20); // Сжатый размер
    ch.writeUInt32LE(data.length, 24);       // Исходный размер
    ch.writeUInt16LE(nameBuf.length, 28);    // Длина имени
    ch.writeUInt16LE(0, 30);         // Extra length
    ch.writeUInt16LE(0, 32);         // Длина комментария
    ch.writeUInt16LE(0, 34);         // Номер диска
    ch.writeUInt16LE(0, 36);         // Внутренние атрибуты
    ch.writeUInt32LE(0, 38);         // Внешние атрибуты
    ch.writeUInt32LE(offset, 42);    // Смещение Local Header
    nameBuf.copy(ch, 46);

    localHeaders.push(lh, compressed);
    centralHeaders.push(ch);
    offset += lh.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  
  // 3. End of Central Directory Record (22 байта)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // Сигнатура PK\x05\x06
  eocd.writeUInt16LE(0, 4);                // Номер диска
  eocd.writeUInt16LE(0, 6);                // Номер диска с Central Directory
  eocd.writeUInt16LE(files.length, 8);     // Количество записей на диске
  eocd.writeUInt16LE(files.length, 10);    // Всего записей в каталоге
  eocd.writeUInt32LE(centralDir.length, 12);// Размер Central Directory
  eocd.writeUInt32LE(offset, 16);          // Смещение Central Directory
  eocd.writeUInt16LE(0, 20);               // Длина комментария

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

/**
 * Распаковывает буфер PKZIP и проверяет контрольные суммы CRC32
 * @param {Buffer} zipBuf 
 * @returns {Array<{ name: string, data: Buffer }>}
 */
function unpackZip(zipBuf) {
  if (!Buffer.isBuffer(zipBuf)) {
    throw new TypeError('Expected Buffer as zip source');
  }

  // Ищем сигнатуру EOCD с конца буфера
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid zip: End of Central Directory record not found');
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  let cur = cdOffset;
  const entries = [];

  for (let i = 0; i < totalEntries; i++) {
    if (zipBuf.readUInt32LE(cur) !== 0x02014b50) {
      throw new Error(`Corrupted Central Directory at entry ${i}`);
    }

    const compMethod = zipBuf.readUInt16LE(cur + 10);
    const expectedCrc = zipBuf.readUInt32LE(cur + 16);
    const compSize = zipBuf.readUInt32LE(cur + 20);
    const nameLen = zipBuf.readUInt16LE(cur + 28);
    const extraLen = zipBuf.readUInt16LE(cur + 30);
    const commentLen = zipBuf.readUInt16LE(cur + 32);
    const localOffset = zipBuf.readUInt32LE(cur + 42);

    const name = zipBuf.toString('utf8', cur + 46, cur + 46 + nameLen);

    // Считываем Local Header для точного смещения данных
    const localNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawCompressed = zipBuf.subarray(dataStart, dataStart + compSize);

    let data;
    if (compMethod === 8) {
      data = zlib.inflateRawSync(rawCompressed);
    } else if (compMethod === 0) {
      data = Buffer.from(rawCompressed);
    } else {
      throw new Error(`Unsupported compression method: ${compMethod} in ${name}`);
    }

    if (zlib.crc32(data) !== expectedCrc) {
      throw new Error(`CRC32 integrity mismatch for ${name}`);
    }

    entries.push({ name, data });
    cur += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Создает официальный архив viber_backup.zip для Google Drive
 */
function packViberBackupZip({ viberDataDb, viberMessagesDb, mediaFiles = [] }) {
  const files = [
    { name: 'viber_data', data: viberDataDb },
    { name: 'viber_messages', data: viberMessagesDb }
  ];

  for (const m of mediaFiles) {
    files.push({
      name: `media/${m.filename}`,
      data: m.data
    });
  }

  return packZip(files);
}

module.exports = {
  packZip,
  unpackZip,
  packViberBackupZip
};
