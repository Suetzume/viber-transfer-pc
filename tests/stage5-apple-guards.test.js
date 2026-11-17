/**
 * Stage 5 Test Suite: Защита от ошибок Apple & Мастер восстановления на iPhone
 * 
 * Проверяет:
 * 1. Определение зашифрованного бэкапа iTunes (IsEncrypted: true в Manifest.plist).
 * 2. Защиту от Ошибки 14/54 в iTunes (блокировка миграции в зашифрованный бэкап с понятным объяснением).
 * 3. REST API /api/inspect-target (диагностика целевой папки бэкапа).
 * 4. REST API /api/open-folder (безопасное открытие целевой папки в Проводнике Windows).
 * 5. Контракт UI: наличие блока проверки бэкапа, кнопки открытия папки и пошагового мастера восстановления.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const { validateBackupForRestore } = require('../src/devices');
const { startServer } = require('../src/server/bridge-server');
const { openManifestDatabase } = require('../src/engine/manifest/manifest-builder');

const TEST_PORT = 34585;

function postJson(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body || '{}') });
        } catch (_) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Stage 5: Apple Restore Safeguards, Encryption Detection & Explorer Integration', () => {
  let serverInstance = null;

  before(async () => {
    serverInstance = await startServer(TEST_PORT);
  });

  after(() => {
    if (serverInstance && serverInstance.close) {
      serverInstance.close();
    }
  });

  it('UI Contract: index.html содержит валидатор целевого бэкапа, кнопку Проводника и инструкцию', () => {
    const htmlPath = path.join(__dirname, '../src/renderer/index.html');
    const content = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(content.includes('targetValidationBox'), 'Должен присутствовать блок targetValidationBox');
    assert.ok(content.includes('validateCurrentTargetBackup'), 'Должна присутствовать функция валидации бэкапа');
    assert.ok(content.includes('openBackupFolderBtn'), 'Кнопка открытия бэкапа в Проводнике');
    assert.ok(content.includes('openBackupFolder'), 'Функция вызова проводника openBackupFolder');
    assert.ok(content.includes('Локатор'), 'Инструкция должна содержать указание отключить Локатор');
    assert.ok(content.includes('Восстановить из копии'), 'Инструкция должна содержать указание на восстановление в iTunes');
  });

  it('validateBackupForRestore: корректно определяет незашифрованный бэкап и выдает Find My iPhone предупреждение', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage5-plain-'));
    const manifestPath = path.join(tempDir, 'Manifest.db');
    const mDb = openManifestDatabase(manifestPath);
    mDb.close();

    const manifestPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>IsEncrypted</key>
  <false/>
</dict>
</plist>`;
    fs.writeFileSync(path.join(tempDir, 'Manifest.plist'), manifestPlist, 'utf8');

    const res = validateBackupForRestore(tempDir);
    assert.equal(res.ok, true);
    assert.equal(res.details.isEncrypted, false);
    assert.ok(res.warnings.some(w => w.includes('Локатор')));

    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  });

  it('validateBackupForRestore: безошибочно выявляет зашифрованный бэкап (IsEncrypted: true)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage5-enc-'));
    const manifestPath = path.join(tempDir, 'Manifest.db');
    const mDb = openManifestDatabase(manifestPath);
    mDb.close();

    const manifestPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>IsEncrypted</key>
  <true/>
</dict>
</plist>`;
    fs.writeFileSync(path.join(tempDir, 'Manifest.plist'), manifestPlist, 'utf8');

    const res = validateBackupForRestore(tempDir);
    assert.equal(res.ok, false);
    assert.equal(res.details.isEncrypted, true);
    assert.ok(res.errors.some(e => e.includes('зашифрована паролем')));

    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  });

  it('/api/inspect-target: возвращает детальную диагностику и статус шифрования', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage5-api-'));
    const manifestPath = path.join(tempDir, 'Manifest.db');
    const mDb = openManifestDatabase(manifestPath);
    mDb.close();

    const resp = await postJson('/api/inspect-target', { targetPath: tempDir });
    assert.equal(resp.status, 200);
    assert.equal(resp.data.success, true);
    assert.equal(resp.data.isEncrypted, false);
    assert.equal(resp.data.valid, true);

    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  });

  it('/api/migrate: блокирует миграцию в зашифрованный бэкап с информативным кодом 400', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage5-blocked-'));
    const manifestPath = path.join(tempDir, 'Manifest.db');
    const mDb = openManifestDatabase(manifestPath);
    mDb.close();

    const manifestPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>IsEncrypted</key><true/></dict></plist>`;
    fs.writeFileSync(path.join(tempDir, 'Manifest.plist'), manifestPlist, 'utf8');

    // Попытка миграции в зашифрованный бэкап
    const resp = await postJson('/api/migrate', {
      demo: true,
      direction: 'android-to-ios',
      targetPath: tempDir
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.data.success, false);
    assert.ok(resp.data.error.includes('зашифрована паролем iTunes'));
    assert.ok(resp.data.error.includes('Ошибка 14/54'));

    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  });

  it('/api/open-folder: отвечает успехом при передаче существующей директории', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-stage5-folder-'));
    const resp = await postJson('/api/open-folder', { path: tempDir });
    assert.equal(resp.status, 200);
    assert.equal(resp.data.success, true);
    assert.equal(resp.data.folder, tempDir);

    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  });

});
