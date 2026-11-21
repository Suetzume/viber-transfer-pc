/**
 * Virtual Android ADB Protocol Emulator (v3.3.0)
 * 
 * Реализует полноценный сетевой демон протокола Android Debug Bridge (ADB Transport Protocol)
 * поверх TCP (127.0.0.1:5555).
 * 
 * Позволяет настоящему бинарному клиенту Google `adb.exe` подключаться к виртуальному
 * смартфону Google Pixel 8 Pro (Android 14) без необходимости прав Администратора или Hyper-V:
 * - Отвечает на рукопожатие `CNXN` (0x4e584e43)
 * - Выполняет shell-команды (`pm path com.viber.voip`, `getprop`, `ls /sdcard/viber_messages`)
 * - Поддерживает бинарный протокол `sync:` (`STAT`, `STA2`, `RECV`) для реальной команды `adb pull`!
 */

const net = require('node:net');
const fs = require('node:fs');

const A_CNXN = 0x4e584e43; // 'CNXN'
const A_OPEN = 0x4e45504f; // 'OPEN'
const A_OKAY = 0x59414b4f; // 'OKAY'
const A_CLSE = 0x45534c43; // 'CLSE'
const A_WRTE = 0x45545257; // 'WRTE'
const A_AUTH = 0x48545541; // 'AUTH'

const ADB_VERSION = 0x01000000;
const MAX_PAYLOAD = 256 * 1024;

function computeChecksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum = (sum + buf[i]) >>> 0;
  }
  return sum;
}

function buildAdbPacket(command, arg0, arg1, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(24);
  header.writeUInt32LE(command >>> 0, 0);
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(arg1 >>> 0, 8);
  header.writeUInt32LE(data.length >>> 0, 12);
  header.writeUInt32LE(computeChecksum(data) >>> 0, 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, data]);
}

/**
 * Запускает виртуальный ADB-эмулятор Android (Google Pixel 8 Pro, Android 14)
 * @param {object} options
 * @param {number} [options.port=5555]
 * @param {string} [options.viberDbPath] - путь к SQLite базе для отдачи по `adb pull /sdcard/viber_messages`
 * @returns {Promise<{ server: net.Server, port: number, close: Function }>}
 */
function startVirtualAndroidAdbEmulator(options = {}) {
  const port = options.port !== undefined ? options.port : 5555;
  const viberDbPath = options.viberDbPath || null;

  return new Promise((resolve, reject) => {
    let nextLocalStreamId = 100;

    const server = net.createServer((socket) => {
      let recvBuffer = Buffer.alloc(0);
      const streams = new Map(); // remoteId -> { mode: 'shell'|'sync', syncBuf: Buffer }

      socket.on('data', (chunk) => {
        recvBuffer = Buffer.concat([recvBuffer, chunk]);

        while (recvBuffer.length >= 24) {
          const command = recvBuffer.readUInt32LE(0);
          const arg0 = recvBuffer.readUInt32LE(4);
          const arg1 = recvBuffer.readUInt32LE(8);
          const dataLen = recvBuffer.readUInt32LE(12);

          if (recvBuffer.length < 24 + dataLen) {
            break; // Ждем остальные байты пакета
          }

          const payload = recvBuffer.subarray(24, 24 + dataLen);
          recvBuffer = recvBuffer.subarray(24 + dataLen);

          if (command === A_CNXN || command === A_AUTH) {
            const banner = 'device::ro.product.name=husky;ro.product.model=Pixel_8_Pro_Emulator;ro.product.device=husky;\0';
            socket.write(buildAdbPacket(A_CNXN, ADB_VERSION, MAX_PAYLOAD, banner));
          } else if (command === A_OPEN) {
            const remoteId = arg0;
            const localId = nextLocalStreamId++;
            const service = payload.toString('utf8').replace(/\0+$/, '');

            socket.write(buildAdbPacket(A_OKAY, localId, remoteId));

            if (service.startsWith('shell:')) {
              const cmdLine = service.substring(6).trim();
              const outText = handleShellCommand(cmdLine, viberDbPath);
              socket.write(buildAdbPacket(A_WRTE, localId, remoteId, Buffer.from(outText, 'utf8')));
              socket.write(buildAdbPacket(A_CLSE, localId, remoteId));
            } else if (service.startsWith('sync:')) {
              streams.set(remoteId, { localId, mode: 'sync', syncBuf: Buffer.alloc(0) });
            } else {
              socket.write(buildAdbPacket(A_CLSE, localId, remoteId));
            }
          } else if (command === A_WRTE) {
            const remoteId = arg0;
            const stream = streams.get(remoteId);
            if (!stream) {
              socket.write(buildAdbPacket(A_OKAY, arg1, remoteId));
              continue;
            }

            socket.write(buildAdbPacket(A_OKAY, stream.localId, remoteId));

            if (stream.mode === 'sync') {
              stream.syncBuf = Buffer.concat([stream.syncBuf, payload]);
              processSyncBuffer(socket, stream, remoteId, viberDbPath);
            }
          } else if (command === A_OKAY) {
            // Подтверждение от клиента
          } else if (command === A_CLSE) {
            const remoteId = arg0;
            const stream = streams.get(remoteId);
            if (stream) {
              socket.write(buildAdbPacket(A_CLSE, stream.localId, remoteId));
              streams.delete(remoteId);
            }
          }
        }
      });

      socket.on('error', () => {});
    });

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise(res => server.close(() => res()))
      });
    });
  });
}

function handleShellCommand(cmdLine, viberDbPath) {
  if (cmdLine.includes('pm path com.viber.voip')) {
    return 'package:/data/app/~~viber_emu==/com.viber.voip-1/base.apk\n';
  }
  if (cmdLine.includes('ro.build.version.release')) {
    return '14\n';
  }
  if (cmdLine.includes('ro.product.manufacturer')) {
    return 'Google\n';
  }
  if (cmdLine.includes('ro.product.model')) {
    return 'Pixel 8 Pro (Virtual Emulator)\n';
  }
  if (cmdLine.includes('ls /sdcard/viber_messages')) {
    if (viberDbPath && fs.existsSync(viberDbPath)) {
      return '/sdcard/viber_messages\n';
    }
    return '';
  }
  return '\n';
}

function processSyncBuffer(socket, stream, remoteId, viberDbPath) {
  while (stream.syncBuf.length >= 8) {
    const subCmd = stream.syncBuf.subarray(0, 4).toString('ascii');
    const nameLen = stream.syncBuf.readUInt32LE(4);

    if (subCmd === 'QUIT') {
      stream.syncBuf = stream.syncBuf.subarray(8);
      socket.write(buildAdbPacket(A_CLSE, stream.localId, remoteId));
      return;
    }

    if (stream.syncBuf.length < 8 + nameLen) {
      break;
    }

    const remotePath = stream.syncBuf.subarray(8, 8 + nameLen).toString('utf8');
    stream.syncBuf = stream.syncBuf.subarray(8 + nameLen);

    const fileExists = viberDbPath && fs.existsSync(viberDbPath) && remotePath.includes('viber_messages');
    const fileSize = fileExists ? fs.statSync(viberDbPath).size : 0;

    if (subCmd === 'STAT') {
      const resp = Buffer.alloc(16);
      resp.write('STAT', 0, 4, 'ascii');
      resp.writeUInt32LE(fileExists ? 0o100644 : 0, 4); // mode
      resp.writeUInt32LE(fileSize, 8);
      resp.writeUInt32LE(Math.floor(Date.now() / 1000), 12);
      socket.write(buildAdbPacket(A_WRTE, stream.localId, remoteId, resp));
    } else if (subCmd === 'STA2') {
      const resp = Buffer.alloc(72);
      resp.write('STA2', 0, 4, 'ascii');
      resp.writeUInt32LE(fileExists ? 0 : 2, 4); // error (0 = OK, 2 = ENOENT)
      resp.writeUInt32LE(fileExists ? 0o100644 : 0, 24); // mode
      resp.writeUInt32LE(1, 28); // nlink
      resp.writeBigUInt64LE(BigInt(fileSize), 40); // size
      socket.write(buildAdbPacket(A_WRTE, stream.localId, remoteId, resp));
    } else if (subCmd === 'RECV') {
      if (fileExists) {
        const fileBytes = fs.readFileSync(viberDbPath);
        const dataHeader = Buffer.alloc(8);
        dataHeader.write('DATA', 0, 4, 'ascii');
        dataHeader.writeUInt32LE(fileBytes.length, 4);

        const doneHeader = Buffer.alloc(8);
        doneHeader.write('DONE', 0, 4, 'ascii');
        doneHeader.writeUInt32LE(0, 4);

        socket.write(buildAdbPacket(A_WRTE, stream.localId, remoteId, Buffer.concat([dataHeader, fileBytes, doneHeader])));
      } else {
        const failHeader = Buffer.alloc(12);
        failHeader.write('FAIL', 0, 4, 'ascii');
        failHeader.writeUInt32LE(4, 4);
        failHeader.write('NONE', 8, 4, 'ascii');
        socket.write(buildAdbPacket(A_WRTE, stream.localId, remoteId, failHeader));
      }
    }
  }
}

module.exports = {
  startVirtualAndroidAdbEmulator
};
