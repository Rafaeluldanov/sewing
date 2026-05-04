/**
 * Smoke-тесты hardening-итерации «Автосписание материалов при выдаче
 * кроя — gate по `CompanySettings.autoIssueMaterialsOnCutRelease`»
 * (см. ТЗ, `prisma/schema.prisma::CompanySettings`,
 * `apps/api/src/modules/company-settings/company-settings.service.ts`,
 * `apps/api/src/modules/passports/passports.service.ts`,
 * `docs/current-state.md §«Auto cut issue»`).
 *
 * Тесты статические — анализируют исходники, не поднимают
 * Nest-приложение и не ходят в БД.
 *
 * Покрытие:
 *   1. Prisma schema содержит
 *      `autoIssueMaterialsOnCutRelease Boolean @default(false)` в
 *      модели `CompanySettings`.
 *   2. Существует миграция
 *      `20260607100000_company_settings_auto_issue_materials_flag` с
 *      `ALTER TABLE … ADD COLUMN … BOOLEAN NOT NULL DEFAULT false`.
 *   3. `CompanySettingsService` имеет метод
 *      `getAutoIssueMaterialsOnCutRelease(): Promise<boolean>` и
 *      возвращает `false`, если строки настроек ещё нет.
 *   4. `PassportsService` импортирует `CompanySettingsService`,
 *      инжектит его и читает флаг ДО открытия транзакции, а в обеих
 *      ветках issue (FROM_CELL и ROUTE_WIP) вызывает
 *      `createAutoCutIssueForPassport` под условием `if (autoIssueEnabled)`.
 *   5. `PassportsModule` импортирует `CompanySettingsModule`.
 *   6. Публичный DTO/PATCH `/api/company-settings` это поле НЕ
 *      принимает на этой итерации (UI ещё не утверждён) — поле
 *      `autoIssueMaterialsOnCutRelease` отсутствует в
 *      `UpdateCompanySettingsSchema` и в `CompanySettingsDto`.
 *   7. Сознательные границы MVP: foundation `StockBalance` /
 *      `StockMovement` допустимы, но auto issue их не трогает; нет
 *      `MaterialStockLot` / master-модели `Material` / новых страниц UI.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

const SCHEMA_PATH = 'prisma/schema.prisma';
const MIGRATION_PATH =
  'prisma/migrations/20260607100000_company_settings_auto_issue_materials_flag/migration.sql';
const COMPANY_SETTINGS_SERVICE_PATH =
  'apps/api/src/modules/company-settings/company-settings.service.ts';
const PASSPORTS_SERVICE_PATH =
  'apps/api/src/modules/passports/passports.service.ts';
const PASSPORTS_MODULE_PATH =
  'apps/api/src/modules/passports/passports.module.ts';
const SHARED_COMPANY_SETTINGS_PATH =
  'packages/shared/src/company-settings.ts';

// ---------------------------------------------------------------------------
// 1. Prisma schema: новое поле в CompanySettings
// ---------------------------------------------------------------------------

describe('material-issues auto cut gate — Prisma schema', () => {
  const schema = read(SCHEMA_PATH);

  test('модель CompanySettings содержит autoIssueMaterialsOnCutRelease Boolean default false', () => {
    expect(schema).toMatch(
      /model CompanySettings \{[\s\S]*?autoIssueMaterialsOnCutRelease\s+Boolean\s+@default\(false\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Миграция
// ---------------------------------------------------------------------------

describe('material-issues auto cut gate — migration', () => {
  test('миграция 20260607100000_company_settings_auto_issue_materials_flag существует', () => {
    expect(exists(MIGRATION_PATH)).toBe(true);
  });

  test('миграция добавляет колонку autoIssueMaterialsOnCutRelease BOOLEAN NOT NULL DEFAULT false', () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).toMatch(/ALTER TABLE\s+"CompanySettings"/i);
    expect(sql).toMatch(
      /ADD COLUMN\s+"autoIssueMaterialsOnCutRelease"\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+false/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. CompanySettingsService: getAutoIssueMaterialsOnCutRelease
// ---------------------------------------------------------------------------

describe('material-issues auto cut gate — CompanySettingsService', () => {
  const svc = read(COMPANY_SETTINGS_SERVICE_PATH);

  test('реализован метод getAutoIssueMaterialsOnCutRelease(): Promise<boolean>', () => {
    expect(svc).toMatch(
      /async getAutoIssueMaterialsOnCutRelease\(\)\s*:\s*Promise<boolean>/,
    );
  });

  test('метод возвращает false, если строка CompanySettings отсутствует', () => {
    // Контракт: `row?.autoIssueMaterialsOnCutRelease ?? false`.
    expect(svc).toContain(
      'row?.autoIssueMaterialsOnCutRelease ?? false',
    );
  });

  test('метод НЕ создаёт singleton-строку (нет вызова getOrCreate / create)', () => {
    const block =
      svc.match(
        /async getAutoIssueMaterialsOnCutRelease[\s\S]*?\n  \}\n/,
      )?.[0] ?? '';
    expect(block).not.toMatch(/this\.getOrCreate\(/);
    expect(block).not.toMatch(/companySettings\.create\(/);
    expect(block).not.toMatch(/companySettings\.upsert\(/);
  });
});

// ---------------------------------------------------------------------------
// 4. PassportsService: gate перед createAutoCutIssueForPassport
// ---------------------------------------------------------------------------

describe('material-issues auto cut gate — PassportsService', () => {
  const svc = read(PASSPORTS_SERVICE_PATH);

  test('PassportsService импортирует CompanySettingsService', () => {
    expect(svc).toContain(
      "import { CompanySettingsService } from '../company-settings/company-settings.service.js'",
    );
  });

  test('PassportsService инжектит CompanySettingsService', () => {
    expect(svc).toMatch(
      /private readonly companySettings:\s*CompanySettingsService/,
    );
  });

  test('issueToEmployee читает effective autoIssue через effective resolver', () => {
    // После итерации «Division overrides» hardening-флаг берётся
    // через `CompanySettingsService.getEffectiveMaterialStockSettingsForOrder`
    // — resolver учитывает per-division override и fallback на
    // глобальный `CompanySettings.autoIssueMaterialsOnCutRelease`
    // (см. `docs/current-state.md §«Материалы и склад — division overrides»`).
    const block =
      svc.match(/async issueToEmployee\([\s\S]*?\n  \}\n/)?.[0] ?? '';
    expect(block).toMatch(/getEffectiveMaterialStockSettingsForOrder\(/);
    // Прямой getter больше не дёргаем.
    expect(block).not.toContain(
      'this.companySettings.getAutoIssueMaterialsOnCutRelease()',
    );
    // Имя локальной переменной фиксируем, чтобы next-step
    // (`if (autoIssueEnabled)`) ловился ниже точно.
    expect(block).toMatch(/const\s+autoIssueEnabled\s*=/);
  });

  test('createAutoCutIssueForPassport вызывается ТОЛЬКО под gate-ом', () => {
    const block =
      svc.match(/async issueToEmployee\([\s\S]*?\n  \}\n/)?.[0] ?? '';
    // Считаем именно invocations (с `materialIssues.` слева),
    // чтобы не ловить упоминания в JSDoc-комментариях. Должно
    // быть ровно столько же блоков `if (autoIssueEnabled) { ... }`,
    // содержащих такой invocation.
    const calls = (
      block.match(/this\.materialIssues\.createAutoCutIssueForPassport\s*\(/g) ??
      []
    ).length;
    expect(calls).toBeGreaterThanOrEqual(2);
    const guarded = (
      block.match(
        /if\s*\(\s*autoIssueEnabled\s*\)\s*\{[\s\S]*?this\.materialIssues\.createAutoCutIssueForPassport\s*\([\s\S]*?\}/g,
      ) ?? []
    ).length;
    expect(guarded).toBe(calls);
  });

  test('PassportsModule импортирует CompanySettingsModule', () => {
    const mod = read(PASSPORTS_MODULE_PATH);
    expect(mod).toContain(
      "import { CompanySettingsModule } from '../company-settings/company-settings.module.js'",
    );
    expect(mod).toMatch(/imports:\s*\[[\s\S]*?CompanySettingsModule[\s\S]*?\]/);
  });
});

// ---------------------------------------------------------------------------
// 5. Public DTO отдаёт и принимает поле (UI в /admin/company-settings)
// ---------------------------------------------------------------------------

describe('material-issues auto cut gate — shared DTO boundary', () => {
  const shared = read(SHARED_COMPANY_SETTINGS_PATH);

  test('UpdateCompanySettingsSchema принимает autoIssueMaterialsOnCutRelease', () => {
    const updateSchema =
      shared.match(
        /export const UpdateCompanySettingsSchema[\s\S]*?export type UpdateCompanySettingsDto/,
      )?.[0] ?? '';
    expect(updateSchema).toContain('autoIssueMaterialsOnCutRelease');
  });

  test('CompanySettingsDto содержит autoIssueMaterialsOnCutRelease: boolean', () => {
    const dto =
      shared.match(/export interface CompanySettingsDto[\s\S]*?\n\}/)?.[0] ?? '';
    expect(dto).toMatch(/autoIssueMaterialsOnCutRelease\s*:\s*boolean/);
  });
});

// ---------------------------------------------------------------------------
// 6. MVP-границы: ничего нового сверх требований
// ---------------------------------------------------------------------------

describe('material-issues auto cut gate — MVP boundaries', () => {
  test('есть StockBalance / StockMovement; нет MaterialStockLot', () => {
    const schema = read(SCHEMA_PATH);
    expect(schema).toMatch(/^model\s+StockBalance\b/m);
    expect(schema).toMatch(/^model\s+StockMovement\b/m);
    expect(schema).not.toMatch(/^model\s+MaterialStockLot\b/m);
  });

  test('по-прежнему нет master-модели Material', () => {
    const schema = read(SCHEMA_PATH);
    expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
  });

  test('не создана новая страница для управления флагом', () => {
    expect(
      exists('apps/web/app/admin/company-settings/auto-issue-materials'),
    ).toBe(false);
    expect(
      exists('apps/web/app/admin/material-issues/settings'),
    ).toBe(false);
  });
});
