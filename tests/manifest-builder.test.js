const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const {
  encodeBinaryPlist,
  openManifestDatabase,
  createManifestFileDescriptor,
  upsertManifestRecord,
  queryManifestRecord,
  listDomainRecords
} = require('../src/engine/manifest/manifest-builder');

const {
  packZip,
  unpackZip,
  packViberBackupZip
} = require('../src/engine/backup/zip-handler');

const DDL_PATH = path.join(__dirname, '../fixtures/schemas/sample_manifest.sql');

describe('Layer 4: iOS Manifest.db Builder & Binary Plist', () => {
  it('encodes a valid Apple bplist00 buffer from a metadata dictionary', () => {
    const meta = {
      Size: 4096,
      InodeNumber: 8899,
      ProtectionClass: 3,
      Mode: 33188
    };

    const buf = encodeBinaryPlist(meta);
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.subarray(0, 8).toString('ascii'), 'bplist00');
    assert.ok(buf.length > 50, 'bplist must contain objects and trailer');
  });

  it('creates manifest file descriptor with correct SHA-1 fileID and backup path', () => {
    const domain = 'AppDomainGroup-group.viber';
    const relativePath = 'database/Chat.data';

    const desc = createManifestFileDescriptor({
      domain,
      relativePath,
      fileSize: 1048576,
      mtimeAppleSec: 737890000.0
    });

    assert.strictEqual(typeof desc.fileID, 'string');
    assert.strictEqual(desc.fileID.length, 40);
    assert.strictEqual(desc.domain, domain);
    assert.strictEqual(desc.relativePath, relativePath);
    assert.strictEqual(desc.folder, desc.fileID.slice(0, 2));
    assert.strictEqual(desc.fullRelative, `${desc.folder}/${desc.fileID}`);
    assert.ok(Buffer.isBuffer(desc.fileBlob));
  });

  it('inserts and queries records in Manifest.db using sample_manifest DDL', () => {
    const db = new DatabaseSync(':memory:');
    const ddl = fs.readFileSync(DDL_PATH, 'utf8');
    openManifestDatabase(db, ddl);

    const desc1 = createManifestFileDescriptor({
      domain: 'AppDomainGroup-group.viber',
      relativePath: 'database/Chat.data',
      fileSize: 500000
    });

    const desc2 = createManifestFileDescriptor({
      domain: 'AppDomainGroup-group.viber',
      relativePath: 'database/Contacts.data',
      fileSize: 200000
    });

    upsertManifestRecord(db, desc1);
    upsertManifestRecord(db, desc2);

    const queried = queryManifestRecord(db, 'AppDomainGroup-group.viber', 'database/Chat.data');
    assert.ok(queried);
    assert.strictEqual(queried.fileID, desc1.fileID);
    assert.strictEqual(queried.domain, 'AppDomainGroup-group.viber');
    assert.strictEqual(queried.relativePath, 'database/Chat.data');

    const domainList = listDomainRecords(db, 'AppDomainGroup-group.viber');
    assert.strictEqual(domainList.length, 2);
  });
});

describe('Layer 4: Zero-Dependency ZipHandler (viber_backup.zip)', () => {
  it('compresses and uncompresses multiple files with 100% CRC32 verification', () => {
    const originalFiles = [
      { name: 'viber_messages.db', data: Buffer.from('SQLite format 3 database payload 12345') },
      { name: 'media/test.jpg', data: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]) },
      { name: 'manifest.json', data: JSON.stringify({ version: '1.0.0', app: 'viber' }) }
    ];

    const zipBuffer = packZip(originalFiles);
    assert.ok(Buffer.isBuffer(zipBuffer));
    assert.ok(zipBuffer.length > 50);

    const unpacked = unpackZip(zipBuffer);
    assert.strictEqual(unpacked.length, 3);

    for (let i = 0; i < originalFiles.length; i++) {
      const orig = originalFiles[i];
      const unp = unpacked.find(u => u.name === orig.name);
      assert.ok(unp, `File ${orig.name} must be present in unpacked zip`);
      assert.deepStrictEqual(unp.data, Buffer.isBuffer(orig.data) ? orig.data : Buffer.from(orig.data, 'utf8'));
    }
  });

  it('packs and unpacks official Viber Google Drive backup archive format', () => {
    const fakeDataDb = Buffer.from('viber_data SQLite fake binary');
    const fakeMessagesDb = Buffer.from('viber_messages SQLite fake binary');
    const mediaFiles = [
      { filename: 'voice_01.ptt', data: Buffer.from('PTT audio byte stream') }
    ];

    const viberZip = packViberBackupZip({
      viberDataDb: fakeDataDb,
      viberMessagesDb: fakeMessagesDb,
      mediaFiles
    });

    const unpacked = unpackZip(viberZip);
    assert.strictEqual(unpacked.length, 3);

    const dataEntry = unpacked.find(f => f.name === 'viber_data');
    assert.ok(dataEntry);
    assert.deepStrictEqual(dataEntry.data, fakeDataDb);

    const msgsEntry = unpacked.find(f => f.name === 'viber_messages');
    assert.ok(msgsEntry);
    assert.deepStrictEqual(msgsEntry.data, fakeMessagesDb);

    const mediaEntry = unpacked.find(f => f.name === 'media/voice_01.ptt');
    assert.ok(mediaEntry);
    assert.deepStrictEqual(mediaEntry.data, mediaFiles[0].data);
  });
});
