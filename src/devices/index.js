/**
 * Devices Subsystem: Единая точка доступа к подсистеме физических устройств и бэкапов.
 */

const adbConnector = require('./android/adb-connector');
const iosConnector = require('./ios/ios-connector');
const desktopLauncher = require('./desktop/viber-desktop-launcher');

/**
 * Комплексное сканирование всей физической и логической инфраструктуры:
 * - Все подключенные Android устройства через ADB и локальные базы данных Viber Desktop
 * - Все подключенные и сохраненные копии Apple iPhone (MobileSync Backup)
 * - Статус системных служб Apple и отладки Android
 */
function scanAllDevicesAndBackups() {
  const androidSources = adbConnector.detectAndroidDataSources();
  const iosBackups = iosConnector.scanIOSBackups();
  const appleServices = iosConnector.detectAppleServices();
  const launcherStatus = desktopLauncher.getViberDesktopLauncherStatus();

  return {
    timestamp: Date.now(),
    android: {
      devices: androidSources.tier3_adb.devices,
      adbAvailable: androidSources.tier3_adb.available,
      adbError: androidSources.tier3_adb.error || null,
      desktopAccounts: androidSources.tier1_desktop.accounts,
      desktopLauncher: launcherStatus,
      foundArchives: androidSources.tier2_archives.archives,
      recommendedStrategy: androidSources.recommendedStrategy
    },
    ios: {
      backups: iosBackups,
      appleServices,
      backupRoots: iosConnector.getMobileSyncBackupRoots()
    }
  };
}

module.exports = {
  ...adbConnector,
  ...iosConnector,
  ...desktopLauncher,
  scanAllDevicesAndBackups
};
