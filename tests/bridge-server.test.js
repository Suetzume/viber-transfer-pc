const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { server, startServer, stopServer } = require('../src/server/bridge-server');

const TEST_PORT = 34568;

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`http://localhost:${TEST_PORT}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: resBody });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Layer 6: Desktop Bridge Server & Web GUI Integration (v1.2.0)', () => {
  it('starts the local bridge server and responds to /api/preflight', async () => {
    await startServer(TEST_PORT);

    const res = await makeRequest('/api/preflight');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.diskSpaceOk, true);
    assert.strictEqual(res.data.zeroDataLossReady, true);
  });

  it('handles /api/detect-desktop and returns account listings safely', async () => {
    const res = await makeRequest('/api/detect-desktop');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(Array.isArray(res.data.accounts));
  });

  it('triggers real end-to-end migration via POST /api/migrate and returns valid report', async () => {
    const res = await makeRequest('/api/migrate', 'POST', {
      direction: 'android-to-ios',
      demo: true
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.report);
    assert.strictEqual(res.data.report.direction, 'android-to-ios');
    assert.strictEqual(res.data.report.chatsCount, 3);
    assert.strictEqual(res.data.report.messagesCount, 5);
  });

  it('serves the static index.html renderer UI', async () => {
    const res = await makeRequest('/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.raw.includes('Viber Transfer PC Bridge'));

    await stopServer();
  });
});
