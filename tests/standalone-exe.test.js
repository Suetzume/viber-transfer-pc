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

  test('ViberTransfer.exe корректно отдает HTML-интерфейс на главной странице GET /', async () => {
    const child = spawn(EXE_PATH, [], {
      env: { ...process.env, PORT: String(TEST_EXE_PORT + 1) },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const htmlContent = await new Promise((resolve) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const req = http.get(`http://localhost:${TEST_EXE_PORT + 1}/`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            clearInterval(interval);
            resolve({ status: res.statusCode, body });
          });
        });
        req.on('error', () => {
          if (attempts > 25) {
            clearInterval(interval);
            resolve(null);
          }
        });
      }, 200);
    });

    child.kill('SIGTERM');

    assert.ok(htmlContent, 'Сервер должен ответить на запрос GET /');
    assert.equal(htmlContent.status, 200);
    assert.ok(htmlContent.body.includes('Viber Transfer PC Bridge'), 'Ответ должен содержать заголовок Viber Transfer');
    assert.ok(htmlContent.body.includes('<!DOCTYPE html>'), 'Ответ должен содержать HTML разметку');
  });
});
