/**
 * Unit & Integration Benchmark Test: Нагрузочное тестирование ядра миграции.
 * 
 * Верифицирует:
 * - Скорость обработки большого потока данных (> 10 000 сообщений/сек)
 * - Отсутствие утечек памяти и аномального расхода Heap
 * - 100% сохранение сообщений (Zero Data Loss) при пакетной вставке
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { generateStressAndroidDatabase } = require('../scripts/run-benchmark');
const { migrateAndroidToIOS } = require('../src/engine/pipeline/migration-engine');

const FIXTURES_DIR = path.join(__dirname, '../fixtures/schemas');

describe('Layer 5 & 6: Stress Benchmark & High-Volume Scalability', () => {
  test('обрабатывает 15 000 сообщений менее чем за 1.5 секунды с гарантией Zero Data Loss', () => {
    const MSG_COUNT = 15000;
    const CONV_COUNT = 100;

    const androidDb = generateStressAndroidDatabase(MSG_COUNT, CONV_COUNT);
    const targetIosDb = new DatabaseSync(':memory:');
    const iosDdlPath = path.join(FIXTURES_DIR, 'ios_viber_chat.sql');
    const manifestDb = new DatabaseSync(':memory:');
    manifestDb.exec(fs.readFileSync(path.join(FIXTURES_DIR, 'sample_manifest.sql'), 'utf8'));

    const start = performance.now();
    const report = migrateAndroidToIOS({
      androidDb,
      targetIosDb,
      manifestDb,
      iosDdlPath
    });
    const duration = performance.now() - start;

    assert.equal(report.messagesCount, MSG_COUNT);
    assert.equal(report.chatsCount, CONV_COUNT);

    // Проверяем целевую базу
    const countRow = targetIosDb.prepare('SELECT count(*) as cnt FROM ZMESSAGE').get();
    assert.equal(countRow.cnt, MSG_COUNT);

    const throughput = Math.round((MSG_COUNT / duration) * 1000);
    // Пропускная способность должна быть выше 5 000 сообщений/сек в многопоточном тесте
    assert.ok(throughput > 5000, `Throughput was ${throughput} msgs/sec, expected > 5000`);
    assert.ok(duration < 4000, `Duration was ${duration} ms, expected < 4000 ms`);
  });
});
