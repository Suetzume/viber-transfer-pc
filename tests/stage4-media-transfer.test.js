/**
 * Stage 4 Test Suite: Пакетный перенос медиавложений (Media CAS & Attachments Injection)
 * 
 * Проверяет:
 * 1. Контентно-адресуемое хеширование (CAS SHA-256) и нормализацию имен файлов.
 * 2. Физическую инжекцию медиафайлов (фото, видео, голосовые PTT) в каталог резервной копии iTunes.
 * 3. Регистрацию дескрипторов файлов в Manifest.db (AppDomainGroup-group.viber / Attachments).
 * 4. Сквозную миграцию из zip-архива Google Drive с медиавложениями в iTunes бэкап.
 * 5. Обратный пайплайн (iOS бэкап -> Android zip с каталогом media/).
 * 6. Побайтовую целостность (Bitwise Fidelity) с нулевой потерей данных (Zero Data Loss).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const { computeManifestFileId, getBackupHashedPath, computeContentHash } = require('../src/engine/foundation/hash-service');
const { openManifestDatabase, queryManifestRecord } = require('../src/engine/manifest/manifest-builder');
const { packZip, unpackZip, packViberBackupZip } = require('../src/engine/backup/zip-handler');
const {
  VIBER_IOS_MEDIA_DOMAIN,
  VIBER_IOS_ATTACHMENT_PREFIX,
  normalizeMediaFilename,
  injectMediaToIOSBackup,
  extractMediaFromIOSBackup
} = require('../src/engine/pipeline/media-pipeline');
const { migrateAndroidToIOS, migrateIOSToAndroid } = require('../src/engine/pipeline/migration-engine');
const { createChatSession, createParticipant, createMessage, MESSAGE_TYPES } = require('../src/engine/uim/contracts');

function getFixture(filename) {
  const p = path.resolve(__dirname, '../fixtures/schemas', filename);
  return fs.readFileSync(p, 'utf8');
}

describe('Stage 4: Media CAS Pipeline & Attachments Injection into iOS Manifest.db', () => {

  it('нормализует имена медиафайлов из путей Windows и POSIX', () => {
    assert.equal(normalizeMediaFilename('C:\\Users\\User\\Pictures\\photo_01.jpg'), 'photo_01.jpg');
    assert.equal(normalizeMediaFilename('/sdcard/viber/media/voice_rec.ptt'), 'voice_rec.ptt');
    assert.equal(normalizeMediaFilename('viber_video_2026.mp4'), 'viber_video_2026.mp4');
    assert.equal(normalizeMediaFilename(''), '');
  });

  it('вычисляет детерминированный SHA-256 CAS хеш для бинарных данных', () => {
    const fakeImage = Buffer.from('FAKE_JPEG_IMAGE_HEADER_EXIF_DATA_2026');
    const hash1 = computeContentHash(fakeImage);
    const hash2 = computeContentHash(fakeImage);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  it('инжектирует медиафайлы в каталог iTunes бэкапа и регистрирует их в Manifest.db', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage4-test-'));
    const manifestPath = path.join(tempDir, 'Manifest.db');
    const manifestDb = openManifestDatabase(manifestPath);

    const fakeJpg = Buffer.from('SOI_APP1_EXIF_JPEG_BYTES_12345');
    const fakeVoice = Buffer.from('OPUS_OGG_VOICE_NOTE_BYTES_67890');

    const session = createChatSession({
      id: '1',
      title: 'Диалог с медиа',
      participants: [createParticipant({ id: '1', displayName: 'Алиса', isOwner: false })],
      messages: [
        createMessage({
          id: '101',
          senderId: '1',
          timestampMs: 1700000000000,
          text: 'Смотри фото',
          type: MESSAGE_TYPES.IMAGE,
          attachment: {
            filename: 'alice_pic.jpg',
            localPath: 'alice_pic.jpg'
          }
        }),
        createMessage({
          id: '102',
          senderId: '1',
          timestampMs: 1700000010000,
          text: 'Голосовое',
          type: MESSAGE_TYPES.VOICE,
          attachment: {
            filename: 'alice_voice.ptt',
            localPath: 'alice_voice.ptt'
          }
        })
      ]
    });

    const mediaSources = {
      'alice_pic.jpg': fakeJpg,
      'alice_voice.ptt': fakeVoice
    };

    const res = injectMediaToIOSBackup({
      sessions: [session],
      mediaSources,
      targetBackupDir: tempDir,
      manifestDb
    });

    assert.equal(res.mediaCount, 2);
    assert.equal(res.totalBytes, fakeJpg.length + fakeVoice.length);
    assert.equal(res.errors.length, 0);

    // Проверяем, что пути сообщений в UIM нормализованы для iOS
    assert.equal(session.messages[0].attachment.localPath, 'Attachments/alice_pic.jpg');
    assert.equal(session.messages[0].attachment.fileSize, fakeJpg.length);
    assert.equal(session.messages[0].attachment.contentHash, computeContentHash(fakeJpg));

    assert.equal(session.messages[1].attachment.localPath, 'Attachments/alice_voice.ptt');
    assert.equal(session.messages[1].attachment.fileSize, fakeVoice.length);

    // Проверяем наличие записей в Manifest.db
    const rec1 = queryManifestRecord(manifestDb, VIBER_IOS_MEDIA_DOMAIN, 'Attachments/alice_pic.jpg');
    assert.ok(rec1, 'Запись alice_pic.jpg должна быть в Manifest.db');
    assert.equal(rec1.domain, VIBER_IOS_MEDIA_DOMAIN);
    assert.equal(rec1.relativePath, 'Attachments/alice_pic.jpg');

    const rec2 = queryManifestRecord(manifestDb, VIBER_IOS_MEDIA_DOMAIN, 'Attachments/alice_voice.ptt');
    assert.ok(rec2, 'Запись alice_voice.ptt должна быть в Manifest.db');

    // Проверяем физическое наличие файлов на диске бэкапа (2-char subfolder + SHA-1)
    const fileId1 = computeManifestFileId(VIBER_IOS_MEDIA_DOMAIN, 'Attachments/alice_pic.jpg');
    const pathInfo1 = getBackupHashedPath(fileId1);
    const diskPath1 = path.join(tempDir, pathInfo1.folder, pathInfo1.filename);
    assert.ok(fs.existsSync(diskPath1), `Файл ${diskPath1} должен физически существовать`);

    const readBackBytes = fs.readFileSync(diskPath1);
    assert.deepEqual(readBackBytes, fakeJpg, 'Побайтовая идентичность медиафайла (Zero Data Loss)');

    manifestDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('сквозная миграция: распаковывает медиа из Google Drive zip и инжектирует в iTunes бэкап', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-e2e-media-'));
    const targetBackupDir = path.join(tempDir, 'iTunesBackup');
    fs.mkdirSync(targetBackupDir, { recursive: true });

    const manifestPath = path.join(targetBackupDir, 'Manifest.db');
    const manifestDb = openManifestDatabase(manifestPath);

    // Создаем синтетическую базу Android с вложением
    const androidDbPath = path.join(tempDir, 'viber_messages.db');
    const aDb = new DatabaseSync(androidDbPath);
    aDb.exec(getFixture('android_viber_messages.sql'));
    aDb.exec(`
      INSERT INTO conversations (_id, name, date, snippet, unread_events_count, conversation_type)
      VALUES (1, 'Чат с фото', 1700000000000, 'Фотография', 0, 0);
      INSERT INTO participants (_id, conversation_id, participant_type)
      VALUES (1, 1, 0);
      INSERT INTO participants_info (_id, number, display_name, viber_name)
      VALUES (1, '+380501112233', 'Елена', 'Elena');
      INSERT INTO messages (_id, conversation_id, participant_id, msg_date, body, type, extra_mime, status, unread, media_path)
      VALUES (1, 1, 1, 1700000000000, 'Смотри закат', 0, 1, 1, 0, '/sdcard/viber/media/sunset.jpg');
    `);
    aDb.close();

    const sunsetBytes = Buffer.from('JPEG_SUNSET_IMAGE_STREAM_TEST_9999');

    // Формируем архив Google Drive viber_backup.zip
    const aDbBuffer = fs.readFileSync(androidDbPath);
    const zipBuffer = packViberBackupZip({
      viberDataDb: aDbBuffer,
      viberMessagesDb: aDbBuffer,
      mediaFiles: [
        { filename: 'sunset.jpg', data: sunsetBytes }
      ]
    });

    const zipPath = path.join(tempDir, 'viber_backup.zip');
    fs.writeFileSync(zipPath, zipBuffer);

    // Распаковываем zip как в bridge-server
    const entries = unpackZip(fs.readFileSync(zipPath));
    const msgEntry = entries.find(e => e.name.includes('viber_messages'));
    const mediaSources = new Map();
    for (const ent of entries) {
      if (ent.name !== msgEntry.name && !ent.name.includes('viber_data')) {
        mediaSources.set(path.basename(ent.name), ent.data);
      }
    }

    const unzippedDbPath = path.join(tempDir, 'extracted_messages.db');
    fs.writeFileSync(unzippedDbPath, msgEntry.data);

    // Путь для Chat.data в бэкапе
    const chatFileId = computeManifestFileId('AppDomainGroup-group.viber', 'database/Chat.data');
    const chatSubDir = path.join(targetBackupDir, chatFileId.slice(0, 2));
    fs.mkdirSync(chatSubDir, { recursive: true });
    const targetIosDb = path.join(chatSubDir, chatFileId);

    const report = migrateAndroidToIOS({
      androidDb: unzippedDbPath,
      targetIosDb,
      manifestDb,
      targetBackupDir,
      mediaSources,
      iosDdlPath: getFixture('ios_viber_chat.sql')
    });

    assert.equal(report.success, true);
    assert.equal(report.chatsCount, 1);
    assert.equal(report.messagesCount, 1);
    assert.equal(report.mediaCount, 1);
    assert.equal(report.mediaBytesTransferred, sunsetBytes.length);

    // Проверяем запись в iOS базе Chat.data
    const iosDb = new DatabaseSync(targetIosDb);
    const msgRow = iosDb.prepare('SELECT ZATTACHMENTPATH, ZMEDIAFILESIZE FROM ZMESSAGE WHERE Z_PK = 1').get();
    assert.equal(msgRow.ZATTACHMENTPATH, 'Attachments/sunset.jpg');
    assert.equal(msgRow.ZMEDIAFILESIZE, sunsetBytes.length);
    iosDb.close();

    // Проверяем физический файл в iTunes бэкапе
    const sunsetFileId = computeManifestFileId(VIBER_IOS_MEDIA_DOMAIN, 'Attachments/sunset.jpg');
    const sunsetPath = path.join(targetBackupDir, sunsetFileId.slice(0, 2), sunsetFileId);
    assert.ok(fs.existsSync(sunsetPath), 'Медиафайл должен быть физически записан в бэкап iTunes');
    assert.deepEqual(fs.readFileSync(sunsetPath), sunsetBytes);

    manifestDb.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (_) {}
  });

  it('реверс-миграция: извлекает медиа из бэкапа iTunes и пакует в viber_backup.zip', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-reverse-media-'));
    const backupDir = path.join(tempDir, 'iTunesBackup');
    fs.mkdirSync(backupDir, { recursive: true });

    // Создаем файл медиа в структуре бэкапа
    const docBytes = Buffer.from('PDF_CONTRACT_DOCUMENT_CONTENT_2026');
    const docRelativePath = 'Attachments/contract.pdf';
    const docFileId = computeManifestFileId(VIBER_IOS_MEDIA_DOMAIN, docRelativePath);
    const pathInfo = getBackupHashedPath(docFileId);
    const subDir = path.join(backupDir, pathInfo.folder);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, pathInfo.filename), docBytes);

    // Создаем iOS Chat.data с ссылкой на это вложение
    const iosDbPath = path.join(tempDir, 'Chat.data');
    const iosDb = new DatabaseSync(iosDbPath);
    iosDb.exec(getFixture('ios_viber_chat.sql'));
    iosDb.exec(`
      INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
      VALUES (1, 1, 1, 0, 736692800.0, 'Рабочий диалог', 0);
      INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
      VALUES (1, 2, 1, 1, '+380671112233', 'Бухгалтер', 0);
      INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING, ZATTACHMENTPATH, ZMEDIAFILESIZE)
      VALUES (1, 3, 1, 1, 1, 736692800.0, 'Договор во вложении', 0, 2, 1, 'Attachments/contract.pdf', ${docBytes.length});
    `);
    iosDb.close();

    const targetAndroidDb = path.join(tempDir, 'target_android.db');
    const outZip = path.join(tempDir, 'exported_viber_backup.zip');

    const report = migrateIOSToAndroid({
      iosDb: iosDbPath,
      targetAndroidDb,
      iosBackupDir: backupDir,
      androidDdlPath: getFixture('android_viber_messages.sql'),
      outputZipPath: outZip
    });

    assert.equal(report.success, true);
    assert.equal(report.chatsCount, 1);
    assert.equal(report.messagesCount, 1);
    assert.equal(report.mediaCount, 1);
    assert.ok(fs.existsSync(outZip), 'Архив viber_backup.zip должен быть создан');

    // Распаковываем созданный zip и проверяем наличие файла в media/
    const zipEntries = unpackZip(fs.readFileSync(outZip));
    const mediaEntry = zipEntries.find(e => e.name === 'media/contract.pdf');
    assert.ok(mediaEntry, 'В архиве должна присутствовать запись media/contract.pdf');
    assert.deepEqual(mediaEntry.data, docBytes, 'Побайтовая идентичность при реверс-миграции медиа');

    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (_) {}
  });

});
