/**
 * Smoke-guard для opt-in scenario `production-payroll-scenario`
 * (`tests/integration/production-payroll-scenario.integration.test.ts`).
 *
 * Цель — без поднятия Nest и без TEST_DATABASE_URL убедиться, что:
 *
 *   1. файл сценария существует и совпадает с публикуемым именем;
 *   2. в нём прописаны safety-гарды (TEST_DATABASE_URL,
 *      `__ORIGINAL_DATABASE_URL__`, prod/production/teeon_prod,
 *      и whitelist `sewing_test`/`sewing_ci`/`test` в имени БД);
 *   3. сценарий по умолчанию НЕ запускается без `RUN_PAYROLL_SCENARIO=1`
 *      или `PAYROLL_SCENARIO_CLEANUP_PREFIX=...` (опт-ин гейт);
 *   4. в `tests/package.json` и в корневом `package.json` есть
 *      соответствующие npm-скрипты, чтобы CI/разработчик не угадывали
 *      путь файла.
 *
 * Никаких HTTP-вызовов и DB-операций — этот smoke стабильно проходит на
 * любом окружении, в т.ч. при отсутствии TEST_DATABASE_URL.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SCENARIO_PATH = join(
  ROOT,
  'tests',
  'integration',
  'production-payroll-scenario.integration.test.ts',
);
const TESTS_PKG = join(ROOT, 'tests', 'package.json');
const ROOT_PKG = join(ROOT, 'package.json');
const DOCS_PATH = join(ROOT, 'docs', 'test-production-payroll-flow-seed.md');

describe('production-payroll-scenario — smoke guard', () => {
  let scenarioSource: string;

  test('scenario file exists and is non-empty', () => {
    scenarioSource = readFileSync(SCENARIO_PATH, 'utf8');
    expect(scenarioSource.length).toBeGreaterThan(2_000);
  });

  test('safety guards: TEST_DATABASE_URL, prod/production/teeon_prod, db-name whitelist', () => {
    const src = scenarioSource ?? readFileSync(SCENARIO_PATH, 'utf8');
    expect(src).toMatch(/TEST_DATABASE_URL/);
    // Snapshot оригинального DATABASE_URL до side-effect импортов.
    expect(src).toMatch(/__ORIG_DATABASE_URL__/);
    expect(src).toMatch(/'prod'/);
    expect(src).toMatch(/'production'/);
    expect(src).toMatch(/'teeon_prod'/);
    expect(src).toMatch(/sewing_test/);
    expect(src).toMatch(/sewing_ci/);
    // Гард на имя БД через `dbName.includes(...)`.
    expect(src).toMatch(/dbLower\.includes\('test'\)/);
  });

  test('opt-in gate: RUN_PAYROLL_SCENARIO + PAYROLL_SCENARIO_CLEANUP_PREFIX', () => {
    const src = scenarioSource ?? readFileSync(SCENARIO_PATH, 'utf8');
    expect(src).toMatch(/RUN_PAYROLL_SCENARIO/);
    expect(src).toMatch(/PAYROLL_SCENARIO_CLEANUP_PREFIX/);
    expect(src).toMatch(/PAYROLL_SCENARIO_KEEP/);
    // describe.skip когда не включён.
    expect(src).toMatch(/describe\.skip/);
  });

  test('cleanup-by-prefix is implemented (Employee/Product/Passport/Order)', () => {
    const src = scenarioSource ?? readFileSync(SCENARIO_PATH, 'utf8');
    expect(src).toMatch(/cleanupByPrefix/);
    expect(src).toMatch(/login: \{ startsWith:/);
    expect(src).toMatch(/name: \{ startsWith:/);
  });

  test('tests/package.json exposes the scenario script', () => {
    const pkg = JSON.parse(readFileSync(TESTS_PKG, 'utf8'));
    expect(pkg.scripts).toBeDefined();
    expect(typeof pkg.scripts['test:payroll-scenario']).toBe('string');
    expect(pkg.scripts['test:payroll-scenario']).toMatch(
      /production-payroll-scenario\.integration\.test\.ts/,
    );
  });

  test('root package.json exposes the seed:test-production-payroll-flow alias', () => {
    const pkg = JSON.parse(readFileSync(ROOT_PKG, 'utf8'));
    expect(pkg.scripts).toBeDefined();
    expect(typeof pkg.scripts['seed:test-production-payroll-flow']).toBe('string');
    expect(pkg.scripts['seed:test-production-payroll-flow']).toMatch(
      /test:payroll-scenario/,
    );
  });

  test('docs/test-production-payroll-flow-seed.md exists and is documented', () => {
    const docs = readFileSync(DOCS_PATH, 'utf8');
    expect(docs).toMatch(/RUN_PAYROLL_SCENARIO/);
    expect(docs).toMatch(/TEST_DATABASE_URL/);
    expect(docs).toMatch(/PAYROLL_SCENARIO_CLEANUP_PREFIX/);
    expect(docs).toMatch(/sewing_test/);
  });
});
