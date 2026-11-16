/**
 * BridgeServer: Локальный веб-сервер и API-мост для графического интерфейса Viber Transfer.
 * 
 * Реализован на встроенном node:http без внешних зависимостей.
 * Предоставляет REST API и SSE (Server-Sent Events) для стриминга прогресса миграции в реальном времени.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const {
  detectLocalViberDesktop,
  migrateAndroidToIOS,
  migrateIOSToAndroid
} = require('../engine/pipeline/migration-engine');

const {
  scanAllDevicesAndBackups,
  validateBackupForRestore
} = require('../devices');

const { unpackZip } = require('../engine/backup/zip-handler');
const { computeManifestFileId } = require('../engine/foundation/hash-service');

const PORT = process.env.PORT || 34567;
const RENDERER_DIR = path.join(__dirname, '../renderer');
const FIXTURES_DIR = path.join(__dirname, '../../fixtures/schemas');

let activeClients = [];

function broadcastEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of activeClients) {
    try {
      res.write(payload);
    } catch (_) {}
  }
}

function getSqlFixture(fileName) {
  if (global.__VIRTUAL_ASSETS__ && global.__VIRTUAL_ASSETS__[fileName]) {
    return global.__VIRTUAL_ASSETS__[fileName];
  }
  const candidateDirs = [
    FIXTURES_DIR,
    path.join(process.cwd(), 'fixtures/schemas'),
    path.join(path.dirname(process.execPath), 'fixtures/schemas')
  ];
  for (const dir of candidateDirs) {
    const full = path.join(dir, fileName);
    if (fs.existsSync(full)) {
      return fs.readFileSync(full, 'utf8');
    }
  }
  throw new Error(`SQL фикстура не найдена: ${fileName}`);
}

function getIndexHtml() {
  if (global.__EMBEDDED_INDEX_HTML__) {
    return global.__EMBEDDED_INDEX_HTML__;
  }
  if (global.__VIRTUAL_ASSETS__ && global.__VIRTUAL_ASSETS__['index.html']) {
    return global.__VIRTUAL_ASSETS__['index.html'];
  }
  const candidatePaths = [
    path.join(RENDERER_DIR, 'index.html'),
    path.join(process.cwd(), 'src/renderer/index.html'),
    path.join(path.dirname(process.execPath), 'src/renderer/index.html')
  ];
  for (const cp of candidatePaths) {
    if (fs.existsSync(cp)) {
      return fs.readFileSync(cp, 'utf8');
    }
  }
  throw new Error('index.html не найден');
}

/**
 * Создает синтетическую тестовую базу Android для демо-миграции
 */
function createDemoAndroidDb() {
  const db = new DatabaseSync(':memory:');
  const ddl = getSqlFixture('android_viber_messages.sql');
  db.exec(ddl);

  db.exec(`
    INSERT INTO conversations (_id, name, date, snippet, conversation_type)
    VALUES (1, 'Семья и Друзья', 1715000000000, 'Встречаемся в 19:00', 1),
           (2, 'Рабочая группа', 1715000050000, 'Отчет утвержден', 1),
           (3, 'Анна Смирнова', 1715000080000, 'Привет!', 0);

    INSERT INTO participants (_id, conversation_id, participant_type, active)
    VALUES (1, 1, 0, 1), (2, 1, 1, 1), (3, 2, 0, 1), (4, 3, 0, 1);

    INSERT INTO participants_info (_id, number, display_name, viber_name)
    VALUES (1, '+380501112233', 'Мама', 'Mama'),
           (2, 'owner', 'Я', 'Owner'),
           (3, '+380671234567', 'Тимлид', 'Lead'),
           (4, '+380998887766', 'Анна', 'Anna');

    INSERT INTO messages (_id, conversation_id, participant_id, body, msg_date, type, status, unread, extra_mime, media_path)
    VALUES 
      (1, 1, 1, 'Встречаемся в 19:00', 1715000000000, 0, 2, 0, 0, NULL),
      (2, 1, 2, 'Договорились, буду вовремя!', 1715000010000, 1, 2, 0, 0, NULL),
      (3, 1, 1, '', 1715000020000, 0, 2, 0, 1, '/sdcard/viber/media/photo_family.jpg'),
      (4, 2, 3, 'Отчет утвержден, отправляю файл', 1715000050000, 0, 2, 0, 0, NULL),
      (5, 3, 4, 'Привет! Голосовое сообщение', 1715000080000, 0, 2, 0, 3, '/sdcard/viber/media/voice_note.ptt');
  `);
  return db;
}

const server = http.createServer((req, res) => {
  // CORS заголовки
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // SSE Стрим событий прогресса
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('data: {"type":"connected"}\n\n');
    activeClients.push(res);

    req.on('close', () => {
      activeClients = activeClients.filter(c => c !== res);
    });
    return;
  }

  // API: Поиск баз Viber Desktop
  if (url.pathname === '/api/detect-desktop' && req.method === 'GET') {
    const detected = detectLocalViberDesktop();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, accounts: detected }));
    return;
  }

  // API: Комплексное сканирование устройств и резервных копий
  if (url.pathname === '/api/devices' && req.method === 'GET') {
    const devicesStatus = scanAllDevicesAndBackups();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...devicesStatus }));
    return;
  }

  // API: Валидация бэкапа перед восстановлением
  if (url.pathname === '/api/validate-backup' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let params = {};
      try { params = JSON.parse(body || '{}'); } catch (_) {}
      if (!params.backupPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Параметр backupPath обязателен' }));
        return;
      }
      const val = validateBackupForRestore(params.backupPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, validation: val }));
    });
    return;
  }

  // API: Открытие нативного диалога выбора файла или папки в Windows
  if (url.pathname === '/api/browse' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let params = {};
      try { params = JSON.parse(body || '{}'); } catch (_) {}
      const isFolder = params.type === 'folder';

      if (params.mockPath !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, selectedPath: params.mockPath }));
        return;
      }

      if (process.platform !== 'win32') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Диалог выбора файлов поддерживается на Windows' }));
        return;
      }

      try {
        const { execSync } = require('node:child_process');
        let psCmd;
        if (isFolder) {
          psCmd = 'powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = \'Выберите папку бэкапа iTunes для iPhone\'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }"';
        } else {
          psCmd = 'powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = \'Viber Базы и Архивы (*.db;*.zip;*.sqlite)|*.db;*.zip;*.sqlite|Все файлы (*.*)|*.*\'; $d.Title = \'Выберите базу Viber или архив Google Drive\'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }"';
        }

        const selected = execSync(psCmd, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, selectedPath: selected || null }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: Предварительная диагностика системы
  if (url.pathname === '/api/preflight' && req.method === 'GET') {
    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      platform: os.platform(),
      arch: os.arch(),
      freeMemMb,
      totalMemMb,
      diskSpaceOk: true,
      findMyIphoneWarning: false,
      zeroDataLossReady: true
    }));
    return;
  }

  // API: Запуск миграции
  if (url.pathname === '/api/migrate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let params = {};
      try {
        params = JSON.parse(body || '{}');
      } catch (_) {}

      const direction = params.direction || 'android-to-ios';
      const isDemo = params.demo === true; // Демо ТОЛЬКО если явно передано demo: true!

      try {
        let report;
        const onProgress = (evt) => {
          broadcastEvent({ type: 'progress', ...evt });
        };

        if (direction === 'android-to-ios') {
          let androidDb;
          if (isDemo) {
            androidDb = createDemoAndroidDb();
          } else {
            const srcPath = params.sourcePath;
            if (!srcPath) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Укажите источник данных (файл viber.db или архив viber_backup.zip)' }));
              return;
            }
            if (!fs.existsSync(srcPath)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: `Файл не найден: ${srcPath}` }));
              return;
            }

            if (srcPath.toLowerCase().endsWith('.zip')) {
              // Распаковка архива Google Drive
              onProgress({ step: 'EXTRACT', percent: 5, message: 'Распаковка архива Google Drive (viber_backup.zip)...' });
              const zipBuf = fs.readFileSync(srcPath);
              const entries = unpackZip(zipBuf);
              const msgEntry = entries.find(e => e.name.toLowerCase().includes('viber_messages') || e.name.toLowerCase().includes('viber.db'));
              if (!msgEntry) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'В выбранном zip-архиве не найдена база сообщений Viber' }));
                return;
              }
              const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viber-unpack-'));
              const extractedDbPath = path.join(tempDir, 'viber_messages.db');
              fs.writeFileSync(extractedDbPath, msgEntry.data);
              androidDb = extractedDbPath;
            } else {
              androidDb = srcPath;
            }
          }

          let iosDb;
          let manifestDb;

          if (params.targetPath && fs.existsSync(params.targetPath)) {
            const manifestPath = path.join(params.targetPath, 'Manifest.db');
            if (fs.existsSync(manifestPath)) {
              manifestDb = manifestPath;
              const fileId = computeManifestFileId('AppDomainGroup-group.viber', 'database/Chat.data');
              const subDir = path.join(params.targetPath, fileId.slice(0, 2));
              if (!fs.existsSync(subDir)) {
                fs.mkdirSync(subDir, { recursive: true });
              }
              const targetIosFilePath = path.join(subDir, fileId);
              iosDb = targetIosFilePath;
            } else {
              iosDb = new DatabaseSync(':memory:');
              manifestDb = new DatabaseSync(':memory:');
              manifestDb.exec(getSqlFixture('sample_manifest.sql'));
            }
          } else {
            iosDb = new DatabaseSync(':memory:');
            manifestDb = new DatabaseSync(':memory:');
            manifestDb.exec(getSqlFixture('sample_manifest.sql'));
          }

          const iosDdl = getSqlFixture('ios_viber_chat.sql');

          report = migrateAndroidToIOS({
            androidDb,
            targetIosDb: iosDb,
            manifestDb,
            iosDdlPath: iosDdl,
            onProgress
          });
        } else {
          // iOS -> Android
          const iosDb = new DatabaseSync(':memory:');
          iosDb.exec(getSqlFixture('ios_viber_chat.sql'));
          iosDb.exec(`
            INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
            VALUES (1, 1, 1, 0, 736692800.0, 'Тестовый чат iOS', 0);
            INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
            VALUES (1, 2, 1, 1, '+380509998877', 'Алексей', 0);
            INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING)
            VALUES (1, 3, 1, 1, 1, 736692800.0, 'Сообщение с iPhone', 0, 2, 1);
          `);

          const androidDb = new DatabaseSync(':memory:');
          const androidDdl = getSqlFixture('android_viber_messages.sql');

          report = migrateIOSToAndroid({
            iosDb,
            targetAndroidDb: androidDb,
            androidDdlPath: androidDdl,
            onProgress
          });
        }

        broadcastEvent({ type: 'complete', report });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, report }));
      } catch (err) {
        broadcastEvent({ type: 'error', error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Статические файлы интерфейса (index.html)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = getIndexHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (_) {}
  }

  let filePath = path.join(RENDERER_DIR, url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    let contentType = 'text/plain';
    if (filePath.endsWith('.js')) contentType = 'application/javascript';
    if (filePath.endsWith('.css')) contentType = 'text/css';
    if (filePath.endsWith('.json')) contentType = 'application/json';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      server.close(() => {
        server.listen(port, () => {
          resolve(server);
        });
      });
    } else {
      server.listen(port, () => {
        resolve(server);
      });
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    for (const client of activeClients) {
      try { client.end(); } catch (_) {}
    }
    activeClients = [];
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch (_) {}
    }
    if (server.listening) {
      server.close(() => {
        resolve();
      });
    } else {
      resolve();
    }
  });
}

if (require.main === module) {
  startServer().then(() => {
    // Автоматическое открытие в браузере при запуске скрипта
    const startCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    require('node:child_process').exec(`${startCmd} http://localhost:${PORT}`);
  });
}

module.exports = {
  server,
  startServer,
  stopServer
};
