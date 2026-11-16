/**
 * ADB Connector: Подсистема обнаружения и взаимодействия с Android-устройствами по USB (ADB).
 * 
 * Включает:
 * - Поиск исполняемого файла adb (Android SDK, PATH, стандартные каталоги Windows)
 * - Парсинг вывода `adb devices -l` с определением статуса, модели, серийного номера
 * - Опрос параметров подключенного устройства (версия Android, наличие com.viber.voip)
 * - Многоуровневую стратегию обнаружения источников данных (Tier 1: Desktop, Tier 2: Zip, Tier 3: ADB)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFile } = require('node:child_process');
const { detectLocalViberDesktop } = require('../../engine/pipeline/migration-engine');

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
 * Ищет исполняемый файл adb на локальной машине
 * @param {string} [customPath]
 * @returns {string|null}
 */
function findAdbExecutable(customPath = null) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const candidates = [];

  // Переменные окружения Android SDK
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (androidHome) {
    candidates.push(path.join(androidHome, 'platform-tools', 'adb.exe'));
    candidates.push(path.join(androidHome, 'platform-tools', 'adb'));
  }

  // Стандартные пути Windows
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

  // Проверка adb в системном PATH
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
 * Сканирует систему на наличие подключенных устройств Android
 * @param {object} [options]
 * @param {string} [options.adbPath]
 * @param {number} [options.timeoutMs]
 * @returns {object} { available: boolean, adbPath: string|null, devices: Array<object>, error?: string }
 */
function scanAndroidDevices(options = {}) {
  const adbExecutable = findAdbExecutable(options.adbPath);
  if (!adbExecutable) {
    return {
      available: false,
      adbPath: null,
      devices: [],
      error: 'Исполняемый файл adb не найден. Установите Android SDK или добавьте adb в PATH.'
    };
  }

  try {
    const timeout = options.timeoutMs || 3000;
    const output = execSync(`"${adbExecutable}" devices -l`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout
    });

    const devices = parseAdbDevicesOutput(output);

    // Дополнительный опрос параметров для авторизованных устройств
    for (const dev of devices) {
      if (dev.isAuthorized) {
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
      } else {
        dev.viberInstalled = null;
        dev.osVersion = null;
      }
    }

    return {
      available: true,
      adbPath: adbExecutable,
      devices
    };
  } catch (err) {
    return {
      available: false,
      adbPath: adbExecutable,
      devices: [],
      error: err.message
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
  } else if (foundArchives.length > 0) {
    recommendedStrategy = 'backup_zip'; // Tier 2: архив Google Drive
  } else if (adbScan.devices.some(d => d.isAuthorized)) {
    recommendedStrategy = 'adb_device'; // Tier 3: USB подключение
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
  findAdbExecutable,
  scanAndroidDevices,
  detectAndroidDataSources
};
