/**
 * ManifestBuilder: Управление и генерация таблицы Files в iOS Manifest.db (iTunes Backup).
 * 
 * Отвечает за:
 * 1. Расчет SHA-1 fileID: SHA-1(domain + "-" + relativePath).
 * 2. Генерацию бинарного дескриптора метаданных (bplist00) с POSIX-правами, размером и таймстампами.
 * 3. Вставку и обновление записей в таблице Files Manifest.db с защитой от сбоев.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { computeManifestFileId, getBackupHashedPath } = require('../foundation/hash-service');

/**
 * Генерирует бинарный Plist (bplist00) для метаданных файла бэкапа
 * @param {object} dict - словарь свойств (Size, InodeNumber, Mode, etc.)
 * @returns {Buffer} бинарный буфер bplist00
 */
function encodeBinaryPlist(dict) {
  const header = Buffer.from('bplist00', 'ascii');
  const keys = Object.keys(dict);
  const values = Object.values(dict);
  const objects = [];
  const dictCount = keys.length;

  // 1. Кодируем ключи (строки)
  for (const k of keys) {
    const kBuf = Buffer.from(k, 'utf8');
    objects.push(Buffer.concat([Buffer.from([0x50 | kBuf.length]), kBuf]));
  }

  // 2. Кодируем значения (числа и строки)
  for (const v of values) {
    if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        const intBuf = Buffer.alloc(9);
        intBuf[0] = 0x13; // 8-byte integer
        intBuf.writeBigInt64BE(BigInt(v), 1);
        objects.push(intBuf);
      } else {
        const fBuf = Buffer.alloc(9);
        fBuf[0] = 0x23; // 8-byte double
        fBuf.writeDoubleBE(v, 1);
        objects.push(fBuf);
      }
    } else {
      const sBuf = Buffer.from(String(v), 'utf8');
      objects.push(Buffer.concat([Buffer.from([0x50 | sBuf.length]), sBuf]));
    }
  }

  // 3. Кодируем корневой словарь (0xD0 | count)
  const dictBuf = Buffer.alloc(1 + dictCount * 2);
  dictBuf[0] = 0xD0 | dictCount;
  for (let i = 0; i < dictCount; i++) {
    dictBuf[1 + i] = i + 1; // Ссылки на ключи
    dictBuf[1 + dictCount + i] = 1 + dictCount + i; // Ссылки на значения
  }

  const allObjects = [dictBuf, ...objects];
  const offsetTable = [];
  let currentOffset = header.length;

  for (const obj of allObjects) {
    offsetTable.push(currentOffset);
    currentOffset += obj.length;
  }

  const offsetTableStart = currentOffset;
  const offsetTableBuf = Buffer.alloc(allObjects.length);
  for (let i = 0; i < allObjects.length; i++) {
    offsetTableBuf[i] = offsetTable[i];
  }

  // 4. Trailer (32 байта)
  const trailer = Buffer.alloc(32);
  trailer[6] = 0;
  trailer[7] = 1; // offset size
  trailer[8] = 1; // ref size
  trailer.writeBigUInt64BE(BigInt(allObjects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableStart), 24);

  return Buffer.concat([header, ...allObjects, offsetTableBuf, trailer]);
}

/**
 * Инициализирует или открывает Manifest.db
 */
function openManifestDatabase(dbOrPath, ddlSql = null) {
  const db = (typeof dbOrPath === 'string') ? new DatabaseSync(dbOrPath) : dbOrPath;
  if (ddlSql) {
    db.exec(ddlSql);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Files (
        fileID TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        relativePath TEXT NOT NULL,
        flags INTEGER DEFAULT 1,
        file BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_files_domain_path ON Files (domain, relativePath);
    `);
  }
  return db;
}

/**
 * Генерирует дескриптор файла для Manifest.db
 */
function createManifestFileDescriptor({
  domain,
  relativePath,
  fileSize = 0,
  mtimeAppleSec = 0,
  mode = 33188, // 0o100644 (стандартный файл)
  inode = 1,
  flags = 1
}) {
  const fileId = computeManifestFileId(domain, relativePath);
  const pathInfo = getBackupHashedPath(fileId);

  const metadataDict = {
    Size: fileSize,
    LastModified: mtimeAppleSec,
    Mode: mode,
    InodeNumber: inode,
    ProtectionClass: 3
  };

  const fileBlob = encodeBinaryPlist(metadataDict);

  return {
    fileID: fileId,
    domain,
    relativePath,
    flags,
    fileBlob,
    folder: pathInfo.folder,
    filename: pathInfo.filename,
    fullRelative: pathInfo.fullRelative
  };
}

/**
 * Добавляет или обновляет запись файла в Manifest.db
 */
function upsertManifestRecord(db, descriptor) {
  const stmt = db.prepare(`
    INSERT INTO Files (fileID, domain, relativePath, flags, file)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(fileID) DO UPDATE SET
      domain = excluded.domain,
      relativePath = excluded.relativePath,
      flags = excluded.flags,
      file = excluded.file
  `);

  stmt.run(
    descriptor.fileID,
    descriptor.domain,
    descriptor.relativePath,
    descriptor.flags,
    descriptor.fileBlob
  );

  return descriptor;
}

/**
 * Получает запись файла из Manifest.db
 */
function queryManifestRecord(db, domain, relativePath) {
  const fileId = computeManifestFileId(domain, relativePath);
  const row = db.prepare('SELECT fileID, domain, relativePath, flags, file FROM Files WHERE fileID = ?').get(fileId);
  return row || null;
}

/**
 * Возвращает список всех файлов для указанного домена (например, AppDomainGroup-group.viber)
 */
function listDomainRecords(db, domain) {
  return db.prepare('SELECT fileID, domain, relativePath, flags FROM Files WHERE domain = ?').all(domain);
}

module.exports = {
  encodeBinaryPlist,
  openManifestDatabase,
  createManifestFileDescriptor,
  upsertManifestRecord,
  queryManifestRecord,
  listDomainRecords
};
