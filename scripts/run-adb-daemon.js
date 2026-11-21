/**
 * Background Virtual Android 14 (Google Pixel 8 Pro) ADB Daemon (Port 5555)
 * 
 * Запускается в отдельном процессе и обслуживает запросы реального бинарного
 * клиента `bin/platform-tools/adb.exe` по протоколу ADB over TCP (127.0.0.1:5555).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startVirtualAndroidAdbEmulator } = require('../src/devices/android/virtual-adb-emulator');

const PID_FILE = path.join(os.tmpdir(), 'viber_virtual_adb_emulator.pid');
const port = Number(process.argv[2]) || 5555;
const dbPath = process.argv[3] || path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'ViberPC',
  '+380501234567',
  'viber.db'
);

(async () => {
  try {
    const emu = await startVirtualAndroidAdbEmulator({
      port,
      viberDbPath: dbPath
    });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    console.log(`[Virtual ADB Emulator] Google Pixel 8 Pro (Android 14) запущен на 127.0.0.1:${emu.port} (PID: ${process.pid})`);

    process.on('SIGINT', async () => {
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      await emu.close();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      await emu.close();
      process.exit(0);
    });
  } catch (err) {
    // Порт 5555 уже занят (например, запущен BlueStacks или предыдущий экземпляр демона)
    process.exit(0);
  }
})();
