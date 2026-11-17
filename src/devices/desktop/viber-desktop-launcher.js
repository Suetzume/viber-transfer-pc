/**
 * Viber Desktop Launcher: Модуль обнаружения, запуска инсталлятора и мониторинга
 * локального клиента Viber Desktop на ПК (Tier 1 No-Root канал извлечения).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');

/**
 * Проверяет наличие установленного Viber Desktop или скачанного инсталлятора ViberSetup.exe
 * @returns {object} { available: boolean, type: 'installed'|'installer'|'download_needed', path: string|null, label: string, downloadUrl?: string }
 */
function getViberDesktopLauncherStatus() {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const progFiles = process.env['ProgramFiles'];
  const progFilesX86 = process.env['ProgramFiles(x86)'];

  // 1. Поиск установленного Viber.exe
  const appCandidates = [
    localAppData ? path.join(localAppData, 'Viber', 'Viber.exe') : null,
    localAppData ? path.join(localAppData, 'Programs', 'Viber', 'Viber.exe') : null,
    progFiles ? path.join(progFiles, 'Viber', 'Viber.exe') : null,
    progFilesX86 ? path.join(progFilesX86, 'Viber', 'Viber.exe') : null
  ].filter(Boolean);

  for (const p of appCandidates) {
    if (fs.existsSync(p)) {
      return {
        available: true,
        type: 'installed',
        path: p,
        label: 'Запустить установленный Viber Desktop'
      };
    }
  }

  // 2. Поиск инсталлятора ViberSetup.exe в папке Загрузок / Рабочего стола
  const installerCandidates = [
    userProfile ? path.join(userProfile, 'Downloads', 'ViberSetup.exe') : null,
    userProfile ? path.join(userProfile, 'Desktop', 'ViberSetup.exe') : null
  ].filter(Boolean);

  for (const p of installerCandidates) {
    if (fs.existsSync(p)) {
      return {
        available: true,
        type: 'installer',
        path: p,
        label: 'Запустить установку Viber Desktop (найден ViberSetup.exe)'
      };
    }
  }

  // 3. Если ничего не найдено - ссылка на официальный дистрибутив
  return {
    available: false,
    type: 'download_needed',
    path: null,
    downloadUrl: 'https://download.cdn.viber.com/desktop/windows/ViberSetup.exe',
    label: 'Скачать официальный Viber Desktop'
  };
}

/**
 * Запускает установленное приложение Viber Desktop или его инсталлятор
 * @returns {object} { success: boolean, status: object, error?: string }
 */
function launchViberDesktop() {
  const status = getViberDesktopLauncherStatus();

  try {
    if (status.type === 'installed' || status.type === 'installer') {
      const child = spawn(status.path, [], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return { success: true, status };
    } else {
      const startCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      exec(`${startCmd} ${status.downloadUrl}`);
      return { success: true, status };
    }
  } catch (err) {
    return { success: false, status, error: err.message };
  }
}

module.exports = {
  getViberDesktopLauncherStatus,
  launchViberDesktop
};
