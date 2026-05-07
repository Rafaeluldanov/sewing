/**
 * Smoke: ручная корректировка остатка готовой продукции
 * (`POST /api/finished-goods/adjustments`, см.
 *  `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 *  `apps/api/src/modules/finished-goods/finished-goods.service.ts::createAdjustment`,
 *  `apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts`,
 *  `apps/web/components/warehouses/stock/stock-adjustment-dialog.tsx`,
 *  `docs/api.md §«Finished goods adjustments»`,
 *  `docs/current-state.md §«Готовая продукция»`).
 *
 * Статические проверки — не поднимают Nest и не ходят в БД.
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

const FG_CONTROLLER =
  'apps/api/src/modules/finished-goods/finished-goods.controller.ts';
const FG_SERVICE =
  'apps/api/src/modules/finished-goods/finished-goods.service.ts';
const FG_CONSTANTS =
  'apps/api/src/modules/finished-goods/finished-goods.constants.ts';
const ADJUSTMENT_DTO =
  'apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts';
const FG_API = 'apps/web/lib/finished-goods-api.ts';
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
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_DTO_DIR = 'apps/api/src/modules/stock';

// ---------------------------------------------------------------------------
// 1. Backend: controller / service / DTO / constants
// ---------------------------------------------------------------------------

test('FinishedGoodsController содержит POST /adjustments c @Roles ADMIN/SHOP_MANAGER', () => {
  const src = read(FG_CONTROLLER);
  expect(src).toMatch(/@Post\('adjustments'\)/);
  expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
  expect(src).toMatch(/this\.finishedGoods\.createAdjustment\(/);
  expect(src).toMatch(/CreateFinishedGoodsAdjustmentSchema/);
});

test('create-finished-goods-adjustment.dto.ts существует и описывает контракт', () => {
  expect(exists(ADJUSTMENT_DTO)).toBe(true);
  const src = read(ADJUSTMENT_DTO);
  // Поля контракта.
  expect(src).toMatch(/finishedGoodsBalanceId:/);
  expect(src).toMatch(/direction:/);
  expect(src).toMatch(/qty:/);
  expect(src).toMatch(/comment:/);
  expect(src).toMatch(/clientRequestId:/);
  // Запрещённые поля (служебные / продуктовые ID — берутся из source).
  expect(src).not.toMatch(/^\s*orderId\s*:/m);
  expect(src).not.toMatch(/^\s*productId\s*:/m);
  expect(src).not.toMatch(/^\s*sizeId\s*:/m);
  expect(src).not.toMatch(/^\s*color\s*:/m);
  expect(src).not.toMatch(/^\s*warehouseId\s*:/m);
  expect(src).not.toMatch(/^\s*cellId\s*:/m);
  expect(src).not.toMatch(/^\s*unit\s*:/m);
  expect(src).not.toMatch(/^\s*sourceKey\s*:/m);
  expect(src).not.toMatch(/^\s*balanceBeforeQty\s*:/m);
  expect(src).not.toMatch(/^\s*balanceAfterQty\s*:/m);
  expect(src).not.toMatch(/^\s*createdById\s*:/m);
  // Целое количество.
  expect(src).toMatch(/qty[\s\S]*?\.int\(/);
  expect(src).toMatch(/qty[\s\S]*?\.positive\(/);
  // Comment минимум 2 символа, максимум 500.
  expect(src).toMatch(/comment[\s\S]*?\.min\(2\)/);
  expect(src).toMatch(/comment[\s\S]*?\.max\(500\)/);
});

test('finished-goods.constants.ts содержит FINISHED_GOODS_ADJUSTMENT source-type и build-функцию', () => {
  const src = read(FG_CONSTANTS);
  expect(src).toMatch(
    /FINISHED_GOODS_ADJUSTMENT:\s*'FINISHED_GOODS_ADJUSTMENT'/,
  );
  expect(src).toMatch(
    /export function buildFinishedGoodsAdjustmentSourceKey/,
  );
  // ADJUSTMENT — реализованный type на этой итерации.
  expect(src).toMatch(/ADJUSTMENT:\s*'ADJUSTMENT'/);
});

test('FinishedGoodsService.createAdjustment пишет ADJUSTMENT IN/OUT и идемпотентен', () => {
  const src = read(FG_SERVICE);
  expect(src).toMatch(/async createAdjustment\(/);
  const block = src.match(/async createAdjustment\([\s\S]*?\n  \}\n/)?.[0];
  expect(block).toBeTruthy();
  // type = ADJUSTMENT.
  expect(block!).toMatch(/FINISHED_GOODS_MOVEMENT_TYPE\.ADJUSTMENT/);
  // Оба direction-а валидны.
  expect(block!).toMatch(/FINISHED_GOODS_MOVEMENT_DIRECTION\.IN/);
  expect(block!).toMatch(/FINISHED_GOODS_MOVEMENT_DIRECTION\.OUT/);
  // Strict OUT — отвечает 409 при недостатке.
  expect(block!).toMatch(/FINISHED_GOODS_INSUFFICIENT_BALANCE/);
  // sourceKey используется через build-функцию.
  expect(block!).toMatch(/buildFinishedGoodsAdjustmentSourceKey/);
  // Идемпотентность — поиск existing по sourceKey.
  expect(block!).toMatch(/sourceKey\s*\}/);
  // Audit event.
  expect(block!).toMatch(/FINISHED_GOODS_ADJUSTMENT_CREATED/);
  // sourceType = FINISHED_GOODS_ADJUSTMENT.
  expect(block!).toMatch(
    /FINISHED_GOODS_SOURCE_TYPE\.FINISHED_GOODS_ADJUSTMENT/,
  );
});

test('FinishedGoodsService.createAdjustment не использует company-settings-флаги (strict)', () => {
  const src = read(FG_SERVICE);
  const block = src.match(/async createAdjustment\([\s\S]*?\n  \}\n/)?.[0];
  expect(block).toBeTruthy();
  // Готовая продукция всегда strict — нет аналога
  // `allowNegativeMaterialStock`.
  expect(block!).not.toMatch(/allowNegativeMaterialStock/);
  expect(block!).not.toMatch(/getEffectiveMaterialStockSettings/);
  expect(block!).not.toMatch(/companySettings/);
});

// ---------------------------------------------------------------------------
// 2. Frontend: API client / actions / UI
// ---------------------------------------------------------------------------

test('lib/finished-goods-api экспортирует createFinishedGoodsAdjustment в /finished-goods/adjustments', () => {
  const src = read(FG_API);
  expect(src).toMatch(/export function createFinishedGoodsAdjustment/);
  expect(src).toMatch(/['"]\/finished-goods\/adjustments['"]/);
  expect(src).toMatch(/method:\s*'POST'/);
  expect(src).toMatch(/export interface CreateFinishedGoodsAdjustmentDto/);
});

test('actions.ts содержит createFinishedGoodsAdjustmentAction', () => {
  const src = read(WAREHOUSES_ACTIONS);
  expect(src).toMatch(
    /export async function createFinishedGoodsAdjustmentAction/,
  );
  expect(src).toMatch(/createFinishedGoodsAdjustment\(body\)/);
  expect(src).toMatch(/revalidatePath\('\/admin\/warehouses'\)/);
  // Integer guard в action.
  expect(src).toMatch(/Number\.isInteger\(body\.qty\)/);
});

test('AdjustmentDialog поддерживает kind MATERIAL и FINISHED_GOOD', () => {
  expect(exists(ADJUSTMENT_DIALOG)).toBe(true);
  const src = read(ADJUSTMENT_DIALOG);
  // Диалог принимает оба массива балансов.
  expect(src).toMatch(/materialBalances/);
  expect(src).toMatch(/finishedGoodsBalances/);
  // Source select содержит обе группы.
  expect(src).toMatch(/data-kind="MATERIAL"/);
  expect(src).toMatch(/data-kind="FINISHED_GOOD"/);
  // Подсказка про штучную единицу.
  expect(src).toMatch(/Готовая продукция корректируется в штуках/);
  // Подсказка про unitCost для готовой продукции.
  expect(src).toMatch(
    /Стоимость для готовой продукции в этой корректировке не\s+указывается/,
  );
  // Integer-validation для готовой продукции.
  expect(src).toMatch(/Number\.isInteger\(qtyNum\)/);
  // UI вызывает createFinishedGoodsAdjustmentAction для готовой продукции.
  expect(src).toMatch(/createFinishedGoodsAdjustmentAction\(/);
  // UI всё ещё вызывает createStockAdjustmentAction для материалов.
  expect(src).toMatch(/createStockAdjustmentAction\(/);
  // unitCost скрыт/задисейблен для FINISHED_GOOD.
  expect(src).toMatch(/unitCostDisabled/);
  expect(src).toMatch(/isFinishedGood\s*\|\|\s*direction === 'OUT'/);
  // sourceKey пользователю не показываем.
  expect(src).not.toMatch(/sourceKey/);
});

test('AdjustmentButton принимает оба массива балансов', () => {
  expect(exists(ADJUSTMENT_BUTTON)).toBe(true);
  const src = read(ADJUSTMENT_BUTTON);
  expect(src).toMatch(/Корректировка/);
  expect(src).toMatch(/materialBalances/);
  expect(src).toMatch(/finishedGoodsBalances/);
  expect(src).toMatch(/StockAdjustmentDialog/);
});

test('warehouses/page.tsx подключает StockAdjustmentButton с обоими списками', () => {
  const src = read(WAREHOUSES_PAGE);
  const balancesBlock = src.match(
    /async function BalancesTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(balancesBlock!).toMatch(/StockAdjustmentButton/);
  expect(balancesBlock!).toMatch(/materialBalances=\{materialItems\}/);
  expect(balancesBlock!).toMatch(/finishedGoodsBalances=\{finishedItems\}/);
});

test('StockMovementsTable отрисовывает ADJUSTMENT как «Корректировка»', () => {
  const src = read(MOVEMENT_TYPE_BADGE);
  expect(src).toMatch(/ADJUSTMENT:\s*\{\s*label:\s*'Корректировка'/);
});

// ---------------------------------------------------------------------------
// 3. MVP-границы / sanity
// ---------------------------------------------------------------------------

test('Не создана модель FinishedGoodsAdjustment в Prisma schema', () => {
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/^model\s+FinishedGoodsAdjustment\s*\{/m);
});

test('UI не создаёт /admin/finished-goods-adjustments / отдельной страницы', () => {
  expect(exists('apps/web/app/admin/finished-goods-adjustments')).toBe(false);
  expect(exists('apps/web/app/admin/finished-goods-adjustment')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/finished-goods-adjustment')).toBe(
    false,
  );
});

test('UI не добавляет sidebar item под finished-goods adjustment', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/href:\s*'\/admin\/finished-goods-adjustment/);
  expect(src).not.toMatch(/'Корректировка готовой продукции'/);
});

test('Не вводим FIFO/LIFO/MaterialStockLot в DTO/UI/сервисе корректировки готовой продукции', () => {
  for (const path of [ADJUSTMENT_DTO, ADJUSTMENT_DIALOG, ADJUSTMENT_BUTTON, FG_SERVICE]) {
    const src = read(path);
    expect(src).not.toMatch(/\bFIFO\b/);
    expect(src).not.toMatch(/\bLIFO\b/);
    expect(src).not.toMatch(/MaterialStockLot/);
  }
});

test('docs/api.md описывает POST /api/finished-goods/adjustments', () => {
  const apiDoc = read('docs/api.md');
  expect(apiDoc).toMatch(/POST[^\n]*`\/api\/finished-goods\/adjustments`/);
  // sourceKey не отдаётся (повтор контракта read-only).
  expect(apiDoc).toMatch(
    /POST \/api\/finished-goods\/adjustments[\s\S]{0,3000}sourceKey/,
  );
});

// ---------------------------------------------------------------------------
// 4. Изоляция от материалов
// ---------------------------------------------------------------------------

test('material StockService.createAdjustment остался без изменений', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/async createAdjustment\(/);
  expect(src).toMatch(/STOCK_MOVEMENT_TYPE\.ADJUSTMENT/);
  expect(src).toMatch(/STOCK_ADJUSTMENT_CREATED/);
});

test('material StockService и DTO не получили finished-goods adjustment ссылок', () => {
  const src = read(STOCK_SERVICE);
  expect(src).not.toMatch(/createFinishedGoodsAdjustment/);
  expect(src).not.toMatch(/FinishedGoodsAdjustment/);
  expect(src).not.toMatch(/finishedGoodsMovement/);
  for (const f of [
    'create-stock-adjustment.dto.ts',
    'create-stock-transfer.dto.ts',
  ]) {
    const dto = read(`${MATERIAL_DTO_DIR}/dto/${f}`);
    expect(dto).not.toMatch(/FinishedGoods/);
  }
});

test('UI существующая material-корректировка всё ещё вызывает createStockAdjustment', () => {
  const src = read(ADJUSTMENT_DIALOG);
  expect(src).toMatch(/createStockAdjustmentAction\(\{/);
  expect(src).toMatch(/stockBalanceId:\s*selected\.balance\.id/);
});
