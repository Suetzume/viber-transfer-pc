const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  APPLE_COCOA_OFFSET_SECONDS,
  unixMsToAppleSec,
  appleSecToUnixMs,
  toIsoString
} = require('../src/engine/foundation/time-engine');

const {
  computeManifestFileId,
  getBackupHashedPath,
  computeContentHash,
  computeMessageFingerprint
} = require('../src/engine/foundation/hash-service');

const {
  CONVERSATION_TYPES,
  MESSAGE_TYPES,
  MESSAGE_STATUS,
  createParticipant,
  createMessage,
  createChatSession
} = require('../src/engine/uim/contracts');

const {
  ValidationError,
  validateChatSession,
  deduplicateMessages
} = require('../src/engine/uim/validator');

describe('Layer 1: TimeEngine (Unix Epoch <-> Apple Cocoa Epoch)', () => {
  it('correctly maps 1970-01-01 (Unix Epoch start) to negative Cocoa seconds', () => {
    const unixZero = 0;
    const appleSec = unixMsToAppleSec(unixZero);
    assert.strictEqual(appleSec, -APPLE_COCOA_OFFSET_SECONDS);
    assert.strictEqual(appleSecToUnixMs(appleSec), 0);
  });

  it('correctly maps 2001-01-01 00:00:00 UTC (Apple Cocoa Epoch start) to 0.0', () => {
    const cocoaStartUnixMs = 978307200000;
    const appleSec = unixMsToAppleSec(cocoaStartUnixMs);
    assert.strictEqual(appleSec, 0);
    assert.strictEqual(appleSecToUnixMs(0), cocoaStartUnixMs);
  });

  it('guarantees bidirectional lossless conversion for real-world timestamps', () => {
    const samples = [
      Date.now(),
      1609459200000, // 2021-01-01
      1704067200000, // 2024-01-01
      1798761600000  // 2027-01-01
    ];

    for (const originalMs of samples) {
      const appleSec = unixMsToAppleSec(originalMs);
      const restoredMs = appleSecToUnixMs(appleSec);
      assert.strictEqual(restoredMs, originalMs, `Lossless roundtrip failed for ${originalMs}`);
    }
  });

  it('formats dates to ISO strings correctly', () => {
    const iso = toIsoString(978307200000);
    assert.strictEqual(iso, '2001-01-01T00:00:00.000Z');
  });

  it('rejects non-numeric timestamps with TypeError', () => {
    assert.throws(() => unixMsToAppleSec('invalid'), TypeError);
    assert.throws(() => appleSecToUnixMs(null), TypeError);
  });
});

describe('Layer 1: HashService (Manifest.db & Media CAS)', () => {
  it('computes correct SHA-1 for iOS Manifest.db path hashing', () => {
    const domain = 'AppDomainGroup-group.viber';
    const relativePath = 'database/Chat.data';
    const fileId = computeManifestFileId(domain, relativePath);

    assert.strictEqual(typeof fileId, 'string');
    assert.strictEqual(fileId.length, 40, 'SHA-1 must be 40-character hex string');

    // SHA-1 deterministic check
    const crypto = require('node:crypto');
    const expected = crypto.createHash('sha1').update(`${domain}-${relativePath}`).digest('hex');
    assert.strictEqual(fileId, expected);
  });

  it('generates correct iTunes 2-char subfolder path for fileId', () => {
    const mockFileId = 'a1b2c3d4e5f6789012345678901234567890abcd';
    const { folder, filename, fullRelative } = getBackupHashedPath(mockFileId);

    assert.strictEqual(folder, 'a1');
    assert.strictEqual(filename, mockFileId);
    assert.strictEqual(fullRelative, 'a1/' + mockFileId);
  });

  it('computes content-addressed storage (CAS) SHA-256 for media bytes', () => {
    const buf = Buffer.from('viber test image bytes');
    const hash = computeContentHash(buf);
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 64);
  });

  it('computes deterministic message fingerprints', () => {
    const fp1 = computeMessageFingerprint('user_123', 1700000000, 'Привет!');
    const fp2 = computeMessageFingerprint('user_123', 1700000000, ' Привет! ');
    const fpDiff = computeMessageFingerprint('user_123', 1700000001, 'Привет!');

    assert.strictEqual(fp1, fp2, 'Whitespace normalization should produce same fingerprint');
    assert.notStrictEqual(fp1, fpDiff, 'Different timestamp must produce different fingerprint');
  });
});

describe('Layer 2: UIM Contracts & Validator', () => {
  it('creates and validates a complete valid chat session', () => {
    const participant = createParticipant({
      id: 'p_1',
      phoneNumber: '+380501234567',
      displayName: 'Ольга',
      isOwner: false
    });

    const message = createMessage({
      id: 'msg_1',
      senderId: 'p_1',
      timestampMs: 1715000000000,
      text: 'Встречаемся в 15:00',
      type: MESSAGE_TYPES.TEXT,
      status: MESSAGE_STATUS.READ,
      isIncoming: true
    });

    const session = createChatSession({
      id: 'chat_1',
      type: CONVERSATION_TYPES.DIRECT,
      title: 'Ольга',
      participants: [participant],
      messages: [message]
    });

    assert.doesNotThrow(() => validateChatSession(session));
  });

  it('rejects invalid chat sessions with detailed ValidationError', () => {
    const invalidSession = {
      id: 'chat_bad',
      type: 'unknown_type',
      participants: [{ id: '' }],
      messages: [{ id: 'm1', senderId: '', timestampMs: -50, type: 'bad_type', status: 'bad_status' }]
    };

    assert.throws(
      () => validateChatSession(invalidSession),
      (err) => {
        assert(err instanceof ValidationError);
        assert(err.errors.length >= 4);
        return true;
      }
    );
  });

  it('deduplicates duplicate messages correctly', () => {
    const baseMsg = {
      id: 'm1',
      senderId: 'user_1',
      timestampMs: 1700000000,
      text: 'Привет!'
    };

    const duplicateMsg = {
      id: 'm2',
      senderId: 'user_1',
      timestampMs: 1700000000,
      text: 'Привет!'
    };

    const uniqueMsg = {
      id: 'm3',
      senderId: 'user_1',
      timestampMs: 1700000010,
      text: 'Как дела?'
    };

    const { deduplicated, removedCount } = deduplicateMessages([baseMsg, duplicateMsg, uniqueMsg]);

    assert.strictEqual(deduplicated.length, 2);
    assert.strictEqual(removedCount, 1);
    assert.strictEqual(deduplicated[0].id, 'm1');
    assert.strictEqual(deduplicated[1].id, 'm3');
  });
});
