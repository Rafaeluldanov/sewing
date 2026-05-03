/**
 * Smoke-тесты hardening-итерации «Запрет отрицательных остатков
 * материалов при списании» (см.
 * `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
 * `apps/api/src/modules/company-settings/company-settings.service.ts::getAllowNegativeMaterialStock`,
 * `apps/api/src/modules/stock/stock.service.ts::applyMovementInTx`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `apps/api/src/common/errors.ts::MaterialStockInsufficientException`,
 * `docs/current-state.md §«Подключение расхода материалов к складу»`).
 *
 * Проверки исключительно статические — анализируют исходники, миграцию
 * и docs; не поднимают Nest и не ходят в БД (это делают
 * `tests/integration/material-issues-stock.test.ts` и
 * `tests/integration/material-issues-auto-cut.test.ts`). Цель —
 * поймать регресс контракта на ранних стадиях CI.
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
  'prisma/migrations/20260610100000_company_settings_allow_negative_material_stock/migration.sql';
const COMPANY_SETTINGS_SERVICE_PATH =
  'apps/api/src/modules/company-settings/company-settings.service.ts';
const COMPANY_SETTINGS_DTO_PATH =
  'packages/shared/src/company-settings.ts';
const ERRORS_PATH = 'apps/api/src/common/errors.ts';
const STOCK_SERVICE_PATH = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE_PATH =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const MATERIAL_ISSUES_MODULE_PATH =
  'apps/api/src/modules/material-issues/material-issues.module.ts';
const PURCHASE_RECEIPTS_SERVICE_PATH =
  'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts';
const COSTS_SERVICE_PATH = 'apps/api/src/modules/costs/costs.service.ts';
const PRODUCTION_COST_V2_SERVICE_PATH =
  'apps/api/src/modules/admin/production-cost-v2.service.ts';

// ---------------------------------------------------------------------------
// 1. Prisma schema: новое поле + default true
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — Prisma schema', () => {
  const schema = read(SCHEMA_PATH);
  const model =
    schema.match(/model\s+CompanySettings\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  test('CompanySettings содержит allowNegativeMaterialStock Boolean @default(true)', () => {
    expect(model).not.toBe('');
    expect(model).toMatch(
      /allowNegativeMaterialStock\s+Boolean\s+@default\(true\)/,
    );
  });

  test('default = true сохранён сознательно (миграция production не меняет поведение)', () => {
    // Подстраховка от случайной правки на @default(false): такая
    // правка ломает все текущие сценарии MVP.
    expect(model).not.toMatch(/allowNegativeMaterialStock\s+Boolean\s+@default\(false\)/);
  });

  test('никаких master-`Material` моделей и `MaterialStockLot` (MVP-границы)', () => {
    expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
    expect(schema).not.toMatch(/^model\s+MaterialStockLot\b/m);
  });
});

// ---------------------------------------------------------------------------
// 2. Миграция: ADD COLUMN с дефолтом true
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — миграция', () => {
  test('миграция 20260610100000_company_settings_allow_negative_material_stock существует', () => {
    expect(exists(MIGRATION_PATH)).toBe(true);
  });

  test('миграция добавляет колонку allowNegativeMaterialStock BOOLEAN NOT NULL DEFAULT true', () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).toMatch(
      /ALTER TABLE\s+"CompanySettings"\s*\n\s*ADD COLUMN\s+"allowNegativeMaterialStock"\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+true/i,
    );
    // Защита от случайной правки default → false.
    expect(sql).not.toMatch(/DEFAULT\s+false/i);
  });
});

// ---------------------------------------------------------------------------
// 3. CompanySettingsService: getAllowNegativeMaterialStock без write
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — CompanySettingsService', () => {
  const src = read(COMPANY_SETTINGS_SERVICE_PATH);

  test('метод getAllowNegativeMaterialStock объявлен и возвращает Promise<boolean>', () => {
    expect(src).toMatch(
      /async\s+getAllowNegativeMaterialStock\s*\(\s*\)\s*:\s*Promise<boolean>/,
    );
  });

  test('геттер делает SELECT, а НЕ getOrCreate — singleton-row не создаётся', () => {
    // Вырезаем тело конкретного метода и в нём проверяем отсутствие
    // upsert / create.
    const block = src.match(
      /async\s+getAllowNegativeMaterialStock[\s\S]*?\n  \}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/findUnique/);
    expect(block!).not.toMatch(/\.upsert\(/);
    expect(block!).not.toMatch(/\.create\(/);
    expect(block!).not.toMatch(/getOrCreate/);
  });

  test('геттер возвращает true при отсутствии строки (свежая БД)', () => {
    const block = src.match(
      /async\s+getAllowNegativeMaterialStock[\s\S]*?\n  \}/,
    )?.[0];
    expect(block).toBeTruthy();
    // Любой из двух вариантов фолбэка: nullish-coalescing или явный
    // тернарник c true. На текущей реализации — `?? true`.
    expect(block!).toMatch(/\?\?\s*true|return\s+true/);
  });
});

// ---------------------------------------------------------------------------
// 4. Public DTO `CompanySettings` НЕ принимает / НЕ отдаёт флаг
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — public DTO не утёк', () => {
  test('shared CompanySettings DTO не содержит allowNegativeMaterialStock', () => {
    if (!exists(COMPANY_SETTINGS_DTO_PATH)) {
      // Если файл переименован — fail с явным указанием путей,
      // которые нужно поправить вручную.
      throw new Error(
        `Не найден ${COMPANY_SETTINGS_DTO_PATH} — обнови smoke-тест и docs/api.md §42`,
      );
    }
    const src = read(COMPANY_SETTINGS_DTO_PATH);
    expect(src).not.toMatch(/allowNegativeMaterialStock/);
  });
});

// ---------------------------------------------------------------------------
// 5. MaterialStockInsufficientException — 409 + код + details
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — доменная ошибка', () => {
  const src = read(ERRORS_PATH);

  test('common/errors.ts экспортирует MaterialStockInsufficientException', () => {
    expect(src).toMatch(
      /export\s+class\s+MaterialStockInsufficientException\s+extends\s+HttpException/,
    );
  });

  test('ошибка отвечает кодом MATERIAL_STOCK_INSUFFICIENT и статусом 409', () => {
    const block = src.match(
      /export\s+class\s+MaterialStockInsufficientException[\s\S]*?\n\}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toContain("code: 'MATERIAL_STOCK_INSUFFICIENT'");
    expect(block!).toMatch(/HttpStatus\.CONFLICT/);
  });

  test('ошибка несёт details-контракт (workshopNeedId/warehouseId/cellId/qty/unit/description)', () => {
    const block = src.match(
      /export\s+class\s+MaterialStockInsufficientException[\s\S]*?\n\}/,
    )?.[0] ?? '';
    for (const key of [
      'workshopNeedId',
      'warehouseId',
      'cellId',
      'requestedQty',
      'availableQty',
      'unit',
      'description',
    ]) {
      expect(block).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. StockService.applyMovementInTx принимает allowNegativeStock
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — StockService', () => {
  const src = read(STOCK_SERVICE_PATH);

  test('ApplyMovementInTxParams содержит optional allowNegativeStock?: boolean', () => {
    expect(src).toMatch(/allowNegativeStock\?\s*:\s*boolean/);
  });

  test('applyMovementInTx бросает MaterialStockInsufficientException при OUT и nf-balance', () => {
    expect(src).toMatch(/MaterialStockInsufficientException/);
    // Гейт срабатывает: direction OUT (`!isIn`) + явно false +
    // balanceAfterQty < 0.
    expect(src).toMatch(/params\.allowNegativeStock\s*===\s*false/);
    expect(src).toMatch(/balanceAfterQty\.lt\(0\)/);
  });

  test('IN-движение от флага НЕ зависит (только !isIn проверка)', () => {
    // В блоке гейта обязательно идёт !isIn — гарантия, что IN
    // никогда не блокируется этим флагом.
    const guard = src.match(/if\s*\(\s*!isIn[\s\S]*?MaterialStockInsufficientException[\s\S]*?\}\s*/)?.[0];
    expect(guard).toBeTruthy();
    expect(guard!).toMatch(/!isIn/);
  });

  test('recordMaterialIssueInTx принимает options.allowNegativeStock и пробрасывает дальше', () => {
    expect(src).toMatch(
      /recordMaterialIssueInTx[\s\S]*?options\?:\s*\{[\s\S]*?allowNegativeStock\?\s*:\s*boolean/,
    );
    // Дефолт `?? true` сохраняет MVP-поведение для старых вызывающих.
    expect(src).toMatch(/allowNegativeStock\s*=\s*options\?\.allowNegativeStock\s*\?\?\s*true/);
  });

  test('strict-режим без cellId ищет балас с qty >= issuedQty (без дробления)', () => {
    // Поиск самого большого положительного, который полностью
    // покрывает потребность (`gte: qty`).
    expect(src).toMatch(/qty:\s*\{\s*gte:\s*qty\s*\}/);
  });

  test('strict-режим НЕ создаёт no-location negative balance (нет fallback в else-ветке)', () => {
    // Strict-ветка `else if (!allowNegativeStock)` бросает ошибку
    // при отсутствии candidate, а не падает в no-location.
    const block = src.match(
      /else if\s*\(\s*!allowNegativeStock\s*\)\s*\{[\s\S]*?\n    \}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toContain('throw new MaterialStockInsufficientException');
  });

  test('explicit cellId в strict-режиме идёт через assertCellBalanceSufficientInTx', () => {
    expect(src).toMatch(/assertCellBalanceSufficientInTx/);
  });
});

// ---------------------------------------------------------------------------
// 7. MaterialIssuesService читает флаг и пробрасывает в StockService
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — MaterialIssuesService', () => {
  const svc = read(MATERIAL_ISSUES_SERVICE_PATH);
  const mod = read(MATERIAL_ISSUES_MODULE_PATH);

  test('сервис инжектит CompanySettingsService', () => {
    expect(svc).toMatch(
      /import\s+\{\s*CompanySettingsService\s*\}\s+from\s+'\.\.\/company-settings\/company-settings\.service\.js'/,
    );
    expect(svc).toMatch(/private\s+readonly\s+companySettings:\s*CompanySettingsService/);
  });

  test('post() читает getAllowNegativeMaterialStock и пробрасывает в recordMaterialIssueInTx', () => {
    const post = svc.match(/\n  async post\([\s\S]*?\n  \}\n/)?.[0];
    expect(post).toBeTruthy();
    expect(post!).toMatch(/this\.companySettings\.getAllowNegativeMaterialStock\(/);
    expect(post!).toMatch(/recordMaterialIssueInTx[\s\S]*?allowNegativeStock/);
  });

  test('createAutoCutIssueForPassport читает флаг и пробрасывает в recordMaterialIssueInTx', () => {
    const auto = svc.match(
      /async createAutoCutIssueForPassport[\s\S]*?\n  \}\n/,
    )?.[0];
    expect(auto).toBeTruthy();
    expect(auto!).toMatch(/this\.companySettings\.getAllowNegativeMaterialStock\(/);
    expect(auto!).toMatch(/recordMaterialIssueInTx[\s\S]*?allowNegativeStock/);
  });

  test('MaterialIssuesModule импортирует CompanySettingsModule', () => {
    expect(mod).toMatch(
      /import\s+\{\s*CompanySettingsModule\s*\}\s+from\s+'\.\.\/company-settings\/company-settings\.module\.js'/,
    );
    expect(mod).toMatch(/imports:\s*\[[\s\S]*?CompanySettingsModule[\s\S]*?\]/);
  });

  test('сервис не пишет напрямую в stockBalance / stockMovement (всё через StockService)', () => {
    expect(svc).not.toMatch(/\b(tx|prisma|this\.prisma)\.stockBalance\./);
    expect(svc).not.toMatch(/\b(tx|prisma|this\.prisma)\.stockMovement\./);
  });
});

// ---------------------------------------------------------------------------
// 8. PurchaseReceipts reversal остаётся permissive
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — PurchaseReceipts reversal не блокируется', () => {
  const src = read(PURCHASE_RECEIPTS_SERVICE_PATH);

  test('PurchaseReceiptsService НЕ передаёт allowNegativeStock и НЕ читает CompanySettings.allowNegativeMaterialStock', () => {
    // Гейт MVP применяется только к MaterialIssue OUT — приёмочный
    // reversal остаётся permissive (см.
    // `docs/current-state.md §«Подключение приёмки к складу»`).
    expect(src).not.toMatch(/allowNegativeStock/);
    expect(src).not.toMatch(/getAllowNegativeMaterialStock/);
  });
});

// ---------------------------------------------------------------------------
// 9. CostsService / ProductionCostV2Service не менялись на этой итерации
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — costs нетронуты', () => {
  test('CostsService не читает allowNegativeMaterialStock', () => {
    const src = read(COSTS_SERVICE_PATH);
    expect(src).not.toMatch(/allowNegativeMaterialStock/);
    expect(src).not.toMatch(/MaterialStockInsufficientException/);
  });

  test('ProductionCostV2Service не читает allowNegativeMaterialStock', () => {
    if (!exists(PRODUCTION_COST_V2_SERVICE_PATH)) return;
    const src = read(PRODUCTION_COST_V2_SERVICE_PATH);
    expect(src).not.toMatch(/allowNegativeMaterialStock/);
    expect(src).not.toMatch(/MaterialStockInsufficientException/);
  });
});

// ---------------------------------------------------------------------------
// 10. Frontend / UI: ничего нового
// ---------------------------------------------------------------------------

describe('hardening «allowNegativeMaterialStock» — нет UI/новых страниц', () => {
  test('нет новых stock-страниц / material-issues-страниц в admin', () => {
    const suspects = [
      'apps/web/app/admin/stock/page.tsx',
      'apps/web/app/stock/page.tsx',
      'apps/web/app/admin/material-issues/page.tsx',
      'apps/web/app/admin/company-settings/allow-negative-material-stock.tsx',
    ];
    for (const p of suspects) {
      expect(exists(p)).toBe(false);
    }
  });
});
