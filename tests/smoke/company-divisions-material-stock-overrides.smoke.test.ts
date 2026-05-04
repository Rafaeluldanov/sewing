/**
 * Smoke-тесты итерации «Division overrides для флагов блока „Материалы
 * и склад“» (см. ТЗ,
 * `prisma/schema.prisma::CompanyDivision`,
 * `packages/shared/src/company-divisions.ts`,
 * `apps/api/src/modules/company-settings/*`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `apps/api/src/modules/stock/stock.service.ts`,
 * `apps/api/src/modules/passports/passports.service.ts`,
 * `apps/web/app/admin/company-settings/*`,
 * `docs/current-state.md §«Материалы и склад — division overrides»`).
 *
 * Итерация добавляет в `CompanyDivision` два nullable-override-поля
 * (`autoIssueMaterialsOnCutReleaseOverride` /
 * `allowNegativeMaterialStockOverride`) и effective-resolver
 * `CompanySettingsService.getEffectiveMaterialStockSettingsForOrder{InTx}`,
 * который бизнес-flow (material issue / auto cut issue / stock
 * adjustment / issue to employee) используют вместо прямых getter-ов
 * глобальных флагов. UI `/admin/company-settings` получает подраздел
 * «Настройки по подразделениям» с select-ами (три значения —
 * inherit / true / false).
 *
 * Тесты статические — анализируют исходники / миграцию.
 *
 * Покрытие по ТЗ «Tests — Smoke/static»:
 *
 *   1. CompanyDivision schema содержит nullable override fields.
 *   2. CompanyDivision DTO содержит override fields.
 *   3. UpdateCompanyDivisionSchema принимает boolean / null.
 *   4. CompanySettingsService содержит effective settings resolver.
 *   5. MaterialIssuesService.post использует effective settings.
 *   6. createAutoCutIssueForPassport использует effective settings.
 *   7. PassportsService.issueToEmployee использует effective autoIssue.
 *   8. StockService.createAdjustment использует effective allowNegative.
 *   9. /admin/company-settings содержит «Настройки по подразделениям».
 *  10. UI использует select, а не switch, для division overrides.
 *  11. UI содержит labels «Наследовать настройку компании».
 *  12. Не создан новый route.
 *  13. Не добавлен sidebar item.
 *  14. Не добавлены WAREHOUSE_MANAGER / PURCHASER / ACCOUNTANT.
 *  15. Не изменён PurchaseReceipt cancel.
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
const SHARED_PATH = 'packages/shared/src/company-divisions.ts';
const COMPANY_SETTINGS_SERVICE_PATH =
  'apps/api/src/modules/company-settings/company-settings.service.ts';
const COMPANY_DIVISIONS_SERVICE_PATH =
  'apps/api/src/modules/company-settings/company-divisions.service.ts';
const MATERIAL_ISSUES_SERVICE_PATH =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const STOCK_SERVICE_PATH = 'apps/api/src/modules/stock/stock.service.ts';
const PASSPORTS_SERVICE_PATH =
  'apps/api/src/modules/passports/passports.service.ts';
const PURCHASE_RECEIPTS_SERVICE_PATH =
  'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts';
const SETTINGS_PAGE_PATH = 'apps/web/app/admin/company-settings/page.tsx';
const OVERRIDES_SECTION_PATH =
  'apps/web/app/admin/company-settings/material-stock-division-overrides-section.tsx';
const SETTINGS_ACTIONS_PATH =
  'apps/web/app/admin/company-settings/actions.ts';
const SETTINGS_FORM_PATH =
  'apps/web/app/admin/company-settings/settings-form.tsx';
const DIVISIONS_SECTION_PATH =
  'apps/web/app/admin/company-settings/divisions-section.tsx';
const SIDEBAR_PATH = 'apps/web/components/admin-sidebar.tsx';
const OVERRIDES_MIGRATION_PATH =
  'prisma/migrations/20260611100000_company_division_material_stock_overrides/migration.sql';

// ---------------------------------------------------------------------------
// 1. Prisma schema: nullable override fields в CompanyDivision
// ---------------------------------------------------------------------------

describe('CompanyDivision — nullable override fields', () => {
  const schema = read(SCHEMA_PATH);
  const model =
    schema.match(/model\s+CompanyDivision\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  test('autoIssueMaterialsOnCutReleaseOverride — Boolean? без @default', () => {
    expect(model).toMatch(
      /autoIssueMaterialsOnCutReleaseOverride\s+Boolean\?\s*$/m,
    );
    expect(model).not.toMatch(
      /autoIssueMaterialsOnCutReleaseOverride\s+Boolean\?\s+@default/,
    );
  });

  test('allowNegativeMaterialStockOverride — Boolean? без @default', () => {
    expect(model).toMatch(
      /allowNegativeMaterialStockOverride\s+Boolean\?\s*$/m,
    );
    expect(model).not.toMatch(
      /allowNegativeMaterialStockOverride\s+Boolean\?\s+@default/,
    );
  });

  test('миграция добавляет ровно две nullable-колонки', () => {
    expect(exists(OVERRIDES_MIGRATION_PATH)).toBe(true);
    const sql = read(OVERRIDES_MIGRATION_PATH);
    expect(sql).toMatch(/ALTER TABLE "CompanyDivision"/);
    expect(sql).toMatch(
      /ADD COLUMN "autoIssueMaterialsOnCutReleaseOverride"\s+BOOLEAN(?!\s+NOT NULL)/,
    );
    expect(sql).toMatch(
      /ADD COLUMN "allowNegativeMaterialStockOverride"\s+BOOLEAN(?!\s+NOT NULL)/,
    );
    // NOT NULL / DEFAULT сознательно не ставим — `null` означает
    // «наследовать настройку компании».
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).not.toMatch(/DEFAULT\s+(true|false)/i);
  });
});

// ---------------------------------------------------------------------------
// 2-3. Shared DTO / Zod schema
// ---------------------------------------------------------------------------

describe('CompanyDivision — shared DTO + Zod', () => {
  const src = read(SHARED_PATH);

  test('CompanyDivisionDto содержит оба override поля (boolean | null)', () => {
    const dto =
      src.match(/export interface CompanyDivisionDto[\s\S]*?\n\}/)?.[0] ?? '';
    expect(dto).toMatch(
      /autoIssueMaterialsOnCutReleaseOverride:\s*boolean\s*\|\s*null/,
    );
    expect(dto).toMatch(
      /allowNegativeMaterialStockOverride:\s*boolean\s*\|\s*null/,
    );
  });

  test('UpdateCompanyDivisionSchema принимает override fields как nullable optional', () => {
    expect(src).toMatch(
      /OverrideBooleanField\s*=\s*z\.boolean\(\)\.nullable\(\)\.optional\(\)/,
    );
    const schemaBlock =
      src.match(
        /export const UpdateCompanyDivisionSchema[\s\S]*?export type UpdateCompanyDivisionDto/,
      )?.[0] ?? '';
    expect(schemaBlock).toContain('autoIssueMaterialsOnCutReleaseOverride');
    expect(schemaBlock).toContain('allowNegativeMaterialStockOverride');
  });

  test('CreateCompanyDivisionSchema тоже принимает override fields', () => {
    const schemaBlock =
      src.match(
        /export const CreateCompanyDivisionSchema[\s\S]*?export type CreateCompanyDivisionDto/,
      )?.[0] ?? '';
    expect(schemaBlock).toContain('autoIssueMaterialsOnCutReleaseOverride');
    expect(schemaBlock).toContain('allowNegativeMaterialStockOverride');
  });

  test('refine() в UpdateCompanyDivisionSchema пропускает override-only PATCH', () => {
    // Иначе PATCH-only-override валится на «Нечего обновлять».
    const schemaBlock =
      src.match(
        /export const UpdateCompanyDivisionSchema[\s\S]*?export type UpdateCompanyDivisionDto/,
      )?.[0] ?? '';
    expect(schemaBlock).toMatch(
      /autoIssueMaterialsOnCutReleaseOverride\s*!==\s*undefined/,
    );
    expect(schemaBlock).toMatch(
      /allowNegativeMaterialStockOverride\s*!==\s*undefined/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. CompanySettingsService: effective resolver
// ---------------------------------------------------------------------------

describe('CompanySettingsService — effective resolver', () => {
  const src = read(COMPANY_SETTINGS_SERVICE_PATH);

  test('getEffectiveMaterialStockSettingsForOrder + InTx экспортированы', () => {
    expect(src).toMatch(
      /async getEffectiveMaterialStockSettingsForOrder\(/,
    );
    expect(src).toMatch(
      /async getEffectiveMaterialStockSettingsForOrderInTx\(/,
    );
  });

  test('resolver считает порядок division.override ?? companySettings ?? default', () => {
    // Проверяем явные ?? цепочки вместо тонкой логики.
    expect(src).toMatch(
      /autoIssueOverride\s*\?\?\s*companyAutoIssue/,
    );
    expect(src).toMatch(
      /allowNegativeOverride\s*\?\?\s*companyAllowNegative/,
    );
    // Defaults при отсутствии singleton-row: false / true.
    expect(src).toMatch(/autoIssueMaterialsOnCutRelease\s*\?\?\s*false/);
    expect(src).toMatch(/allowNegativeMaterialStock\s*\?\?\s*true/);
  });

  test('resolver read-only: не пишет settings / divisions (без singleton-getOrCreate в resolver)', () => {
    // В resolver'е ссылок на `companySettings.create` или
    // `companyDivision.update` быть не должно.
    const resolverBlock =
      src.match(
        /private async computeEffectiveMaterialStockSettingsForOrder[\s\S]*?\n  \}/,
      )?.[0] ?? '';
    expect(resolverBlock.length).toBeGreaterThan(0);
    expect(resolverBlock).not.toMatch(
      /this\.prisma\.companySettings\.create/,
    );
    expect(resolverBlock).not.toMatch(/\.update\(/);
  });

  test('источник отражён в response.source (DIVISION | COMPANY_DEFAULT)', () => {
    expect(src).toMatch(/COMPANY_DEFAULT/);
    expect(src).toMatch(/DIVISION/);
    expect(src).toMatch(/EffectiveMaterialStockSettings/);
  });
});

// ---------------------------------------------------------------------------
// 5-6. MaterialIssuesService: post и auto cut issue используют effective
// ---------------------------------------------------------------------------

describe('MaterialIssuesService — effective settings', () => {
  const src = read(MATERIAL_ISSUES_SERVICE_PATH);

  test('post() читает effective settings по orderId, а не глобальный флаг', () => {
    const postBlock =
      src.match(
        /async post\([\s\S]*?recomputedTotal[\s\S]*?return toDetail\(updated\);[\s\S]*?\n  \}/,
      )?.[0] ?? '';
    expect(postBlock).toMatch(
      /getEffectiveMaterialStockSettingsForOrder\(/,
    );
    // prev flag getter здесь быть не должно (hardening итерации уже не актуально).
    expect(postBlock).not.toMatch(/getAllowNegativeMaterialStock\(/);
  });

  test('createAutoCutIssueForPassport читает effective settings через tx', () => {
    const autoBlock =
      src.match(
        /async createAutoCutIssueForPassport[\s\S]*?return \{\s*created:\s*true[\s\S]*?\n  \}/,
      )?.[0] ?? '';
    expect(autoBlock).toMatch(
      /getEffectiveMaterialStockSettingsForOrderInTx\(/,
    );
    expect(autoBlock).not.toMatch(/getAllowNegativeMaterialStock\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. PassportsService.issueToEmployee использует effective autoIssue
// ---------------------------------------------------------------------------

describe('PassportsService.issueToEmployee — effective autoIssue', () => {
  const src = read(PASSPORTS_SERVICE_PATH);

  test('issueToEmployee достаёт autoIssue через effective resolver', () => {
    expect(src).toMatch(
      /getEffectiveMaterialStockSettingsForOrder\(/,
    );
    expect(src).not.toMatch(
      /this\.companySettings\.getAutoIssueMaterialsOnCutRelease\(/,
    );
  });

  test('createAutoCutIssueForPassport вызывается только при effective autoIssue = true', () => {
    // Переменная autoIssueEnabled должна всё ещё существовать и
    // использоваться как гейт.
    expect(src).toMatch(/if \(autoIssueEnabled\)/);
    expect(src).toMatch(/createAutoCutIssueForPassport\(/);
  });
});

// ---------------------------------------------------------------------------
// 8. StockService.createAdjustment использует effective allowNegative
// ---------------------------------------------------------------------------

describe('StockService.createAdjustment — effective allowNegative', () => {
  const src = read(STOCK_SERVICE_PATH);

  test('createAdjustment резолвит allowNegative через effective resolver', () => {
    const block =
      src.match(
        /async createAdjustment\([\s\S]*?return toStockMovementListItem\(detail\);[\s\S]*?\n  \}/,
      )?.[0] ?? '';
    // Внутри createAdjustment не дёргаем global getter напрямую —
    // вызов через helper resolveAdjustmentAllowNegative, который
    // ходит в effective resolver.
    expect(block).toMatch(/resolveAdjustmentAllowNegative\(/);
  });

  test('resolveAdjustmentAllowNegative использует effective resolver', () => {
    const helperBlock =
      src.match(
        /private async resolveAdjustmentAllowNegative[\s\S]*?\n  \}/,
      )?.[0] ?? '';
    expect(helperBlock.length).toBeGreaterThan(0);
    expect(helperBlock).toMatch(
      /getEffectiveMaterialStockSettingsForOrder\(/,
    );
    // Fallback на глобальный флаг при отсутствии orderId.
    expect(helperBlock).toMatch(/getAllowNegativeMaterialStock\(/);
  });

  test('IN-корректировка не зависит от effective allowNegative', () => {
    // IN ветка форсит allowNegativeStock: true — это сохраняется и
    // после division overrides, флаг на IN никогда не блокирует.
    expect(src).toMatch(/allowNegativeStock:\s*isIn\s*\?\s*true\s*:\s*allowNegativeStock/);
  });
});

// ---------------------------------------------------------------------------
// 9-11. UI /admin/company-settings — подраздел и select
// ---------------------------------------------------------------------------

describe('/admin/company-settings — подраздел «Настройки по подразделениям»', () => {
  test('section component существует и рендерится на page', () => {
    expect(exists(OVERRIDES_SECTION_PATH)).toBe(true);
    const page = read(SETTINGS_PAGE_PATH);
    expect(page).toMatch(/<MaterialStockDivisionOverridesSection\s/);
    expect(page).toContain('material-stock-division-overrides-section');
  });

  test('section содержит заголовок «Настройки по подразделениям»', () => {
    const src = read(OVERRIDES_SECTION_PATH);
    expect(src).toContain('Настройки по подразделениям');
  });

  test('UI использует select с тремя значениями, а не switch/checkbox', () => {
    const src = read(OVERRIDES_SECTION_PATH);
    // Три literal-значения option-ов.
    expect(src).toMatch(/DIVISION_OVERRIDE_INHERIT_VALUE\s*=\s*'inherit'/);
    expect(src).toMatch(/DIVISION_OVERRIDE_TRUE_VALUE\s*=\s*'true'/);
    expect(src).toMatch(/DIVISION_OVERRIDE_FALSE_VALUE\s*=\s*'false'/);
    // select-элементы должны существовать.
    expect((src.match(/<select\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // switch / input type=checkbox для override НЕ используем —
    // нужно третье состояние «наследовать».
    expect(src).not.toMatch(
      /name="autoIssueMaterialsOnCutReleaseOverride"[\s\S]{0,80}type="checkbox"/,
    );
    expect(src).not.toMatch(
      /name="allowNegativeMaterialStockOverride"[\s\S]{0,80}type="checkbox"/,
    );
  });

  test('UI содержит label «Наследовать настройку компании»', () => {
    const src = read(OVERRIDES_SECTION_PATH);
    // Повторяется у обоих select'ов.
    const count = (src.match(/Наследовать настройку компании/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('UI различает autoIssue («Включено/Выключено») и allowNegative («Разрешены/Запрещены»)', () => {
    const src = read(OVERRIDES_SECTION_PATH);
    expect(src).toContain('Включено');
    expect(src).toContain('Выключено');
    expect(src).toContain('Разрешены');
    expect(src).toContain('Запрещены');
  });

  test('пустое состояние: «Подразделения ещё не созданы. Используются настройки компании.»', () => {
    const src = read(OVERRIDES_SECTION_PATH);
    expect(src).toContain(
      'Подразделения ещё не созданы. Используются настройки компании.',
    );
  });

  test('effective hint «Сейчас: …» считается в UI', () => {
    const src = read(OVERRIDES_SECTION_PATH);
    expect(src).toMatch(/Сейчас:/);
  });

  test('глобальные два флага остаются в settings-form («Материалы и склад»)', () => {
    const src = read(SETTINGS_FORM_PATH);
    expect(src).toContain('Материалы и склад');
    expect(src).toMatch(/name="autoIssueMaterialsOnCutRelease"/);
    expect(src).toMatch(/name="allowNegativeMaterialStock"/);
  });

  test('server action для overrides использует existing /api/company-divisions/:id (без нового endpoint)', () => {
    const actions = read(SETTINGS_ACTIONS_PATH);
    expect(actions).toMatch(/updateCompanyDivisionOverridesAction/);
    expect(actions).toMatch(/updateCompanyDivision\(\s*divisionId/);
    // Новый endpoint не заводим.
    expect(actions).not.toMatch(/\/company-divisions\/[^'"`]*overrides/);
  });
});

// ---------------------------------------------------------------------------
// 12-13. Никаких новых маршрутов / пунктов sidebar / новых разделов
// ---------------------------------------------------------------------------

describe('UI boundaries — никакой новой страницы или пункта меню', () => {
  test('не появилось новой страницы /admin/stock-settings', () => {
    expect(exists('apps/web/app/admin/stock-settings')).toBe(false);
    expect(exists('apps/web/app/admin/company-divisions')).toBe(false);
    expect(
      exists(
        'apps/web/app/admin/company-settings/material-stock-overrides/page.tsx',
      ),
    ).toBe(false);
  });

  test('sidebar не получил новых пунктов', () => {
    const src = read(SIDEBAR_PATH);
    expect(src).not.toMatch(/Настройки по подразделениям/);
    expect(src).not.toMatch(/company-divisions/);
    expect(src).not.toMatch(/stock-settings/);
  });

  test('UI раздела «Склады» не получил настройки материалов', () => {
    const editFormPath = 'apps/web/app/admin/warehouses/[id]/edit-form.tsx';
    if (!exists(editFormPath)) return;
    const src = read(editFormPath);
    expect(src).not.toMatch(/autoIssueMaterialsOnCutReleaseOverride/);
    expect(src).not.toMatch(/allowNegativeMaterialStockOverride/);
  });

  test('DivisionsSection (полный CRUD) не перенесён и не переименован', () => {
    expect(exists(DIVISIONS_SECTION_PATH)).toBe(true);
    const page = read(SETTINGS_PAGE_PATH);
    expect(page).toMatch(/<DivisionsSection\s/);
  });
});

// ---------------------------------------------------------------------------
// 14. Не добавлены новые RBAC-роли
// ---------------------------------------------------------------------------

describe('RBAC — никаких новых warehouse-ролей', () => {
  test('UserRole enum не содержит WAREHOUSE_MANAGER / PURCHASER / ACCOUNTANT', () => {
    const schema = read(SCHEMA_PATH);
    const roleEnum = schema.match(/enum\s+UserRole\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(roleEnum).not.toMatch(/\bWAREHOUSE_MANAGER\b/);
    expect(roleEnum).not.toMatch(/\bPURCHASER\b/);
    expect(roleEnum).not.toMatch(/\bACCOUNTANT\b/);
  });

  test('CompanyDivisionsService / controller не вводят warehouse-роли', () => {
    const svc = read(COMPANY_DIVISIONS_SERVICE_PATH);
    expect(svc).not.toMatch(/WAREHOUSE_MANAGER|PURCHASER|ACCOUNTANT/);
  });
});

// ---------------------------------------------------------------------------
// 15. PurchaseReceipt cancel не зависит от division settings
// ---------------------------------------------------------------------------

describe('PurchaseReceipt cancel — permissive (без division overrides)', () => {
  test('PurchaseReceiptsService не читает effective settings (cancel permissive)', () => {
    const src = read(PURCHASE_RECEIPTS_SERVICE_PATH);
    expect(src).not.toMatch(
      /getEffectiveMaterialStockSettingsForOrder/,
    );
    // Hardening-флаг getter здесь тоже не нужен: reversePurchaseReceiptInTx
    // не передаёт `allowNegativeStock: false`, значит остаётся
    // permissive (см. stock.service.ts::reversePurchaseReceiptInTx).
    expect(src).not.toMatch(/getAllowNegativeMaterialStock/);
  });

  test('StockService.reversePurchaseReceiptInTx не передаёт allowNegativeStock: false', () => {
    const src = read(STOCK_SERVICE_PATH);
    const block =
      src.match(
        /async reversePurchaseReceiptLineInTx[\s\S]*?return movement;[\s\S]*?\n  \}/,
      )?.[0] ?? '';
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/allowNegativeStock:\s*false/);
  });
});
