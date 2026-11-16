/**
 * iOS Connector: Подсистема обнаружения и инспекции резервных копий iOS (MobileSync / iTunes / Apple Devices).
 * 
 * Включает:
 * - Обнаружение стандартных путей бэкапов Apple на Windows (Win32 и Microsoft Store)
 * - Инспекцию базы `Manifest.db` с проверкой на шифрование и наличия контейнера Viber (`AppDomainGroup-group.viber`)
 * - Парсинг метаданных устройства из `Info.plist` / `Manifest.plist`
 * - Валидацию резервной копии перед операцией восстановления (проверка свободного места на диске и Find My iPhone)
 * - Проверку наличия установленных служб Apple (Apple Mobile Device Support / iTunes)
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Возвращает список стандартных путей к каталогам бэкапов Apple на Windows
 * @returns {Array<string>} существующие пути к каталогам Backup
 */
function getMobileSyncBackupRoots() {
  const roots = [];

  // 1. Классический iTunes (Win32 Installer)
  const appData = process.env.APPDATA;
  if (appData) {
    roots.push(path.join(appData, 'Apple Computer', 'MobileSync', 'Backup'));
  }

  // 2. Microsoft Store iTunes / Apple Devices App (UWP / MSIX)
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    roots.push(path.join(userProfile, 'Apple', 'MobileSync', 'Backup'));
  }

  return roots.filter(r => fs.existsSync(r));
}

/**
 * Парсит базовые метаданные из Info.plist или Manifest.plist (XML или binary plist)
 * @param {Buffer|string} bufferOrString
 * @returns {object} { deviceName, productType, productVersion, isEncrypted }
 */
function parsePlistMetadata(bufferOrString) {
  const result = {
    deviceName: 'iPhone',
    productType: 'iPhone',
    productVersion: 'iOS',
    isEncrypted: false
  };

  if (!bufferOrString) return result;

  const content = Buffer.isBuffer(bufferOrString) ? bufferOrString.toString('binary') : String(bufferOrString);

  // 1. Поиск XML формата (<plist>...</plist>)
  if (content.includes('<?xml') || content.includes('<plist')) {
    const matchDevice = content.match(/<key>Device Name<\/key>\s*<string>([^<]+)<\/string>/i);
    if (matchDevice) result.deviceName = matchDevice[1].trim();

    const matchProduct = content.match(/<key>Product Type<\/key>\s*<string>([^<]+)<\/string>/i);
    if (matchProduct) result.productType = matchProduct[1].trim();

    const matchVersion = content.match(/<key>Product Version<\/key>\s*<string>([^<]+)<\/string>/i);
    if (matchVersion) result.productVersion = matchVersion[1].trim();

    const matchEncrypted = content.match(/<key>IsEncrypted<\/key>\s*<(true|false)\s*\/>/i);
    if (matchEncrypted) result.isEncrypted = matchEncrypted[1].toLowerCase() === 'true';

    return result;
  }

  // 2. Поиск в бинарном plist (bplist00)
  if (content.startsWith('bplist00')) {
    // Проверка флага шифрования IsEncrypted
    const encIndex = content.indexOf('IsEncrypted');
    if (encIndex !== -1) {
      // В bplist за строкой следует байт 0x08 (false) или 0x09 (true)
      const afterKey = content.charCodeAt(encIndex + 'IsEncrypted'.length);
      const afterKeyNext = content.charCodeAt(encIndex + 'IsEncrypted'.length + 1);
      if (afterKey === 9 || afterKeyNext === 9) {
        result.isEncrypted = true;
      }
    }

    // Извлечение имени устройства и версии (по строковым маркерам)
    const devMatch = content.match(/Device Name[^\w]*([A-Za-z0-9 '\-]{2,30})/);
    if (devMatch) result.deviceName = devMatch[1].trim();

    const verMatch = content.match(/Product Version[^\w]*(\d+\.\d+(\.\d+)?)/);
    if (verMatch) result.productVersion = verMatch[1].trim();

    const prodMatch = content.match(/(iPhone\d+,\d+)/);
    if (prodMatch) result.productType = prodMatch[1].trim();
  }

  return result;
}

/**
 * Инспектирует каталог бэкапа iOS и его Manifest.db
 * @param {string} backupDir - путь к папке конкретного бэкапа
 * @returns {object} отчет о бэкапе
 */
function inspectIOSBackup(backupDir) {
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Каталог бэкапа не существует: ${backupDir}`);
  }

  const udid = path.basename(backupDir);
  const manifestPath = path.join(backupDir, 'Manifest.db');
  const infoPlistPath = path.join(backupDir, 'Info.plist');
  const manifestPlistPath = path.join(backupDir, 'Manifest.plist');

  let metadata = {
    deviceName: 'Неизвестный iPhone',
    productType: 'iPhone',
    productVersion: 'iOS',
    isEncrypted: false
  };

  if (fs.existsSync(infoPlistPath)) {
    try {
      metadata = parsePlistMetadata(fs.readFileSync(infoPlistPath));
    } catch (_) {}
  } else if (fs.existsSync(manifestPlistPath)) {
    try {
      metadata = parsePlistMetadata(fs.readFileSync(manifestPlistPath));
    } catch (_) {}
  }

  // Расчет размера бэкапа
  let backupSizeBytes = 0;
  let fileCount = 0;
  try {
    const entries = fs.readdirSync(backupDir, { withFileTypes: true, recursive: true });
    for (const ent of entries) {
      if (ent.isFile()) {
        fileCount++;
        try {
          const s = fs.statSync(path.join(ent.parentPath || backupDir, ent.name));
          backupSizeBytes += s.size;
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Проверка Manifest.db
  if (!fs.existsSync(manifestPath)) {
    return {
      udid,
      backupPath: backupDir,
      manifestPath,
      manifestExists: false,
      isEncrypted: metadata.isEncrypted,
      deviceName: metadata.deviceName,
      productType: metadata.productType,
      iosVersion: metadata.productVersion,
      totalFiles: fileCount,
      viberFiles: [],
      hasViberData: false,
      backupSizeBytes,
      status: 'missing_manifest',
      error: 'Manifest.db не найден в каталоге бэкапа'
    };
  }

  try {
    const db = new DatabaseSync(manifestPath, { readOnly: true });
    
    // Проверка таблицы Files
    const checkTable = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='Files'").get();
    if (!checkTable || checkTable.cnt === 0) {
      db.close();
      return {
        udid,
        backupPath: backupDir,
        manifestPath,
        manifestExists: true,
        isEncrypted: true,
        deviceName: metadata.deviceName,
        productType: metadata.productType,
        iosVersion: metadata.productVersion,
        totalFiles: fileCount,
        viberFiles: [],
        hasViberData: false,
        backupSizeBytes,
        status: 'encrypted',
        error: 'Manifest.db зашифрован или поврежден (таблица Files недоступна)'
      };
    }

    const totalRow = db.prepare("SELECT count(*) as total FROM Files").get();
    const viberRows = db.prepare(`
      SELECT fileID, domain, relativePath, flags 
      FROM Files 
      WHERE domain LIKE '%viber%' OR relativePath LIKE '%viber%' OR relativePath LIKE '%Chat.data%'
      LIMIT 50
    `).all();

    db.close();

    const hasViberData = viberRows.length > 0;

    return {
      udid,
      backupPath: backupDir,
      manifestPath,
      manifestExists: true,
      isEncrypted: metadata.isEncrypted,
      deviceName: metadata.deviceName,
      productType: metadata.productType,
      iosVersion: metadata.productVersion,
      totalFiles: totalRow ? totalRow.total : fileCount,
      viberFiles: viberRows,
      hasViberData,
      backupSizeBytes,
      status: metadata.isEncrypted ? 'encrypted' : 'ready'
    };
  } catch (err) {
    return {
      udid,
      backupPath: backupDir,
      manifestPath,
      manifestExists: true,
      isEncrypted: true,
      deviceName: metadata.deviceName,
      productType: metadata.productType,
      iosVersion: metadata.productVersion,
      totalFiles: fileCount,
      viberFiles: [],
      hasViberData: false,
      backupSizeBytes,
      status: 'encrypted_or_corrupt',
      error: err.message
    };
  }
}

/**
 * Сканирует все найденные каталоги MobileSync на наличие существующих бэкапов
 * @param {Array<string>} [customRoots]
 * @returns {Array<object>} массив отчетов по найденным бэкапам
 */
function scanIOSBackups(customRoots = null) {
  const roots = customRoots || getMobileSyncBackupRoots();
  const backups = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    try {
      const items = fs.readdirSync(root, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const backupDir = path.join(root, item.name);
          const manifestPath = path.join(backupDir, 'Manifest.db');
          const infoPath = path.join(backupDir, 'Info.plist');
          
          if (fs.existsSync(manifestPath) || fs.existsSync(infoPath)) {
            const info = inspectIOSBackup(backupDir);
            backups.push(info);
          }
        }
      }
    } catch (_) {}
  }

  return backups;
}

/**
 * Валидирует готовность бэкапа к процедуре восстановления на iPhone
 * @param {string} backupDir
 * @returns {object} { ok: boolean, warnings: Array<string>, errors: Array<string>, details: object }
 */
function validateBackupForRestore(backupDir) {
  const warnings = [];
  const errors = [];

  if (!fs.existsSync(backupDir)) {
    errors.push(`Каталог резервной копии не существует: ${backupDir}`);
    return { ok: false, warnings, errors, details: null };
  }

  const details = inspectIOSBackup(backupDir);

  if (details.isEncrypted) {
    errors.push('Резервная копия зашифрована паролем iTunes. Отключите шифрование в настройках iTunes / Apple Devices перед переносом.');
  }

  if (!details.manifestExists) {
    errors.push('Отсутствует файл Manifest.db. Резервная копия неполная или повреждена.');
  }

  // Проверка свободного места на целевом диске (требуется запас минимум 1.5x от размера бэкапа)
  try {
    if (fs.statfsSync) {
      const statfs = fs.statfsSync(backupDir);
      const freeBytes = statfs.bavail * statfs.bsize;
      const requiredBytes = Math.max(details.backupSizeBytes * 1.5, 500 * 1024 * 1024); // Минимум 500 МБ

      if (freeBytes < requiredBytes) {
        warnings.push(`На диске мало свободного места (${Math.round(freeBytes / (1024*1024))} МБ). Рекомендуется минимум ${Math.round(requiredBytes / (1024*1024))} МБ.`);
      }
    }
  } catch (_) {}

  // Обязательное предупреждение о Find My iPhone (FMEA Risk 2)
  warnings.push('Внимание: Убедитесь, что функция «Локатор» (Find My iPhone) отключена на целевом iPhone на время восстановления бэкапа.');

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    details
  };
}

/**
 * Определяет подключенные устройства Apple (iPhone/iPad) через Windows PnP
 * @returns {Array<string>} список найденных устройств
 */
function detectWindowsPnpAppleDevices() {
  if (process.platform !== 'win32') return [];
  try {
    const { execSync } = require('node:child_process');
    const cmd = 'powershell -NoProfile -Command "Get-PnpDevice -Status OK -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match \'Apple|iPhone|iPad\' } | ForEach-Object { $_.FriendlyName }"';
    const out = execSync(cmd, { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (!out) return [];
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Проверяет наличие установленных служб Apple на хост-компьютере
 * @returns {object} { appleMobileDeviceInstalled, itunesInstalled, appleDevicesAppInstalled, appleServicesAvailable, iphoneConnectedViaUsb, help, downloadUrl }
 */
function detectAppleServices() {
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || '';

  const amdPaths = [
    path.join(programFiles, 'Common Files', 'Apple', 'Mobile Device Support', 'AppleMobileDeviceService.exe'),
    path.join(programFilesX86, 'Common Files', 'Apple', 'Mobile Device Support', 'AppleMobileDeviceService.exe')
  ];

  const itunesPaths = [
    path.join(programFiles, 'iTunes', 'iTunes.exe'),
    path.join(programFilesX86, 'iTunes', 'iTunes.exe')
  ];

  const appleDevicesAppPaths = [
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'AppleDevices.exe')
  ];

  const appleMobileDeviceInstalled = amdPaths.some(p => fs.existsSync(p));
  const itunesInstalled = itunesPaths.some(p => fs.existsSync(p));
  const appleDevicesAppInstalled = appleDevicesAppPaths.some(p => fs.existsSync(p));

  const pnpAppleDevices = detectWindowsPnpAppleDevices();
  const iphoneConnectedViaUsb = pnpAppleDevices.length > 0;

  const appleServicesAvailable = itunesInstalled || appleDevicesAppInstalled || appleMobileDeviceInstalled;

  let help = '';
  if (!appleServicesAvailable) {
    help = 'iTunes или приложение «Устройства Apple» не установлены на этом компьютере. Они необходимы для создания локальной копии iPhone.';
  } else if (!iphoneConnectedViaUsb) {
    help = 'Подключите iPhone кабелем Lightning/Type-C к компьютеру и выберите «Доверять этому компьютеру».';
  } else {
    help = 'iPhone подключен. Создайте резервную копию в iTunes (БЕЗ шифрования), чтобы программа смогла внедрить чаты.';
  }

  return {
    appleMobileDeviceInstalled,
    itunesInstalled,
    appleDevicesAppInstalled,
    appleServicesAvailable,
    iphoneConnectedViaUsb,
    pnpAppleDevices,
    help,
    downloadUrl: 'https://apps.microsoft.com/detail/9np83lwlpz9k'
  };
}

module.exports = {
  getMobileSyncBackupRoots,
  parsePlistMetadata,
  inspectIOSBackup,
  scanIOSBackups,
  validateBackupForRestore,
  detectAppleServices,
  detectWindowsPnpAppleDevices
};
