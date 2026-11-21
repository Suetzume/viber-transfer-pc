/**
 * ADB Connector: Подсистема обнаружения и взаимодействия с Android-устройствами по USB (ADB).
 * 
 * Включает:
 * - Поиск исполняемого файла adb (встроенный bin/platform-tools, Android SDK, PATH, каталоги Downloads)
 * - Сканирование физических USB-подключений Windows PnP (определение подключенного телефона даже без отладки)
 * - Парсинг вывода `adb devices -l` с определением статуса (device, unauthorized, offline), модели, версии OS
 * - Опрос параметров подключенного устройства (наличие пакета com.viber.voip, версия Android)
 * - Многоуровневую стратегию обнаружения источников данных (Tier 1: Desktop, Tier 2: Zip, Tier 3: ADB)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { detectLocalViberDesktop } = require('../../engine/pipeline/migration-engine');

/**
 * Автоматически подключает ADB к локальному Android-эмулятору (BlueStacks 5 / LDPlayer), если он запущен
 * @param {string} adbExecutable
 */
function tryAutoConnectLocalEmulator(adbExecutable) {
  if (process.platform !== 'win32' || !adbExecutable) return;
  const bstConfPath = 'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf';
  if (!fs.existsSync(bstConfPath)) return;

  try {
    // Проверяем, запущен ли процесс эмулятора HD-Player.exe
    const taskOut = execSync('tasklist /FI "IMAGENAME eq HD-Player.exe" /NH', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 1000
    });
    if (!taskOut || !taskOut.toLowerCase().includes('hd-player.exe')) return;

    const ports = new Set(['5555']);
    const conf = fs.readFileSync(bstConfPath, 'utf8');
    const matches = conf.matchAll(/adb_port="(\d+)"/g);
    for (const m of matches) {
      if (m[1] && m[1] !== '0') ports.add(m[1]);
    }

    for (const port of ports) {
      try {
        execSync(`"${adbExecutable}" connect 127.0.0.1:${port}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
          timeout: 1200
        });
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Парсит текстовый вывод команды `adb devices -l`
 * @param {string} output - сырой вывод команды
 * @returns {Array<object>} массив обнаруженных устройств
 */
function parseAdbDevicesOutput(output) {
  if (!output || typeof output !== 'string') return [];

  const lines = output.split(/\r?\n/);
  const devices = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('List of devices attached')) continue;
    if (line.startsWith('* daemon')) continue; // Пропуск сервисных логов демона ADB

    // Формат строки: <serial> <state> [key:val ...]
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const serial = parts[0];
    const state = parts[1];

    let product = null;
    let model = null;
    let deviceName = null;
    let transportId = null;

    for (let i = 2; i < parts.length; i++) {
      const token = parts[i];
      if (token.startsWith('product:')) product = token.substring(8);
      else if (token.startsWith('model:')) model = token.substring(6).replace(/_/g, ' ');
      else if (token.startsWith('device:')) deviceName = token.substring(7);
      else if (token.startsWith('transport_id:')) transportId = token.substring(13);
    }

    devices.push({
      serial,
      state,
      isAuthorized: state === 'device',
      model: model || serial,
      product: product || 'unknown',
      device: deviceName || 'unknown',
      transportId: transportId || null,
      platform: 'android'
    });
  }

  return devices;
}

/**
 * Определяет наличие физически подключенных телефонов в Windows через PnP (даже если отладка выключена)
 * @returns {Array<string>} список дружественных имен устройств (напр. ["Xiaomi 13 Ultra"])
 */
function detectWindowsPnpPhones() {
  if (process.platform !== 'win32') return [];
  try {
    const cmd = 'powershell -NoProfile -Command "Get-PnpDevice -Class WPD -Status OK -ErrorAction SilentlyContinue | ForEach-Object { $_.FriendlyName }"';
    const out = execSync(cmd, { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (!out) return [];
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Ищет исполняемый файл adb на локальной машине с широким охватом
 * @param {string} [customPath]
 * @returns {string|null}
 */
function findAdbExecutable(customPath = null) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const candidates = [];

  // 1. Встроенный переносной bin/platform-tools внутри проекта
  candidates.push(path.resolve(__dirname, '../../../bin/platform-tools/adb.exe'));
  candidates.push(path.join(process.cwd(), 'bin/platform-tools/adb.exe'));
  candidates.push(path.join(path.dirname(process.execPath), 'bin/platform-tools/adb.exe'));

  // 2. Каталоги пользователя Downloads (PAPKA, platform-tools, Telegram Desktop)
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    candidates.push(path.join(userProfile, 'Downloads', 'PAPKA', 'adb.exe'));
    candidates.push(path.join(userProfile, 'Downloads', 'platform-tools', 'adb.exe'));
    candidates.push(path.join(userProfile, 'Downloads', 'Telegram Desktop', 'PixelBatteryHealth', 'PixelBatteryHealth', 'adb.exe'));
  }

  // 3. Переменные окружения Android SDK
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (androidHome) {
    candidates.push(path.join(androidHome, 'platform-tools', 'adb.exe'));
    candidates.push(path.join(androidHome, 'platform-tools', 'adb'));
  }

  // 4. Стандартные пути Windows Android Studio
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  }

  const programFiles = process.env['ProgramFiles'];
  if (programFiles) {
    candidates.push(path.join(programFiles, 'Android', 'platform-tools', 'adb.exe'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 5. Проверка adb в системном PATH
  try {
    const checkCmd = process.platform === 'win32' ? 'where adb' : 'which adb';
    const found = execSync(checkCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 1500 }).trim();
    if (found) {
      const firstLine = found.split(/\r?\n/)[0].trim();
      if (fs.existsSync(firstLine)) return firstLine;
      return 'adb';
    }
  } catch (_) {}

  return null;
}

/**
 * Сканирует систему на наличие подключенных устройств Android с глубокой диагностикой
 * @param {object} [options]
 * @param {string} [options.adbPath]
 * @param {number} [options.timeoutMs]
 * @returns {object} { available: boolean, adbPath: string|null, pnpPhones: Array<string>, devices: Array<object>, statusSummary: string, error?: string }
 */
function scanAndroidDevices(options = {}) {
  const adbExecutable = findAdbExecutable(options.adbPath);

  if (!adbExecutable) {
    const pnpPhones = detectWindowsPnpPhones();
    return {
      available: false,
      adbPath: null,
      pnpPhones,
      devices: [],
      statusSummary: pnpPhones.length > 0 
        ? `Телефон (${pnpPhones.join(', ')}) подключен к ПК, но ADB-служба не настроена`
        : 'Телефон по USB не обнаружен',
      help: pnpPhones.length > 0 
        ? `Windows видит телефон ${pnpPhones.join(', ')} по кабелю, но исполняемый файл ADB не найден в системе. Добавьте adb в bin/platform-tools.`
        : 'Подключите телефон USB-кабелем к компьютеру и включите режим «Отладка по USB» в настройках разработчика.'
    };
  }

  try {
    const timeout = options.timeoutMs || 3000;
    let output = execSync(`"${adbExecutable}" devices -l`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout
    });

    let devices = parseAdbDevicesOutput(output);
    if (devices.length === 0) {
      tryAutoConnectLocalEmulator(adbExecutable);
      output = execSync(`"${adbExecutable}" devices -l`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout
      });
      devices = parseAdbDevicesOutput(output);
    }

    const pnpPhones = devices.length === 0 ? detectWindowsPnpPhones() : [];

    // Дополнительный опрос параметров для обнаруженных устройств
    for (const dev of devices) {
      if (dev.isAuthorized) {
        // Проверка наличия пакета Viber
        try {
          const viberCheck = execSync(`"${adbExecutable}" -s ${dev.serial} shell pm path com.viber.voip`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 2000
          }).trim();
          dev.viberInstalled = viberCheck.includes('package:');
        } catch (_) {
          dev.viberInstalled = false;
        }

        // Проверка наличия базы Viber на эмуляторе/устройстве (/sdcard/viber_messages или /data/local/tmp/viber_messages)
        try {
          const dbCheck = execSync(`"${adbExecutable}" -s ${dev.serial} shell "ls /sdcard/viber_messages /data/local/tmp/viber_messages 2>/dev/null"`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 1500
          }).trim();
          if (dbCheck.includes('viber_messages')) {
            dev.viberInstalled = true;
            const remotePath = dbCheck.split(/\r?\n/)[0].trim();
            const safeSerial = dev.serial.replace(/[^a-zA-Z0-9_-]/g, '_');
            const localPulledDb = path.join(os.tmpdir(), `viber_adb_pulled_${safeSerial}.db`);
            execSync(`"${adbExecutable}" -s ${dev.serial} pull "${remotePath}" "${localPulledDb}"`, {
              stdio: ['pipe', 'pipe', 'ignore'],
              timeout: 3000
            });
            if (fs.existsSync(localPulledDb)) {
              dev.extractedDbPath = localPulledDb;
            }
          }
        } catch (_) {}

        // Версия Android
        try {
          const osVersion = execSync(`"${adbExecutable}" -s ${dev.serial} shell getprop ro.build.version.release`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 1500
          }).trim();
          dev.osVersion = osVersion || 'unknown';
        } catch (_) {
          dev.osVersion = 'unknown';
        }

        // Человекочитаемое имя производителя и модели
        try {
          const mfg = execSync(`"${adbExecutable}" -s ${dev.serial} shell getprop ro.product.manufacturer`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 1500
          }).trim();
          const prodModel = execSync(`"${adbExecutable}" -s ${dev.serial} shell getprop ro.product.model`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 1500
          }).trim();
          if (mfg && prodModel) {
            dev.friendlyName = `${mfg.toUpperCase()} ${prodModel}`;
          }
        } catch (_) {}

        dev.statusDescription = `Готов к миграции (Android ${dev.osVersion}, Viber: ${dev.viberInstalled ? 'Установлен ✓' : 'Не найден'})`;
      } else if (dev.state === 'unauthorized') {
        dev.friendlyName = dev.model || dev.serial;
        dev.statusDescription = 'Требуется подтверждение на экране смартфона';
        dev.help = 'Разблокируйте телефон и нажмите «Разрешить отладку с этого компьютера» во всплывающем окне.';
      } else if (dev.state === 'offline') {
        dev.friendlyName = dev.model || dev.serial;
        dev.statusDescription = 'Устройство находится в режиме Offline';
        dev.help = 'Переподключите кабель USB или перезагрузите телефон.';
      }
    }

    let statusSummary = '';
    if (devices.length > 0) {
      const authorizedCount = devices.filter(d => d.isAuthorized).length;
      statusSummary = `${authorizedCount} из ${devices.length} устройств(а) готово к передаче`;
    } else if (pnpPhones.length > 0) {
      statusSummary = `Телефон ${pnpPhones.join(', ')} подключен по USB, но отладка по USB выключена!`;
    } else {
      statusSummary = 'Устройства USB не подключены';
    }

    return {
      available: true,
      adbPath: adbExecutable,
      pnpPhones,
      devices,
      statusSummary
    };
  } catch (err) {
    return {
      available: false,
      adbPath: adbExecutable,
      pnpPhones,
      devices: [],
      error: err.message,
      statusSummary: 'Ошибка запуска демона ADB'
    };
  }
}

/**
 * Комплексное обнаружение всех доступных источников данных Viber на стороне Android / ПК
 * @returns {object} структурированный отчет обо всех источниках
 */
function detectAndroidDataSources(options = {}) {
  // 1. Поиск баз Viber Desktop (Tier 1 - самый надежный и быстрый способ)
  const desktopAccounts = detectLocalViberDesktop();

  // 2. Сканирование USB-устройств (Tier 3)
  const adbScan = scanAndroidDevices(options);

  // 3. Поиск архивных копий Google Drive (Tier 2) в стандартных папках Загрузок / Документов
  const foundArchives = [];
  const searchDirs = [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null
  ].filter(Boolean);

  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.toLowerCase().includes('viber') && file.endsWith('.zip')) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            foundArchives.push({
              fileName: file,
              fullPath,
              sizeBytes: stat.size,
              mtime: stat.mtime
            });
          }
        }
      } catch (_) {}
    }
  }

  // Рекомендованный способ
  let recommendedStrategy = 'desktop';
  if (desktopAccounts.length > 0) {
    recommendedStrategy = 'desktop'; // Tier 1: прямой доступ к SQLite
  } else if (adbScan.devices.some(d => d.isAuthorized)) {
    recommendedStrategy = 'adb_device'; // Tier 3: USB подключение
  } else if (foundArchives.length > 0) {
    recommendedStrategy = 'backup_zip'; // Tier 2: архив Google Drive
  } else {
    recommendedStrategy = 'manual_import';
  }

  return {
    recommendedStrategy,
    tier1_desktop: {
      available: desktopAccounts.length > 0,
      accounts: desktopAccounts
    },
    tier2_archives: {
      available: foundArchives.length > 0,
      archives: foundArchives
    },
    tier3_adb: adbScan
  };
}

module.exports = {
  parseAdbDevicesOutput,
  detectWindowsPnpPhones,
  findAdbExecutable,
  scanAndroidDevices,
  detectAndroidDataSources
};
