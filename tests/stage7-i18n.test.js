/**
 * Stage 7 Test Suite: Bilingual UI Support (RU/EN) & Language Switcher
 * 
 * Проверяет:
 * 1. Наличие кнопки переключения языков (#langSwitchBtn, #currentLangLabel).
 * 2. Полноту словарей I18N: все ключи русской локализации зеркально присутствуют в английской.
 * 3. Отсутствие пустых строк или заглушек в переводах.
 * 4. Наличие функций applyLanguage() и toggleLanguage() с сохранением в localStorage.
 * 5. Наличие заголовков Cache-Control (no-cache) при отдаче index.html для предотвращения кеширования старых версий.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { startServer } = require('../src/server/bridge-server');

const TEST_PORT = 34588;

describe('Stage 7: Bilingual UI Support (RU/EN) & Language Switcher', () => {
  let serverInstance = null;
  const htmlPath = path.join(__dirname, '../src/renderer/index.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  before(async () => {
    serverInstance = await startServer(TEST_PORT);
  });

  after(() => {
    if (serverInstance && serverInstance.close) {
      serverInstance.close();
    }
  });

  it('UI Contract: index.html содержит кнопку #langSwitchBtn и метку #currentLangLabel', () => {
    assert.ok(htmlContent.includes('id="langSwitchBtn"'), 'Должна присутствовать кнопка langSwitchBtn');
    assert.ok(htmlContent.includes('id="currentLangLabel"'), 'Должен присутствовать элемент currentLangLabel');
    assert.ok(htmlContent.includes('onclick="toggleLanguage()"'), 'Кнопка должна вызывать toggleLanguage()');
    assert.ok(htmlContent.includes('.lang-switch-btn'), 'Должны присутствовать CSS стили для .lang-switch-btn');
  });

  it('I18N Contract: словарь I18N содержит полные и валидные переводы ru и en', () => {
    // Извлекаем объект I18N из index.html
    const match = htmlContent.match(/const\s+I18N\s*=\s*(\{[\s\S]*?\n\s{4}\};)/);
    assert.ok(match, 'В index.html должен быть объявлен словарь const I18N = { ... }');

    const i18nCode = match[1];
    const parseFn = new Function(`return ${i18nCode};`);
    const i18n = parseFn();

    assert.ok(i18n.ru, 'Словарь должен содержать русскую локализацию ru');
    assert.ok(i18n.en, 'Словарь должен содержать английскую локализацию en');

    const ruKeys = Object.keys(i18n.ru);
    const enKeys = Object.keys(i18n.en);

    assert.ok(ruKeys.length >= 40, `Ожидалось не менее 40 ключей локализации (получено: ${ruKeys.length})`);
    assert.equal(ruKeys.length, enKeys.length, 'Количество ключей в RU и EN должно строго совпадать');

    for (const key of ruKeys) {
      assert.ok(key in i18n.en, `Ключ '${key}' отсутствует в английской локализации en`);
      assert.ok(typeof i18n.ru[key] === 'string' && i18n.ru[key].trim().length > 0, `RU ключ '${key}' не должен быть пустым`);
      assert.ok(typeof i18n.en[key] === 'string' && i18n.en[key].trim().length > 0, `EN ключ '${key}' не должен быть пустым`);
    }
  });

  it('UI Contract: ключевые элементы интерфейса имеют ID для динамической локализации', () => {
    const requiredIds = [
      'step1Title',
      'step2Title',
      'step3Title',
      'stepIndicator1Text',
      'stepIndicator2Text',
      'stepIndicator3Text',
      'directionText',
      'fastSyncTitle',
      'zipGuideTitle',
      'iosGuideTitle',
      'restoreGuideHeader',
      'startBtnText',
      'summarySourceLabel',
      'summaryTargetLabel',
      'summaryModeLabel',
      'statChatsLabel',
      'statMsgsLabel',
      'statMediaLabel',
      'statDeduplicatedLabel',
      'statDurationLabel'
    ];

    for (const id of requiredIds) {
      assert.ok(htmlContent.includes(`id="${id}"`), `В HTML должен присутствовать элемент с id="${id}"`);
    }
  });

  it('Network Contract: GET / отдает Cache-Control: no-cache для предотвращения показа старых версий', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}/`, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: data
        }));
      }).on('error', reject);
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['cache-control'], 'Ответ должен содержать заголовок Cache-Control');
    assert.ok(res.headers['cache-control'].includes('no-cache'), 'Cache-Control должен содержать no-cache');
    assert.ok(res.body.includes('langSwitchBtn'), 'Возвращаемый HTML должен содержать langSwitchBtn');
    assert.ok(res.body.includes('v3.1.1'), 'Версия в HTML должна быть обновлена до v3.1.1');
  });

  it('Hardware Diagnostics Contract: renderDiagnostics и applyLanguage корректно переводят все статусы устройств и служб', () => {
    assert.ok(htmlContent.includes("currentLang === 'en' ? 'Launch Installed Viber Desktop'"), 'Кнопка Viber Desktop должна иметь английский перевод');
    assert.ok(htmlContent.includes("currentLang === 'en' ? 'Waiting for iTunes backup'"), 'Статус ожидания бэкапа iTunes должен иметь английский перевод');
    assert.ok(htmlContent.includes("currentLang === 'en' ? 'iTunes not installed'"), 'Статус отсутствия iTunes должен иметь английский перевод');
    assert.ok(htmlContent.includes("t.statusPhoneConnected"), 'Статус подключения телефона должен брать перевод из I18N');
    assert.ok(htmlContent.includes("t.statusUsbDisconnected"), 'Статус отключения USB должен брать перевод из I18N');
  });
});
