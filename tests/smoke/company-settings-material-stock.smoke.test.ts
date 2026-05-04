/**
 * Smoke-тесты итерации «UI управления флагами материалов и склада в
 * /admin/company-settings» (см. ТЗ,
 * `packages/shared/src/company-settings.ts`,
 * `apps/api/src/modules/company-settings/*`,
 * `apps/web/app/admin/company-settings/settings-form.tsx`,
 * `apps/web/app/admin/company-settings/actions.ts`,
 * `docs/current-state.md §«Настройки компании»`).
 *
 * Итерация добавляет в существующий экран `/admin/company-settings`
 * блок «Материалы и склад» с двумя переключателями и выставляет уже
 * существующие backend-поля `CompanySettings.autoIssueMaterialsOnCutRelease`
 * / `CompanySettings.allowNegativeMaterialStock` в публичный
 * `CompanySettingsDto` + `UpdateCompanySettingsSchema`.
 *
 * Тесты статические — анализируют исходники, не поднимают Nest и не
 * ходят в БД (integration-покрытие живёт в
 * `tests/integration/material-issues-*`).
 *
 * ТЗ §8 «Tests» — минимальный список покрыт здесь:
 *
 *   1. CompanySettingsDto содержит autoIssueMaterialsOnCutRelease.
 *   2. CompanySettingsDto содержит allowNegativeMaterialStock.
 *   3. UpdateCompanySettingsSchema принимает autoIssueMaterialsOnCutRelease.
 *   4. UpdateCompanySettingsSchema принимает allowNegativeMaterialStock.
 *   5. CompanySettingsService возвращает оба поля в GET (`toDto`).
 *   6. CompanySettingsService принимает оба поля в PATCH (`update`).
 *   7. /admin/company-settings содержит блок «Материалы и склад».
 *   8. UI содержит «Автосписание материалов при выдаче кроя».
 *   9. UI содержит «Разрешить отрицательные остатки материалов».
 *  10. UI содержит предупреждение про блокировку проведения расхода.
 *  11. UI не создаёт новую страницу /admin/stock-settings.
 *  12. UI не добавляет настройки в /admin/warehouses (edit-form).
 *  13. Sidebar не получает новый пункт.
 *  14. StockService / MaterialIssuesService / PassportsService не
 *      меняются на этой итерации (smoke-проверка отсутствия диффа —
 *      по факту ищем backend-использования флагов в unchanged
 *      сигнатурах).
 *  15. Prisma schema не меняется (модель `CompanySettings` по-прежнему
 *      содержит ровно два flag-поля с теми же дефолтами).
 *  16. Новые роли WAREHOUSE_MANAGER / PURCHASER / ACCOUNTANT не
 *      добавляются.
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

const SHARED_DTO_PATH = 'packages/shared/src/company-settings.ts';
const COMPANY_SETTINGS_SERVICE_PATH =
  'apps/api/src/modules/company-settings/company-settings.service.ts';
const COMPANY_SETTINGS_CONTROLLER_PATH =
  'apps/api/src/modules/company-settings/company-settings.controller.ts';
const SETTINGS_PAGE_PATH = 'apps/web/app/admin/company-settings/page.tsx';
const SETTINGS_FORM_PATH =
  'apps/web/app/admin/company-settings/settings-form.tsx';
const SETTINGS_ACTIONS_PATH =
  'apps/web/app/admin/company-settings/actions.ts';
const SIDEBAR_PATH = 'apps/web/components/admin-sidebar.tsx';
const SCHEMA_PATH = 'prisma/schema.prisma';
const STOCK_SERVICE_PATH = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE_PATH =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const PASSPORTS_SERVICE_PATH =
  'apps/api/src/modules/passports/passports.service.ts';
const WAREHOUSES_EDIT_FORM_PATH =
  'apps/web/app/admin/warehouses/[id]/edit-form.tsx';

// ---------------------------------------------------------------------------
// 1-4. Shared DTO + Zod
// ---------------------------------------------------------------------------

describe('company-settings material/stock UI — shared DTO', () => {
  const src = read(SHARED_DTO_PATH);

  test('CompanySettingsDto содержит autoIssueMaterialsOnCutRelease: boolean', () => {
    const dto =
      src.match(/export interface CompanySettingsDto[\s\S]*?\n\}/)?.[0] ?? '';
    expect(dto).toMatch(/autoIssueMaterialsOnCutRelease\s*:\s*boolean/);
  });

  test('CompanySettingsDto содержит allowNegativeMaterialStock: boolean', () => {
    const dto =
      src.match(/export interface CompanySettingsDto[\s\S]*?\n\}/)?.[0] ?? '';
    expect(dto).toMatch(/allowNegativeMaterialStock\s*:\s*boolean/);
  });

  test('UpdateCompanySettingsSchema принимает autoIssueMaterialsOnCutRelease', () => {
    const schemaBlock =
      src.match(
        /export const UpdateCompanySettingsSchema[\s\S]*?export type UpdateCompanySettingsDto/,
      )?.[0] ?? '';
    expect(schemaBlock).toContain('autoIssueMaterialsOnCutRelease');
  });

  test('UpdateCompanySettingsSchema принимает allowNegativeMaterialStock', () => {
    const schemaBlock =
      src.match(
        /export const UpdateCompanySettingsSchema[\s\S]*?export type UpdateCompanySettingsDto/,
      )?.[0] ?? '';
    expect(schemaBlock).toContain('allowNegativeMaterialStock');
  });

  test('оба поля объявлены как optional boolean (PATCH не трогает, если undefined)', () => {
    expect(src).toMatch(
      /AutoIssueMaterialsOnCutReleaseField\s*=\s*z\.boolean\(\)\.optional\(\)/,
    );
    expect(src).toMatch(
      /AllowNegativeMaterialStockField\s*=\s*z\.boolean\(\)\.optional\(\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5-6. Backend service + controller
// ---------------------------------------------------------------------------

describe('company-settings material/stock UI — backend GET/PATCH', () => {
  const svc = read(COMPANY_SETTINGS_SERVICE_PATH);
  const ctl = read(COMPANY_SETTINGS_CONTROLLER_PATH);

  test('toDto возвращает оба флага из строки', () => {
    const toDto = svc.match(/function toDto[\s\S]*?\n\}/)?.[0] ?? '';
    expect(toDto).toContain(
      'autoIssueMaterialsOnCutRelease: c.autoIssueMaterialsOnCutRelease',
    );
    expect(toDto).toContain(
      'allowNegativeMaterialStock: c.allowNegativeMaterialStock',
    );
  });

  test('update() знает про boolean-поля', () => {
    // Отдельный массив boolean-полей: дефолт `?? null` из строковой
    // ветки ломал бы NOT NULL-колонку.
    expect(svc).toMatch(/UPDATABLE_BOOLEAN_FIELDS\s*=\s*\[/);
    expect(svc).toMatch(
      /UPDATABLE_BOOLEAN_FIELDS[\s\S]*?autoIssueMaterialsOnCutRelease[\s\S]*?allowNegativeMaterialStock/,
    );
  });

  test('get() идёт через getOrCreate — GET всегда возвращает defaults при отсутствии строки', () => {
    // Дефолты лежат в Prisma (`@default(false)` / `@default(true)`);
    // `getOrCreate` идемпотентно создаёт singleton-row → `toDto`
    // всегда отдаёт валидные boolean-ы. Мы не вводим ещё один
    // источник истины в DTO-слое.
    const getFn = svc.match(/async get\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(getFn).toMatch(/this\.getOrCreate\(\)/);
    expect(getFn).toMatch(/toDto/);
  });

  test('приватные getter-ы сохраняют существующий fallback (false / true)', () => {
    // Контракт не изменился: приватные геттеры живут рядом и не
    // ходят через `getOrCreate` — они используются из горячего
    // flow (PassportsService / StockService).
    expect(svc).toMatch(
      /getAutoIssueMaterialsOnCutRelease[\s\S]*?autoIssueMaterialsOnCutRelease\s*\?\?\s*false/,
    );
    expect(svc).toMatch(
      /getAllowNegativeMaterialStock[\s\S]*?allowNegativeMaterialStock\s*\?\?\s*true/,
    );
  });

  test('PATCH /api/company-settings идёт через UpdateCompanySettingsSchema (новый endpoint не заводим)', () => {
    expect(ctl).toContain(
      "import {\n  UpdateCompanySettingsSchema,\n  type UpdateCompanySettingsDto,\n} from '@sewing/shared/company-settings'",
    );
    // Ровно один Patch-роут — на singleton.
    const patchCount = (ctl.match(/@Patch\(\)/g) ?? []).length;
    expect(patchCount).toBe(1);
  });

  test('RBAC не меняется: @Roles(SHOP_MANAGER, ADMIN)', () => {
    expect(ctl).toMatch(/@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/);
    // Никаких новых warehouse-ролей в контроллере.
    expect(ctl).not.toMatch(/WAREHOUSE_MANAGER|PURCHASER|ACCOUNTANT/);
  });
});

// ---------------------------------------------------------------------------
// 7-10. UI: блок «Материалы и склад»
// ---------------------------------------------------------------------------

describe('company-settings material/stock UI — форма настроек', () => {
  const form = read(SETTINGS_FORM_PATH);
  const actions = read(SETTINGS_ACTIONS_PATH);
  const page = read(SETTINGS_PAGE_PATH);

  test('/admin/company-settings по-прежнему единая страница (никаких новых route-ов)', () => {
    // Страница существует ровно в старом месте и рендерит
    // `CompanySettingsForm` (см. page.tsx).
    expect(page).toMatch(/<CompanySettingsForm\s/);
    // Новых страниц с отдельным экраном настроек склада нет.
    expect(exists('apps/web/app/admin/stock-settings/page.tsx')).toBe(false);
    expect(exists('apps/web/app/admin/stock-settings')).toBe(false);
    expect(
      exists('apps/web/app/admin/company-settings/material-stock/page.tsx'),
    ).toBe(false);
  });

  test('блок «Материалы и склад» рендерится в settings-form.tsx', () => {
    expect(form).toContain('Материалы и склад');
  });

  test('label «Автосписание материалов при выдаче кроя» + input name="autoIssueMaterialsOnCutRelease"', () => {
    expect(form).toContain('Автосписание материалов при выдаче кроя');
    expect(form).toMatch(
      /name="autoIssueMaterialsOnCutRelease"[\s\S]*?defaultChecked=\{settings\.autoIssueMaterialsOnCutRelease\}/,
    );
  });

  test('label «Разрешить отрицательные остатки материалов» + input name="allowNegativeMaterialStock"', () => {
    expect(form).toContain('Разрешить отрицательные остатки материалов');
    expect(form).toMatch(
      /name="allowNegativeMaterialStock"[\s\S]*?defaultChecked=\{settings\.allowNegativeMaterialStock\}/,
    );
  });

  test('help-text про плановую потребность (autoIssueMaterialsOnCutRelease)', () => {
    expect(form).toMatch(
      /Использует плановую потребность заказа и распределяет расход\s+пропорционально количеству паспорта\./,
    );
  });

  test('предупреждение про блокировку проведения расхода (allowNegativeMaterialStock = false)', () => {
    expect(form).toMatch(/проведение расхода материалов будет заблокировано/);
    expect(form).toMatch(/выдача кроя\s+тоже может быть заблокирована/);
  });

  test('server action мапит чекбоксы в boolean через hidden-маркеры', () => {
    expect(actions).toMatch(/SETTINGS_BOOLEAN_FIELDS/);
    expect(actions).toMatch(
      /SETTINGS_BOOLEAN_FIELDS[\s\S]*?autoIssueMaterialsOnCutRelease[\s\S]*?allowNegativeMaterialStock/,
    );
    // Hidden-маркер должен присутствовать в форме для каждого поля.
    expect(form).toMatch(/name="autoIssueMaterialsOnCutRelease__present"/);
    expect(form).toMatch(/name="allowNegativeMaterialStock__present"/);
  });

  test('одна форма с одной кнопкой Save — не заводим separate API endpoint', () => {
    // Форма сохраняется через `updateCompanySettingsAction` —
    // server action уже существовал для реквизитов.
    expect(form).toMatch(/updateCompanySettingsAction/);
    // Никакого нового server action специально под флаги нет.
    expect(actions).not.toMatch(/updateMaterialStockFlagsAction/);
    expect(actions).not.toMatch(/updateStockSettingsAction/);
  });
});

// ---------------------------------------------------------------------------
// 11-12. UI boundaries: нет новых страниц и нет записи в /admin/warehouses
// ---------------------------------------------------------------------------

describe('company-settings material/stock UI — boundaries', () => {
  test('нет новой страницы /admin/stock-settings', () => {
    expect(exists('apps/web/app/admin/stock-settings/page.tsx')).toBe(false);
    expect(exists('apps/web/app/admin/stock-settings')).toBe(false);
  });

  test('флаги не появляются в форме склада /admin/warehouses/[id]', () => {
    if (!exists(WAREHOUSES_EDIT_FORM_PATH)) return;
    const src = read(WAREHOUSES_EDIT_FORM_PATH);
    expect(src).not.toMatch(/autoIssueMaterialsOnCutRelease/);
    expect(src).not.toMatch(/allowNegativeMaterialStock/);
  });
});

// ---------------------------------------------------------------------------
// 13. Sidebar не получает новый пункт
// ---------------------------------------------------------------------------

describe('company-settings material/stock UI — sidebar', () => {
  const src = read(SIDEBAR_PATH);

  test('в sidebar нет новых пунктов «Материалы и склад» / «Stock settings»', () => {
    expect(src).not.toMatch(/Материалы и склад/);
    expect(src).not.toMatch(/stock-settings/);
    // Ссылка на /admin/company-settings уже существует — её не
    // дублируем и не переименовываем.
    const companyLinks = (
      src.match(/href="\/admin\/company-settings(?:"|\/)/g) ?? []
    ).length;
    expect(companyLinks).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 14. Business services не меняются: флаги по-прежнему работают
//     через те же backend-точки (smoke-проверка, не diff).
// ---------------------------------------------------------------------------

describe('company-settings material/stock UI — backend flow не переписывается', () => {
  test('StockService всё так же принимает allowNegativeStock', () => {
    const src = read(STOCK_SERVICE_PATH);
    expect(src).toMatch(/allowNegativeStock\?\s*:\s*boolean/);
    expect(src).toMatch(/MaterialStockInsufficientException/);
  });

  test('MaterialIssuesService читает effective material stock settings resolver', () => {
    // После division-overrides итерации hardening-флаг берётся через
    // `getEffectiveMaterialStockSettingsForOrder{InTx}` (см.
    // `apps/api/src/modules/company-settings/company-settings.service.ts`,
    // `docs/current-state.md §«Материалы и склад — division overrides»`).
    // Прямой getter `getAllowNegativeMaterialStock` сервис больше
    // не дёргает — effective resolver сам учитывает division override
    // и fallback на глобальный `CompanySettings.allowNegativeMaterialStock`.
    const src = read(MATERIAL_ISSUES_SERVICE_PATH);
    expect(src).toMatch(
      /getEffectiveMaterialStockSettingsForOrder(?:InTx)?\(/,
    );
    expect(src).not.toMatch(
      /this\.companySettings\.getAllowNegativeMaterialStock\(/,
    );
  });

  test('PassportsService читает effective auto-issue через resolver', () => {
    // Аналогично: `issueToEmployee` учитывает division override
    // `CompanyDivision.autoIssueMaterialsOnCutReleaseOverride`.
    const src = read(PASSPORTS_SERVICE_PATH);
    expect(src).toMatch(
      /getEffectiveMaterialStockSettingsForOrder(?:InTx)?\(/,
    );
    expect(src).not.toMatch(
      /this\.companySettings\.getAutoIssueMaterialsOnCutRelease\(/,
    );
  });
});

// ---------------------------------------------------------------------------
// 15-16. Prisma schema + роли не меняются
// ---------------------------------------------------------------------------

describe('company-settings material/stock UI — schema + RBAC без изменений', () => {
  const schema = read(SCHEMA_PATH);

  test('CompanySettings по-прежнему содержит ровно два flag-поля с прежними дефолтами', () => {
    const model =
      schema.match(/model\s+CompanySettings\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(model).toMatch(
      /autoIssueMaterialsOnCutRelease\s+Boolean\s+@default\(false\)/,
    );
    expect(model).toMatch(
      /allowNegativeMaterialStock\s+Boolean\s+@default\(true\)/,
    );
  });

  test('никаких новых master-моделей / лотов материалов', () => {
    expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
    expect(schema).not.toMatch(/^model\s+MaterialStockLot\b/m);
  });

  test('UserRole без warehouse-ролей', () => {
    const roleEnum = schema.match(/enum\s+UserRole\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(roleEnum).not.toMatch(/\bWAREHOUSE_MANAGER\b/);
    expect(roleEnum).not.toMatch(/\bPURCHASER\b/);
    expect(roleEnum).not.toMatch(/\bACCOUNTANT\b/);
  });
});
