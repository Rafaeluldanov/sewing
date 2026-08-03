/**
 * Smoke: «Склад выпуска готовой продукции» в заказе покупателя
 * (см. `prisma/schema.prisma::Order.finishedGoodsWarehouseId`,
 *  `apps/api/src/modules/orders/orders.service.ts`,
 *  `packages/shared/src/orders.ts`,
 *  `apps/web/app/admin/orders/new/order-create-wizard.tsx`,
 *  `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx`,
 *  `apps/web/components/orders/view/order-management-header.tsx`,
 *  `docs/current-state.md §«Склад выпуска готовой продукции»`).
 *
 * Управленческое поле — НЕ влияет на StockBalance / StockMovement /
 * MaterialIssue / StockService / PurchaseReceipt / WorkshopNeed.
 *
 * Статические проверки.
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

const SCHEMA = 'prisma/schema.prisma';
const SHARED_ORDERS = 'packages/shared/src/orders.ts';
const ORDERS_SERVICE = 'apps/api/src/modules/orders/orders.service.ts';
const CREATE_FORM =
  'apps/web/app/admin/orders/new/order-create-wizard.tsx';
const CREATE_PAGE = 'apps/web/app/admin/orders/new/page.tsx';
const EDIT_FORM =
  'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx';
const EDIT_PAGE = 'apps/web/app/admin/orders/[id]/edit/page.tsx';
const ORDERS_ACTIONS = 'apps/web/app/orders/actions.ts';
const EDIT_ACTIONS = 'apps/web/app/admin/orders/[id]/edit/actions.ts';
const ORDER_HEADER =
  'apps/web/components/orders/view/order-management-header.tsx';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';

// ---------------------------------------------------------------------------
// 1. Prisma Order содержит finishedGoodsWarehouseId.
// ---------------------------------------------------------------------------

test('Prisma Order содержит finishedGoodsWarehouseId + relation + index', () => {
  const src = read(SCHEMA);
  // Само поле и FK.
  expect(src).toMatch(/finishedGoodsWarehouseId\s+String\?/);
  expect(src).toMatch(
    /finishedGoodsWarehouse\s+Warehouse\?\s+@relation\("OrderFinishedGoodsWarehouse"/,
  );
  expect(src).toMatch(/onDelete:\s*SetNull/);
  // Индекс по полю на стороне Order.
  expect(src).toMatch(/@@index\(\[finishedGoodsWarehouseId\]\)/);
});

// ---------------------------------------------------------------------------
// 2. Warehouse имеет back relation.
// ---------------------------------------------------------------------------

test('Warehouse имеет back-relation finishedGoodsOrders', () => {
  const src = read(SCHEMA);
  expect(src).toMatch(
    /finishedGoodsOrders\s+Order\[\]\s+@relation\("OrderFinishedGoodsWarehouse"\)/,
  );
});

// ---------------------------------------------------------------------------
// 3. CreateOrder schema принимает finishedGoodsWarehouseId.
// ---------------------------------------------------------------------------

test('CreateOrderSchema содержит finishedGoodsWarehouseId (optional, nullable)', () => {
  const src = read(SHARED_ORDERS);
  // CreateOrder schema-block ограничен до .superRefine.
  const createBlock = src.match(
    /export const CreateOrderSchema[\s\S]*?\}\)\.superRefine/,
  )?.[0];
  expect(createBlock).toBeTruthy();
  expect(createBlock!).toMatch(
    /finishedGoodsWarehouseId:\s*z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/,
  );
});

// ---------------------------------------------------------------------------
// 4. UpdateOrder schema принимает finishedGoodsWarehouseId.
// ---------------------------------------------------------------------------

test('UpdateOrderSchema содержит finishedGoodsWarehouseId (optional, nullable)', () => {
  const src = read(SHARED_ORDERS);
  const updateBlock = src.match(
    /export const UpdateOrderSchema[\s\S]*?\}\);/,
  )?.[0];
  expect(updateBlock).toBeTruthy();
  expect(updateBlock!).toMatch(
    /finishedGoodsWarehouseId:\s*z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/,
  );
});

// ---------------------------------------------------------------------------
// 5. OrdersService проверяет Warehouse.
// ---------------------------------------------------------------------------

test('OrdersService содержит resolveFinishedGoodsWarehouseIdForOrder', () => {
  const src = read(ORDERS_SERVICE);
  expect(src).toMatch(/resolveFinishedGoodsWarehouseIdForOrder/);
  // Адресные коды ошибок.
  expect(src).toMatch(/'WAREHOUSE_NOT_FOUND'/);
  expect(src).toMatch(/'WAREHOUSE_INACTIVE'/);
  // Резолвер вызывается и в create, и в update.
  expect(src).toMatch(
    /finishedGoodsWarehouseIdForCreate[\s\S]*?resolveFinishedGoodsWarehouseIdForOrder/,
  );
  expect(src).toMatch(
    /finishedGoodsWarehouseIdForPrisma[\s\S]*?resolveFinishedGoodsWarehouseIdForOrder/,
  );
});

// ---------------------------------------------------------------------------
// 6. Order create UI содержит «Склад выпуска готовой продукции».
// ---------------------------------------------------------------------------

test('Мастер создания содержит «Склад выпуска готовой продукции»', () => {
  const src = read(CREATE_FORM);
  expect(src).toMatch(/Склад выпуска готовой продукции/);
  // Мастер не собирает FormData — поле живёт в состоянии шага
  // «Клиент» и уезжает в DTO ключом `finishedGoodsWarehouseId`
  // (см. `buildBasicsDto`).
  expect(src).toMatch(/finishedGoodsWarehouseId/);
  expect(src).toMatch(/setFinishedGoodsWarehouseId/);
});

test('Order create page загружает список warehouses', () => {
  const src = read(CREATE_PAGE);
  expect(src).toMatch(/listWarehouses/);
  expect(src).toMatch(/warehouses=\{warehouses\}/);
});

// ---------------------------------------------------------------------------
// 7. Order edit UI содержит «Склад выпуска готовой продукции».
// ---------------------------------------------------------------------------

test('Order edit form содержит «Склад выпуска готовой продукции»', () => {
  const src = read(EDIT_FORM);
  expect(src).toMatch(/Склад выпуска готовой продукции/);
  expect(src).toMatch(/name="finishedGoodsWarehouseId"/);
});

test('Order edit page загружает список warehouses', () => {
  const src = read(EDIT_PAGE);
  expect(src).toMatch(/listWarehouses/);
  expect(src).toMatch(/warehouses=\{warehouses\}/);
});

// ---------------------------------------------------------------------------
// 8. Order detail показывает «Склад готовой продукции».
// ---------------------------------------------------------------------------

test('OrderManagementHeader показывает «Склад готовой продукции»', () => {
  const src = read(ORDER_HEADER);
  expect(src).toMatch(/Склад готовой продукции/);
  expect(src).toMatch(/order\.finishedGoodsWarehouse/);
});

// ---------------------------------------------------------------------------
// 9. Server actions парсят finishedGoodsWarehouseId.
// ---------------------------------------------------------------------------

test('createOrderAction / updateOrderAction парсят finishedGoodsWarehouseId', () => {
  const ordersActions = read(ORDERS_ACTIONS);
  expect(ordersActions).toMatch(/parseFinishedGoodsWarehouseId/);
  expect(ordersActions).toMatch(/finishedGoodsWarehouseId/);

  const editActions = read(EDIT_ACTIONS);
  expect(editActions).toMatch(/finishedGoodsWarehouseId/);
});

// ---------------------------------------------------------------------------
// 10–14. Это не склад материалов: StockService / MaterialIssue не
//   меняются под finishedGoodsWarehouseId.
// ---------------------------------------------------------------------------

test('StockService не получил поле finishedGoodsWarehouseId', () => {
  const src = read(STOCK_SERVICE);
  expect(src).not.toMatch(/finishedGoodsWarehouseId/);
  // Foundation-методы остались на месте — спот-проверка.
  expect(src).toMatch(/applyMovementInTx/);
});

test('MaterialIssuesService не получил поле finishedGoodsWarehouseId', () => {
  const src = read(MATERIAL_ISSUES_SERVICE);
  expect(src).not.toMatch(/finishedGoodsWarehouseId/);
});

test('FinishedGoodsBalance / FinishedGoodsMovement — отдельный контур, не материалы', () => {
  const schema = read(SCHEMA);
  // Foundation готовой продукции добавлен (этап «Готовая продукция»,
  // см. `apps/api/src/modules/finished-goods/*`,
  // `docs/current-state.md §«Готовая продукция»`).
  expect(schema).toMatch(/^model\s+FinishedGoodsBalance\s*\{/m);
  expect(schema).toMatch(/^model\s+FinishedGoodsMovement\s*\{/m);
  // Это **отдельный контур** от материалов — не должны появиться
  // master-модель `Material` / `MaterialStockLot`.
  expect(schema).not.toMatch(/^model\s+MaterialStockLot\s*\{/m);
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
});

// ---------------------------------------------------------------------------
// 15. Не создана новая страница / sidebar item.
// ---------------------------------------------------------------------------

test('Не создана новая страница под склад готовой продукции', () => {
  expect(exists('apps/web/app/admin/finished-goods')).toBe(false);
  expect(exists('apps/web/app/admin/orders/finished-goods')).toBe(false);
  expect(exists('apps/web/app/admin/orders/warehouse')).toBe(false);
});

test('Sidebar не получил новый пункт под склад готовой продукции', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/'Готовая продукция'/);
  expect(src).not.toMatch(/href:\s*'\/admin\/finished-goods'/);
});

// ---------------------------------------------------------------------------
// 16. Не вводим новые роли.
// ---------------------------------------------------------------------------

test('Новые роли (WAREHOUSE_MANAGER / PURCHASER / ACCOUNTANT) не введены', () => {
  const schema = read(SCHEMA);
  const roleEnum = schema.match(/enum\s+Role\s*\{[\s\S]*?\}/)?.[0] ?? '';
  expect(roleEnum).not.toMatch(/\bWAREHOUSE_MANAGER\b/);
  expect(roleEnum).not.toMatch(/\bPURCHASER\b/);
  expect(roleEnum).not.toMatch(/\bACCOUNTANT\b/);
});
