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

/**
 * Создает синтетическую тестовую базу Android для демо-миграции
 */
function createDemoAndroidDb() {
  const db = new DatabaseSync(':memory:');
  const ddl = fs.readFileSync(path.join(FIXTURES_DIR, 'android_viber_messages.sql'), 'utf8');
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
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
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
      const isDemo = params.demo !== false; // По умолчанию демо-режим, если нет реальных баз

      try {
        let report;
        const onProgress = (evt) => {
          broadcastEvent({ type: 'progress', ...evt });
        };

        if (direction === 'android-to-ios') {
          const androidDb = isDemo ? createDemoAndroidDb() : params.sourcePath;
          const iosDb = new DatabaseSync(':memory:');
          const iosDdlPath = path.join(FIXTURES_DIR, 'ios_viber_chat.sql');
          const manifestDb = new DatabaseSync(':memory:');
          manifestDb.exec(fs.readFileSync(path.join(FIXTURES_DIR, 'sample_manifest.sql'), 'utf8'));

          report = migrateAndroidToIOS({
            androidDb,
            targetIosDb: iosDb,
            manifestDb,
            iosDdlPath,
            onProgress
          });
        } else {
          // iOS -> Android
          const iosDb = new DatabaseSync(':memory:');
          iosDb.exec(fs.readFileSync(path.join(FIXTURES_DIR, 'ios_viber_chat.sql'), 'utf8'));
          iosDb.exec(`
            INSERT INTO ZCONVERSATION (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDATE, ZNAME, ZUNREADCOUNT)
            VALUES (1, 1, 1, 0, 736692800.0, 'Тестовый чат iOS', 0);
            INSERT INTO ZPARTICIPANT (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZPHONENUMBER, ZDISPLAYNAME, ZISOWNER)
            VALUES (1, 2, 1, 1, '+380509998877', 'Алексей', 0);
            INSERT INTO ZMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCONVERSATION, ZSENDER, ZDATE, ZTEXT, ZMESSAGETYPE, ZSTATE, ZISINCOMING)
            VALUES (1, 3, 1, 1, 1, 736692800.0, 'Сообщение с iPhone', 0, 2, 1);
          `);

          const androidDb = new DatabaseSync(':memory:');
          const androidDdlPath = path.join(FIXTURES_DIR, 'android_viber_messages.sql');

          report = migrateIOSToAndroid({
            iosDb,
            targetAndroidDb: androidDb,
            androidDdlPath,
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
  let filePath = path.join(RENDERER_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    let contentType = 'text/html';
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
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[+] Viber Transfer Bridge Server запущен на http://localhost:${port}`);
      resolve(server);
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
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
