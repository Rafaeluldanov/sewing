/**
 * Smoke: ручная корректировка остатка
 * (`POST /api/stock/adjustments`, см.
 *  `apps/api/src/modules/stock/stock.controller.ts`,
 *  `apps/api/src/modules/stock/stock.service.ts::createAdjustment`,
 *  `apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts`,
 *  `apps/web/components/warehouses/stock/stock-adjustment-dialog.tsx`,
 *  `docs/api.md §«26a.3 POST /api/stock/adjustments»`,
 *  `docs/current-state.md §«UI остатков и движений склада»`).
 *
 * Статические проверки — не поднимают Nest и не ходят в БД. Полные
 * сценарии (IN / OUT / allowNegativeMaterialStock / идемпотентность)
 * живут в `tests/integration/stock-adjustments.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

const repoRoot = join(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(join(repoRoot, rel));
}

const STOCK_CONTROLLER = 'apps/api/src/modules/stock/stock.controller.ts';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const STOCK_MODULE = 'apps/api/src/modules/stock/stock.module.ts';
const ADJUSTMENT_DTO =
  'apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts';
const STOCK_API = 'apps/web/lib/stock-api.ts';
const ADJUSTMENT_DIALOG =
  'apps/web/components/warehouses/stock/stock-adjustment-dialog.tsx';
const ADJUSTMENT_BUTTON =
  'apps/web/components/warehouses/stock/stock-adjustment-button.tsx';
const WAREHOUSES_PAGE = 'apps/web/app/admin/warehouses/page.tsx';
const WAREHOUSES_ACTIONS = 'apps/web/app/admin/warehouses/actions.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const MOVEMENT_TYPE_BADGE =
  'apps/web/components/warehouses/stock/stock-movement-type-badge.tsx';
const SCHEMA = 'prisma/schema.prisma';
const AUDIT_SERVICE = 'apps/api/src/modules/audit/audit.service.ts';

// ---------------------------------------------------------------------------
// Backend: controller / service / DTO / module
// ---------------------------------------------------------------------------

test('StockController содержит POST /adjustments c @Roles ADMIN/SHOP_MANAGER', () => {
  const src = read(STOCK_CONTROLLER);
  expect(src).toMatch(/@Post\('adjustments'\)/);
  expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
  expect(src).toMatch(/this\.stock\.createAdjustment\(/);
  expect(src).toMatch(/CreateStockAdjustmentSchema/);
});

test('create-stock-adjustment.dto.ts существует и описывает контракт', () => {
  expect(exists(ADJUSTMENT_DTO)).toBe(true);
  const src = read(ADJUSTMENT_DTO);
  // Поля контракта.
  expect(src).toMatch(/stockBalanceId:/);
  expect(src).toMatch(/direction:/);
  expect(src).toMatch(/qty:/);
  expect(src).toMatch(/unitCost:/);
  expect(src).toMatch(/comment:/);
  expect(src).toMatch(/clientRequestId:/);
  // Запрещённые поля backend сам управляет ими.
  expect(src).not.toMatch(/^\s*sourceKey\s*:/m);
  expect(src).not.toMatch(/^\s*totalCost\s*:/m);
  expect(src).not.toMatch(/^\s*balanceBeforeQty\s*:/m);
  expect(src).not.toMatch(/^\s*balanceAfterQty\s*:/m);
  expect(src).not.toMatch(/^\s*createdById\s*:/m);
  // Comment минимум 2 символа, максимум 500.
  expect(src).toMatch(/comment[\s\S]*?\.min\(2\)/);
  expect(src).toMatch(/comment[\s\S]*?\.max\(500\)/);
});

test('StockService содержит buildStockAdjustmentSourceKey и STOCK_ADJUSTMENT prefix', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/export function buildStockAdjustmentSourceKey/);
  expect(src).toMatch(/STOCK_ADJUSTMENT:\s*'STOCK_ADJUSTMENT'/);
});

test('StockService.createAdjustment пишет StockMovement type=ADJUSTMENT', () => {
  const src = read(STOCK_SERVICE);
  // Сам метод
  expect(src).toMatch(/async createAdjustment\(/);
  // ADJUSTMENT-тип явно используется в createAdjustment блоке.
  const block = src.match(/async createAdjustment\([\s\S]*?\n  \}\n/)?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/STOCK_MOVEMENT_TYPE\.ADJUSTMENT/);
  // Прокидывает allowNegativeStock через effective-resolver
  // (`resolveAdjustmentAllowNegative` учитывает per-division override,
  // см. `docs/current-state.md §«Материалы и склад — division overrides»`).
  expect(block!).toMatch(/resolveAdjustmentAllowNegative/);
  // Идемпотентность по sourceKey.
  expect(block!).toMatch(/findMovementBySourceKeyInTx/);
  // Audit event.
  expect(block!).toMatch(/STOCK_ADJUSTMENT_CREATED/);
});

test('StockModule импортирует CompanySettingsModule', () => {
  const src = read(STOCK_MODULE);
  expect(src).toMatch(/CompanySettingsModule/);
  expect(src).toMatch(/imports:\s*\[\s*CompanySettingsModule\s*\]/);
});

test('AuditEntityType содержит STOCK_MOVEMENT', () => {
  const src = read(AUDIT_SERVICE);
  expect(src).toMatch(/'STOCK_MOVEMENT'/);
});

// ---------------------------------------------------------------------------
// Frontend: stock-api / actions / UI
// ---------------------------------------------------------------------------

test('lib/stock-api экспортирует createStockAdjustment в /stock/adjustments', () => {
  const src = read(STOCK_API);
  expect(src).toMatch(/export function createStockAdjustment/);
  expect(src).toMatch(/['"]\/stock\/adjustments['"]/);
  expect(src).toMatch(/method:\s*'POST'/);
});

test('actions.ts содержит createStockAdjustmentAction', () => {
  const src = read(WAREHOUSES_ACTIONS);
  expect(src).toMatch(/export async function createStockAdjustmentAction/);
  expect(src).toMatch(/createStockAdjustment\(body\)/);
  expect(src).toMatch(/revalidatePath\('\/admin\/warehouses'\)/);
});

test('StockAdjustmentDialog существует и имеет fields direction/qty/unitCost/comment', () => {
  expect(exists(ADJUSTMENT_DIALOG)).toBe(true);
  const src = read(ADJUSTMENT_DIALOG);
  // Поля формы.
  expect(src).toMatch(/name="direction"/);
  expect(src).toMatch(/name="qty"/);
  expect(src).toMatch(/name="unitCost"/);
  expect(src).toMatch(/name="comment"/);
  // Кнопки «Сохранить корректировку» / «Отмена».
  expect(src).toMatch(/Сохранить корректировку/);
  expect(src).toMatch(/Отмена/);
  // Подсказка для OUT, что цена берётся из текущего остатка.
  expect(src).toMatch(/текущая\s+складская\s+цена/i);
  // sourceKey пользователю не показываем.
  expect(src).not.toMatch(/sourceKey/);
});

test('StockAdjustmentButton рендерит кнопку «Корректировка»', () => {
  expect(exists(ADJUSTMENT_BUTTON)).toBe(true);
  const src = read(ADJUSTMENT_BUTTON);
  expect(src).toMatch(/Корректировка/);
  expect(src).toMatch(/StockAdjustmentDialog/);
});

test('warehouses/page.tsx подключает StockAdjustmentButton во вкладку balances', () => {
  const src = read(WAREHOUSES_PAGE);
  expect(src).toMatch(/StockAdjustmentButton/);
  // Точно во вкладке balances (не в default / movements).
  const balancesBlock = src.match(
    /async function BalancesTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(balancesBlock!).toMatch(/StockAdjustmentButton/);
});

test('StockMovementsTable показывает ADJUSTMENT как «Корректировка»', () => {
  const src = read(MOVEMENT_TYPE_BADGE);
  expect(src).toMatch(/ADJUSTMENT:\s*\{\s*label:\s*'Корректировка'/);
});

// ---------------------------------------------------------------------------
// MVP-границы
// ---------------------------------------------------------------------------

test('UI не создаёт /admin/stock-adjustments / отдельной страницы', () => {
  expect(exists('apps/web/app/admin/stock-adjustments')).toBe(false);
  expect(exists('apps/web/app/admin/stock')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/adjustments')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/balances')).toBe(false);
});

test('UI не добавляет sidebar item под корректировки / stock', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/href:\s*'\/admin\/stock'/);
  expect(src).not.toMatch(/href:\s*'\/admin\/stock-adjustments'/);
  expect(src).not.toMatch(/'Корректировка'/);
});

test('Не добавлена StockAdjustment модель в Prisma schema', () => {
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/^model\s+StockAdjustment\s*\{/m);
  expect(schema).not.toMatch(/^model\s+MaterialStockLot\s*\{/m);
  // master-`Material` тоже не появляется.
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
});

test('Не вводим FIFO/LIFO/MaterialStockLot в DTO/UI корректировки', () => {
  // StockService содержит исторические JSDoc-упоминания «без FIFO»
  // (документирует границу MVP, см. read-only smoke), здесь
  // проверяем только новые артефакты этой итерации.
  for (const path of [ADJUSTMENT_DTO, ADJUSTMENT_DIALOG, ADJUSTMENT_BUTTON]) {
    const src = read(path);
    expect(src).not.toMatch(/\bFIFO\b/);
    expect(src).not.toMatch(/\bLIFO\b/);
    expect(src).not.toMatch(/MaterialStockLot/);
  }
});

test('Новые роли (WAREHOUSE_MANAGER / PURCHASER / ACCOUNTANT) не введены', () => {
  const schema = read(SCHEMA);
  const roleEnum = schema.match(/enum\s+Role\s*\{[\s\S]*?\}/)?.[0] ?? '';
  expect(roleEnum).not.toMatch(/\bWAREHOUSE_MANAGER\b/);
  expect(roleEnum).not.toMatch(/\bPURCHASER\b/);
  expect(roleEnum).not.toMatch(/\bACCOUNTANT\b/);
  // В контроллере / dialog нет упоминаний.
  for (const path of [STOCK_CONTROLLER, ADJUSTMENT_DIALOG, WAREHOUSES_PAGE]) {
    const src = read(path);
    expect(src).not.toMatch(/WAREHOUSE_MANAGER|PURCHASER|ACCOUNTANT/);
  }
});

test('docs/api.md описывает POST /api/stock/adjustments', () => {
  const apiDoc = read('docs/api.md');
  expect(apiDoc).toMatch(/POST\s*\|\s*`\/api\/stock\/adjustments`/);
  // sourceKey не отдаётся (повтор контракта read-only).
  expect(apiDoc).toMatch(/sourceKey[\s\S]{0,80}не\s+отдаётся/);
});
