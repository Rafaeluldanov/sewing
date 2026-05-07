/**
 * Smoke: выпуск готовой продукции по операции
 * (см. ТЗ «выпуск управляется признаком на операции»,
 *  `prisma/schema.prisma::Operation.producesFinishedGoods`,
 *  `apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx`,
 *  `apps/api/src/modules/passports/passports.service.ts::scanOnOperation` /
 *  `completeOperationByEmployee`,
 *  `docs/current-state.md §«Готовая продукция»`).
 *
 * Не дублирует foundation-тесты (`finished-goods-foundation.smoke.test.ts`):
 * здесь проверяем именно operation-driven путь и инварианты «один
 * паспорт = один выпуск», «не задвоить в packing flow».
 *
 * Статические проверки — не поднимают Nest и не ходят в БД.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const FG_SERVICE =
  'apps/api/src/modules/finished-goods/finished-goods.service.ts';
const FG_CONSTANTS =
  'apps/api/src/modules/finished-goods/finished-goods.constants.ts';
const SHARED_OPERATIONS = 'packages/shared/src/operations.ts';
const OPERATIONS_SERVICE =
  'apps/api/src/modules/operations/operations.service.ts';
const PASSPORTS_SERVICE =
  'apps/api/src/modules/passports/passports.service.ts';
const PASSPORTS_MODULE =
  'apps/api/src/modules/passports/passports.module.ts';
const PACKING_SERVICE =
  'apps/api/src/modules/packing/packing.service.ts';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const WEB_STOCK_API = 'apps/web/lib/stock-api.ts';
const WEB_MOVEMENTS_TABLE =
  'apps/web/components/warehouses/stock/stock-movements-table.tsx';
const ADMIN_OP_CREATE_FORM =
  'apps/web/app/admin/operations/create-form.tsx';
const ADMIN_OP_EDIT_FORM =
  'apps/web/app/admin/operations/[id]/edit-form.tsx';
const ADMIN_OP_LIST = 'apps/web/app/admin/operations/page.tsx';
const ADMIN_OP_ACTIONS = 'apps/web/app/admin/operations/actions.ts';
const MATERIAL_ISSUES_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const PURCHASE_RECEIPTS_SERVICE =
  'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts';
const COSTS_SERVICE = 'apps/api/src/modules/costs/costs.service.ts';

// ---------------------------------------------------------------------------
// 1. Схема и migration
// ---------------------------------------------------------------------------

test('Operation содержит producesFinishedGoods Boolean @default(false)', () => {
  const src = read(SCHEMA);
  const block = src.match(/model\s+Operation\s*\{[\s\S]*?\n\}/)?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(
    /producesFinishedGoods\s+Boolean\s+@default\(false\)/,
  );
});

test('Migration для producesFinishedGoods создан', () => {
  const dirs = readdirSync(join(repoRoot, 'prisma/migrations'));
  const target = dirs.find((d) =>
    d.endsWith('add_operation_produces_finished_goods'),
  );
  expect(target).toBeTruthy();
  const sql = read(`prisma/migrations/${target}/migration.sql`);
  expect(sql).toMatch(/ALTER TABLE\s+"Operation"/i);
  expect(sql).toMatch(/"producesFinishedGoods"\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+false/i);
});

// ---------------------------------------------------------------------------
// 2. Shared DTO / Zod
// ---------------------------------------------------------------------------

test('CreateOperationSchema принимает producesFinishedGoods', () => {
  const src = read(SHARED_OPERATIONS);
  const create = src
    .split('export const CreateOperationSchema')
    .slice(1)
    .join('export const CreateOperationSchema');
  expect(create).toMatch(/producesFinishedGoods:\s*z\.boolean\(\)\.optional\(\)/);
});

test('UpdateOperationSchema принимает producesFinishedGoods', () => {
  const src = read(SHARED_OPERATIONS);
  const update = src
    .split('export const UpdateOperationSchema')
    .slice(1)
    .join('export const UpdateOperationSchema');
  expect(update).toMatch(/producesFinishedGoods:\s*z\.boolean\(\)\.optional\(\)/);
  // Должен быть в "хотя бы одно поле" refine.
  expect(update).toMatch(/obj\.producesFinishedGoods\s*!==\s*undefined/);
});

test('OperationSummaryDto экспортирует producesFinishedGoods', () => {
  const src = read(SHARED_OPERATIONS);
  const block = src.match(
    /export interface OperationSummaryDto\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/producesFinishedGoods:\s*boolean;/);
});

// ---------------------------------------------------------------------------
// 3. OperationsService — read & write
// ---------------------------------------------------------------------------

test('OperationsService.create передаёт producesFinishedGoods в Prisma', () => {
  const src = read(OPERATIONS_SERVICE);
  expect(src).toMatch(
    /producesFinishedGoods:\s*dto\.producesFinishedGoods\s*\?\?\s*false/,
  );
});

test('OperationsService.update обновляет producesFinishedGoods', () => {
  const src = read(OPERATIONS_SERVICE);
  expect(src).toMatch(
    /if\s*\(dto\.producesFinishedGoods\s*!==\s*undefined\)\s*\{[\s\S]*?data\.producesFinishedGoods\s*=\s*dto\.producesFinishedGoods/,
  );
});

test('OperationsService.toSummary возвращает producesFinishedGoods', () => {
  const src = read(OPERATIONS_SERVICE);
  const block = src
    .split('private toSummary(')
    .slice(1)
    .join('private toSummary(');
  expect(block).toMatch(
    /producesFinishedGoods:\s*row\.producesFinishedGoods/,
  );
});

// ---------------------------------------------------------------------------
// 4. FinishedGoodsService — recordPassportOutputInTx + idempotency
// ---------------------------------------------------------------------------

test('FinishedGoodsService.recordPassportOutputInTx существует', () => {
  const src = read(FG_SERVICE);
  expect(src).toMatch(/recordPassportOutputInTx\s*\(/);
  // Не требует PACKED — это новая обобщённая точка.
  const block = src
    .split('async recordPassportOutputInTx(')
    .slice(1)
    .join('async recordPassportOutputInTx(');
  // Soft-skip только при cancel/qty<=0 (а не PACKED).
  expect(block).toMatch(/PassportStatus\.CANCELLED/);
  // Использует общий sourceKey-builder.
  expect(block).toMatch(/buildPassportFinishedGoodsOutputSourceKey/);
});

test('recordPackedPassportInTx делегирует в recordPassportOutputInTx', () => {
  const src = read(FG_SERVICE);
  expect(src).toMatch(/recordPackedPassportInTx/);
  // Тонкая обёртка с проверкой PACKED.
  const block = src
    .split('async recordPackedPassportInTx(')
    .slice(1)
    .join('async recordPackedPassportInTx(');
  expect(block).toMatch(/PassportStatus\.PACKED/);
  expect(block).toMatch(/this\.recordPassportOutputInTx\(/);
});

test('buildPassportFinishedGoodsOutputSourceKey возвращает тот же ключ, что и packed', () => {
  const src = read(FG_CONSTANTS);
  // Совпадение реализаций (один паспорт → один выпуск).
  expect(src).toMatch(
    /buildPassportFinishedGoodsOutputSourceKey[\s\S]*?return\s+buildPackedPassportSourceKey/,
  );
});

test('FinishedGoodsMovement.sourceKey @unique сохраняется (защита от дублей)', () => {
  const src = read(SCHEMA);
  const block = src.match(
    /model\s+FinishedGoodsMovement\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/sourceKey\s+String\?\s+@unique/);
});

// ---------------------------------------------------------------------------
// 5. PassportsService — wiring scan + complete
// ---------------------------------------------------------------------------

test('PassportsModule импортирует FinishedGoodsModule', () => {
  const src = read(PASSPORTS_MODULE);
  expect(src).toMatch(/FinishedGoodsModule/);
});

test('PassportsService инъектирует FinishedGoodsService', () => {
  const src = read(PASSPORTS_SERVICE);
  expect(src).toMatch(
    /private\s+readonly\s+finishedGoods:\s*FinishedGoodsService/,
  );
});

test('scanOnOperation проверяет previous.producesFinishedGoods', () => {
  const src = read(PASSPORTS_SERVICE);
  const block = src
    .split('async scanOnOperation(')
    .slice(1)
    .join('async scanOnOperation(');
  expect(block).toMatch(/previousOperationProducesFinishedGoods/);
  expect(block).toMatch(/producesFinishedGoods:\s*true/);
  expect(block).toMatch(
    /this\.finishedGoods\.recordPassportOutputInTx\(/,
  );
  // Передаём triggerOperationId, чтобы audit/лог был информативным.
  expect(block).toMatch(/trigger:\s*'OPERATION_OUTPUT'/);
});

test('completeOperationByEmployee проверяет completed.producesFinishedGoods', () => {
  const src = read(PASSPORTS_SERVICE);
  const block = src
    .split('async completeOperationByEmployee(')
    .slice(1)
    .join('async completeOperationByEmployee(');
  expect(block).toMatch(/completedOperationProducesFinishedGoods/);
  expect(block).toMatch(/producesFinishedGoods:\s*true/);
  expect(block).toMatch(
    /this\.finishedGoods\.recordPassportOutputInTx\(/,
  );
  expect(block).toMatch(/trigger:\s*'OPERATION_OUTPUT'/);
});

// ---------------------------------------------------------------------------
// 6. Packing flow всё ещё пишет выпуск (нет дубля сценариев)
// ---------------------------------------------------------------------------

test('PackingService.addPassport по-прежнему вызывает recordPackedPassportInTx', () => {
  const src = read(PACKING_SERVICE);
  expect(src).toMatch(/this\.finishedGoods\.recordPackedPassportInTx\(/);
});

test('PackingService НЕ вызывает recordPassportOutputInTx напрямую (исключаем дубль вызовов)', () => {
  const src = read(PACKING_SERVICE);
  // Идемпотентность по sourceKey всё равно защищает, но
  // packing-flow сознательно проходит через wrapper, чтобы код
  // не вызывал две функции на одно событие.
  expect(src).not.toMatch(/this\.finishedGoods\.recordPassportOutputInTx\(/);
});

// ---------------------------------------------------------------------------
// 7. Movements API: clientId / clientName
// ---------------------------------------------------------------------------

test('FinishedGoodsMovementListItem содержит clientId/clientName', () => {
  const src = read(FG_SERVICE);
  const block = src.match(
    /export interface FinishedGoodsMovementListItem\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/clientId:\s*string\s*\|\s*null/);
  expect(block!).toMatch(/clientName:\s*string\s*\|\s*null/);
});

test('FinishedGoodsBalanceListItem содержит clientId/clientName', () => {
  const src = read(FG_SERVICE);
  const block = src.match(
    /export interface FinishedGoodsBalanceListItem\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/clientId:\s*string\s*\|\s*null/);
  expect(block!).toMatch(/clientName:\s*string\s*\|\s*null/);
});

test('toMovementListItem (FG) маппит row.order.client', () => {
  const src = read(FG_SERVICE);
  expect(src).toMatch(/clientId:\s*row\.order\?\.client\?\.id/);
  expect(src).toMatch(/clientName:\s*row\.order\?\.client\?\.name/);
});

test('StockMovementListItem содержит clientId/clientName (backend)', () => {
  const src = read(STOCK_SERVICE);
  const block = src.match(
    /export interface StockMovementListItem\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/clientId:\s*string\s*\|\s*null/);
  expect(block!).toMatch(/clientName:\s*string\s*\|\s*null/);
});

test('toStockMovementListItem маппит workshopNeed.order.client', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(
    /clientId:\s*row\.workshopNeed\?\.order\?\.client\?\.id/,
  );
  expect(src).toMatch(
    /clientName:\s*row\.workshopNeed\?\.order\?\.client\?\.name/,
  );
});

test('Web StockMovementListItem знает про clientId/clientName', () => {
  const src = read(WEB_STOCK_API);
  expect(src).toMatch(/clientId\?:\s*string\s*\|\s*null/);
  expect(src).toMatch(/clientName\?:\s*string\s*\|\s*null/);
});

// ---------------------------------------------------------------------------
// 8. UI колонка «Заказчик»
// ---------------------------------------------------------------------------

test('Stock movements table содержит колонку «Заказчик»', () => {
  const src = read(WEB_MOVEMENTS_TABLE);
  expect(src).toMatch(/header:\s*'Заказчик'/);
  expect(src).toMatch(/m\.clientName/);
});

// ---------------------------------------------------------------------------
// 9. Operations admin UI — checkbox и badge
// ---------------------------------------------------------------------------

test('Operations create-form содержит «Выпускает готовую продукцию»', () => {
  const src = read(ADMIN_OP_CREATE_FORM);
  expect(src).toMatch(/Выпускает готовую продукцию/);
  expect(src).toMatch(/name="producesFinishedGoods"/);
});

test('Operations edit-form содержит «Выпускает готовую продукцию»', () => {
  const src = read(ADMIN_OP_EDIT_FORM);
  expect(src).toMatch(/Выпускает готовую продукцию/);
  expect(src).toMatch(/name="producesFinishedGoods"/);
  expect(src).toMatch(/operation\.producesFinishedGoods/);
});

test('Operations admin actions парсят producesFinishedGoods', () => {
  const src = read(ADMIN_OP_ACTIONS);
  // create + update обе ветки.
  const occurrences = (
    src.match(/form\.get\('producesFinishedGoods'\)\s*===\s*'on'/g) ?? []
  ).length;
  expect(occurrences).toBeGreaterThanOrEqual(2);
});

test('Operations list table показывает badge «Выпуск ГП»', () => {
  const src = read(ADMIN_OP_LIST);
  expect(src).toMatch(/Выпуск ГП/);
  expect(src).toMatch(/op\.producesFinishedGoods/);
});

// ---------------------------------------------------------------------------
// 10. Не задели существующие контуры (гарантии ТЗ)
// ---------------------------------------------------------------------------

test('Не создаём отдельную операцию «Выпуск» через category enum', () => {
  const src = read(SCHEMA);
  // OperationCategory не должен пополниться значением RELEASE / OUTPUT —
  // выпуск управляется флагом `producesFinishedGoods`, не отдельной
  // категорией / операцией.
  const opCategoryEnum = src.match(/enum\s+OperationCategory\s*\{[\s\S]*?\}/)
    ?.[0];
  expect(opCategoryEnum).toBeTruthy();
  expect(opCategoryEnum!).not.toMatch(/\bRELEASE\b/);
  expect(opCategoryEnum!).not.toMatch(/\bOUTPUT\b/);
  expect(opCategoryEnum!).not.toMatch(/\bFINISHED_GOODS\b/);
});

test('Не создан /admin/finished-goods', () => {
  expect(exists('apps/web/app/admin/finished-goods')).toBe(false);
});

test('Sidebar не получил пункт finished-goods', () => {
  const src = read('apps/web/components/admin-sidebar.tsx');
  expect(src).not.toMatch(/href:\s*'\/admin\/finished-goods'/);
});

test('MaterialIssue / PurchaseReceipt / CostsService остались как есть', () => {
  expect(read(MATERIAL_ISSUES_SERVICE)).not.toMatch(/producesFinishedGoods/);
  expect(read(PURCHASE_RECEIPTS_SERVICE)).not.toMatch(/producesFinishedGoods/);
  if (exists(COSTS_SERVICE)) {
    expect(read(COSTS_SERVICE)).not.toMatch(/producesFinishedGoods/);
  }
});

test('OrderViewTabs не изменён под finished-goods', () => {
  const file = 'apps/web/components/orders/view/order-view-tabs.tsx';
  if (exists(file)) {
    const src = read(file);
    expect(src).not.toMatch(/finished-goods/i);
    expect(src).not.toMatch(/Готовая продукция/);
  }
  const cfg = 'apps/web/components/orders/view/order-view-tabs-config.ts';
  if (exists(cfg)) {
    const src = read(cfg);
    expect(src).not.toMatch(/finished-goods/i);
  }
});
