/**
 * Smoke: перемещение готовой продукции между складами / ячейками
 * (`POST /api/finished-goods/transfers`, см.
 *  `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 *  `apps/api/src/modules/finished-goods/finished-goods.service.ts::createTransfer`,
 *  `apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts`,
 *  `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`,
 *  `docs/api.md §«Finished goods transfers»`,
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
const TRANSFER_DTO =
  'apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts';
const FG_API = 'apps/web/lib/finished-goods-api.ts';
const TRANSFER_DIALOG =
  'apps/web/components/warehouses/stock/stock-transfer-dialog.tsx';
const TRANSFER_BUTTON =
  'apps/web/components/warehouses/stock/stock-transfer-button.tsx';
const WAREHOUSES_PAGE = 'apps/web/app/admin/warehouses/page.tsx';
const WAREHOUSES_ACTIONS = 'apps/web/app/admin/warehouses/actions.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const MOVEMENT_TYPE_BADGE =
  'apps/web/components/warehouses/stock/stock-movement-type-badge.tsx';
const SCHEMA = 'prisma/schema.prisma';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUE_DTO_DIR = 'apps/api/src/modules/stock';

// ---------------------------------------------------------------------------
// 1. Backend: controller / service / DTO / constants
// ---------------------------------------------------------------------------

test('FinishedGoodsController содержит POST /transfers c @Roles ADMIN/SHOP_MANAGER', () => {
  const src = read(FG_CONTROLLER);
  expect(src).toMatch(/@Post\('transfers'\)/);
  expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
  expect(src).toMatch(/this\.finishedGoods\.createTransfer\(/);
  expect(src).toMatch(/CreateFinishedGoodsTransferSchema/);
});

test('create-finished-goods-transfer.dto.ts существует и описывает контракт', () => {
  expect(exists(TRANSFER_DTO)).toBe(true);
  const src = read(TRANSFER_DTO);
  // Поля контракта.
  expect(src).toMatch(/fromFinishedGoodsBalanceId:/);
  expect(src).toMatch(/toWarehouseId:/);
  expect(src).toMatch(/toCellId:/);
  expect(src).toMatch(/qty:/);
  expect(src).toMatch(/comment:/);
  expect(src).toMatch(/clientRequestId:/);
  // Запрещённые поля (служебные / продуктовые ID — берутся из source).
  expect(src).not.toMatch(/^\s*orderId\s*:/m);
  expect(src).not.toMatch(/^\s*productId\s*:/m);
  expect(src).not.toMatch(/^\s*sizeId\s*:/m);
  expect(src).not.toMatch(/^\s*color\s*:/m);
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

test('finished-goods.constants.ts содержит FINISHED_GOODS_TRANSFER source-type и build-функции', () => {
  const src = read(FG_CONSTANTS);
  expect(src).toMatch(/FINISHED_GOODS_TRANSFER:\s*'FINISHED_GOODS_TRANSFER'/);
  expect(src).toMatch(/export function buildFinishedGoodsTransferOutSourceKey/);
  expect(src).toMatch(/export function buildFinishedGoodsTransferInSourceKey/);
});

test('FinishedGoodsService.createTransfer пишет пару TRANSFER OUT/IN', () => {
  const src = read(FG_SERVICE);
  expect(src).toMatch(/async createTransfer\(/);
  const block = src.match(/async createTransfer\([\s\S]*?\n  \}\n/)?.[0];
  expect(block).toBeTruthy();
  // type = TRANSFER явно используется.
  expect(block!).toMatch(/FINISHED_GOODS_MOVEMENT_TYPE\.TRANSFER/);
  // Оба direction-а пишутся.
  expect(block!).toMatch(/FINISHED_GOODS_MOVEMENT_DIRECTION\.OUT/);
  expect(block!).toMatch(/FINISHED_GOODS_MOVEMENT_DIRECTION\.IN/);
  // Идемпотентность по двум sourceKey-ключам.
  expect(block!).toMatch(/buildFinishedGoodsTransferOutSourceKey/);
  expect(block!).toMatch(/buildFinishedGoodsTransferInSourceKey/);
  // Strict source qty — отвечает 409 при недостатке.
  expect(block!).toMatch(/FINISHED_GOODS_INSUFFICIENT_BALANCE/);
  // Same-location гейт.
  expect(block!).toMatch(/FINISHED_GOODS_TRANSFER_SAME_LOCATION/);
  // Inconsistent state гейт.
  expect(block!).toMatch(/FINISHED_GOODS_TRANSFER_INCONSISTENT_STATE/);
  // Audit event.
  expect(block!).toMatch(/FINISHED_GOODS_TRANSFER_CREATED/);
  // sourceType = FINISHED_GOODS_TRANSFER.
  expect(block!).toMatch(
    /FINISHED_GOODS_SOURCE_TYPE\.FINISHED_GOODS_TRANSFER/,
  );
});

test('FinishedGoodsService.createTransfer не использует company-settings-флаги (strict)', () => {
  const src = read(FG_SERVICE);
  const block = src.match(/async createTransfer\([\s\S]*?\n  \}\n/)?.[0];
  expect(block).toBeTruthy();
  // Никаких флагов на отрицательный остаток — готовая продукция всегда
  // strict.
  expect(block!).not.toMatch(/allowNegativeMaterialStock/);
  expect(block!).not.toMatch(/getEffectiveMaterialStockSettings/);
  expect(block!).not.toMatch(/companySettings/);
});

// ---------------------------------------------------------------------------
// 2. Frontend: API client / actions / UI
// ---------------------------------------------------------------------------

test('lib/finished-goods-api экспортирует createFinishedGoodsTransfer в /finished-goods/transfers', () => {
  const src = read(FG_API);
  expect(src).toMatch(/export function createFinishedGoodsTransfer/);
  expect(src).toMatch(/['"]\/finished-goods\/transfers['"]/);
  expect(src).toMatch(/method:\s*'POST'/);
  // CreateFinishedGoodsTransferDto / Response shape экспортируются.
  expect(src).toMatch(/export interface CreateFinishedGoodsTransferDto/);
  expect(src).toMatch(/export interface CreateFinishedGoodsTransferResponse/);
});

test('actions.ts содержит createFinishedGoodsTransferAction', () => {
  const src = read(WAREHOUSES_ACTIONS);
  expect(src).toMatch(
    /export async function createFinishedGoodsTransferAction/,
  );
  expect(src).toMatch(/createFinishedGoodsTransfer\(body\)/);
  expect(src).toMatch(/revalidatePath\('\/admin\/warehouses'\)/);
  // Integer guard в action.
  expect(src).toMatch(/Number\.isInteger\(body\.qty\)/);
});

test('TransferDialog поддерживает kind MATERIAL и FINISHED_GOOD', () => {
  expect(exists(TRANSFER_DIALOG)).toBe(true);
  const src = read(TRANSFER_DIALOG);
  // Диалог принимает оба массива балансов.
  expect(src).toMatch(/materialBalances/);
  expect(src).toMatch(/finishedGoodsBalances/);
  // Source select содержит обе группы.
  expect(src).toMatch(/data-kind="MATERIAL"/);
  expect(src).toMatch(/data-kind="FINISHED_GOOD"/);
  // Подсказка про штучную единицу.
  expect(src).toMatch(/Готовая продукция перемещается в штуках/);
  // Integer-validation для готовой продукции.
  expect(src).toMatch(/Number\.isInteger\(qtyNum\)/);
  // UI вызывает createFinishedGoodsTransferAction для готовой продукции.
  expect(src).toMatch(/createFinishedGoodsTransferAction\(/);
  // UI всё ещё вызывает createStockTransferAction для материалов.
  expect(src).toMatch(/createStockTransferAction\(/);
  // sourceKey пользователю не показываем.
  expect(src).not.toMatch(/sourceKey/);
});

test('TransferButton принимает оба массива балансов', () => {
  expect(exists(TRANSFER_BUTTON)).toBe(true);
  const src = read(TRANSFER_BUTTON);
  expect(src).toMatch(/Переместить/);
  expect(src).toMatch(/materialBalances/);
  expect(src).toMatch(/finishedGoodsBalances/);
  expect(src).toMatch(/StockTransferDialog/);
});

test('warehouses/page.tsx подключает StockTransferButton с обоими списками', () => {
  const src = read(WAREHOUSES_PAGE);
  const balancesBlock = src.match(
    /async function BalancesTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(balancesBlock!).toMatch(/StockTransferButton/);
  expect(balancesBlock!).toMatch(/materialBalances=\{materialItems\}/);
  expect(balancesBlock!).toMatch(/finishedGoodsBalances=\{finishedItems\}/);
});

test('StockMovementsTable отрисовывает TRANSFER как «Перемещение»', () => {
  const src = read(MOVEMENT_TYPE_BADGE);
  expect(src).toMatch(/TRANSFER:\s*\{\s*label:\s*'Перемещение'/);
});

// ---------------------------------------------------------------------------
// 3. MVP-границы / sanity
// ---------------------------------------------------------------------------

test('Не создана модель FinishedGoodsTransfer в Prisma schema', () => {
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/^model\s+FinishedGoodsTransfer\s*\{/m);
});

test('UI не создаёт /admin/finished-goods-transfer / отдельной страницы', () => {
  expect(exists('apps/web/app/admin/finished-goods-transfer')).toBe(false);
  expect(exists('apps/web/app/admin/finished-goods-transfers')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/finished-goods-transfer')).toBe(
    false,
  );
});

test('UI не добавляет sidebar item под finished-goods transfer', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/href:\s*'\/admin\/finished-goods-transfer/);
  expect(src).not.toMatch(/'Перемещение готовой продукции'/);
});

test('Не вводим FIFO/LIFO/MaterialStockLot в DTO/UI/сервисе перемещения готовой продукции', () => {
  for (const path of [TRANSFER_DTO, TRANSFER_DIALOG, TRANSFER_BUTTON, FG_SERVICE]) {
    const src = read(path);
    expect(src).not.toMatch(/\bFIFO\b/);
    expect(src).not.toMatch(/\bLIFO\b/);
    expect(src).not.toMatch(/MaterialStockLot/);
  }
});

test('docs/api.md описывает POST /api/finished-goods/transfers', () => {
  const apiDoc = read('docs/api.md');
  expect(apiDoc).toMatch(/POST[^\n]*`\/api\/finished-goods\/transfers`/);
  // sourceKey не отдаётся (повтор контракта read-only).
  expect(apiDoc).toMatch(
    /POST \/api\/finished-goods\/transfers[\s\S]{0,3000}sourceKey/,
  );
});

// ---------------------------------------------------------------------------
// 4. Изоляция от материалов: backend material flow не меняется
// ---------------------------------------------------------------------------

test('StockService createTransfer (материалы) остался на месте без изменений', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/async createTransfer\(/);
  expect(src).toMatch(/STOCK_MOVEMENT_TYPE\.TRANSFER/);
  expect(src).toMatch(/STOCK_TRANSFER_CREATED/);
});

test('material StockService и MaterialIssue/PurchaseReceipt/StockAdjustment не получили finished-goods transfer ссылок', () => {
  const src = read(STOCK_SERVICE);
  expect(src).not.toMatch(/createFinishedGoodsTransfer/);
  expect(src).not.toMatch(/FinishedGoodsTransfer/);
  // Поверх — нет случайного хода в `finished-goods` контур.
  expect(src).not.toMatch(/finishedGoodsMovement/);
  // Material DTOs не должны были измениться.
  for (const f of [
    'create-stock-transfer.dto.ts',
    'create-stock-adjustment.dto.ts',
  ]) {
    const dto = read(`${MATERIAL_ISSUE_DTO_DIR}/dto/${f}`);
    expect(dto).not.toMatch(/FinishedGoods/);
  }
});
