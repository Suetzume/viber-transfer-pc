/**
 * Integration Test: Проверка автономного исполняемого файла ViberTransfer.exe.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const EXE_PATH = path.join(__dirname, '../ViberTransfer.exe');
const TEST_EXE_PORT = 34571;

describe('Distribution: Standalone ViberTransfer.exe Verification', () => {
  test('бинарный файл ViberTransfer.exe существует и имеет валидный размер', () => {
    assert.ok(fs.existsSync(EXE_PATH), 'ViberTransfer.exe должен существовать в корне проекта');
    const stat = fs.statSync(EXE_PATH);
    // Размер должен быть больше 50 МБ (содержит Node.js runtime + SQLite + ресурсы)
    assert.ok(stat.size > 50 * 1024 * 1024, `Размер файла ${stat.size} байт слишком мал`);
  });

  test('ViberTransfer.exe успешно запускается и отвечает на HTTP API запросы', async () => {
    const child = spawn(EXE_PATH, [], {
      env: { ...process.env, PORT: String(TEST_EXE_PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutData = '';
    child.stdout.on('data', chunk => stdoutData += chunk);

    // Ожидаем старт сервера (максимум 5 секунд)
    const serverReady = await new Promise((resolve) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const req = http.get(`http://localhost:${TEST_EXE_PORT}/api/preflight`, (res) => {
          clearInterval(interval);
          resolve(res.statusCode === 200);
        });
        req.on('error', () => {
          if (attempts > 25) {
            clearInterval(interval);
            resolve(false);
          }
        });
      }, 200);
    });

    // Завершаем тестовый процесс
    child.kill('SIGTERM');

    assert.ok(serverReady, 'ViberTransfer.exe должен запуститься и ответить на /api/preflight с кодом 200');
  });
});
