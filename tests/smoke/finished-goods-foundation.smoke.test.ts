/**
 * Smoke: foundation готовой продукции
 * (см. `apps/api/src/modules/finished-goods/*`,
 *  `prisma/schema.prisma::FinishedGoodsBalance` / `FinishedGoodsMovement`,
 *  `apps/api/src/modules/packing/packing.service.ts`,
 *  `docs/current-state.md §«Готовая продукция»`,
 *  `docs/api.md §«Finished goods»`).
 *
 * Готовая продукция — отдельный контур от материалов
 * (`StockBalance` / `StockMovement` / `MaterialIssue` /
 * `PurchaseReceipt` / `StockAdjustment` / `StockTransfer` /
 * `CostsService` / `ProductionCostV2Service` НЕ затрагиваются).
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

const SCHEMA = 'prisma/schema.prisma';
const FG_SERVICE =
  'apps/api/src/modules/finished-goods/finished-goods.service.ts';
const FG_CONTROLLER =
  'apps/api/src/modules/finished-goods/finished-goods.controller.ts';
const FG_MODULE =
  'apps/api/src/modules/finished-goods/finished-goods.module.ts';
const FG_CONSTANTS =
  'apps/api/src/modules/finished-goods/finished-goods.constants.ts';
const FG_BALANCES_DTO =
  'apps/api/src/modules/finished-goods/dto/list-finished-goods-balances.dto.ts';
const FG_MOVEMENTS_DTO =
  'apps/api/src/modules/finished-goods/dto/list-finished-goods-movements.dto.ts';
const PACKING_SERVICE =
  'apps/api/src/modules/packing/packing.service.ts';
const PACKING_MODULE =
  'apps/api/src/modules/packing/packing.module.ts';
const APP_MODULE = 'apps/api/src/app.module.ts';
const AUDIT_SERVICE = 'apps/api/src/modules/audit/audit.service.ts';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';

// ---------------------------------------------------------------------------
// 1. Prisma schema
// ---------------------------------------------------------------------------

test('Prisma schema содержит FinishedGoodsBalance', () => {
  const src = read(SCHEMA);
  expect(src).toMatch(/^model\s+FinishedGoodsBalance\s*\{/m);
  // Поля
  expect(src).toMatch(/balanceKey\s+String\s+@unique/);
  expect(src).toMatch(/orderId\s+String/);
  expect(src).toMatch(/productId\s+String/);
  expect(src).toMatch(/sizeId\s+String/);
  expect(src).toMatch(/color\s+String/);
  expect(src).toMatch(/qty\s+Int\s+@default\(0\)/);
});

test('Prisma schema содержит FinishedGoodsMovement', () => {
  const src = read(SCHEMA);
  expect(src).toMatch(/^model\s+FinishedGoodsMovement\s*\{/m);
  expect(src).toMatch(/sourceKey\s+String\?\s+@unique/);
  expect(src).toMatch(/passportId\s+String\?/);
  expect(src).toMatch(/boxId\s+String\?/);
});

test('FinishedGoodsBalance связан с Order / Product / Size / Warehouse / Cell', () => {
  const src = read(SCHEMA);
  // Берём блок только для FinishedGoodsBalance.
  const block = src.match(
    /model\s+FinishedGoodsBalance\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/order\s+Order\s+@relation/);
  expect(block!).toMatch(/product\s+Product\s+@relation/);
  expect(block!).toMatch(/size\s+Size\s+@relation/);
  expect(block!).toMatch(/warehouse\s+Warehouse\?\s+@relation/);
  expect(block!).toMatch(/cell\s+Cell\?\s+@relation/);
});

test('FinishedGoodsMovement связан с Passport и Box', () => {
  const src = read(SCHEMA);
  const block = src.match(
    /model\s+FinishedGoodsMovement\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(block).toBeTruthy();
  expect(block!).toMatch(/passport\s+Passport\?\s+@relation/);
  expect(block!).toMatch(/box\s+Box\?\s+@relation/);
});

// ---------------------------------------------------------------------------
// 2. Service / module
// ---------------------------------------------------------------------------

test('FinishedGoodsService существует и экспортирует ключевые методы', () => {
  expect(exists(FG_SERVICE)).toBe(true);
  const src = read(FG_SERVICE);
  expect(src).toMatch(/export class FinishedGoodsService/);
  expect(src).toMatch(/recordPackedPassportInTx/);
  expect(src).toMatch(/applyMovementInTx/);
  expect(src).toMatch(/getOrCreateBalanceInTx/);
  expect(src).toMatch(/listBalances/);
  expect(src).toMatch(/listMovements/);
});

test('FinishedGoodsService использует Order.finishedGoodsWarehouseId', () => {
  const src = read(FG_SERVICE);
  expect(src).toMatch(/finishedGoodsWarehouseId/);
});

test('FinishedGoodsService записывает audit FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED', () => {
  const src = read(FG_SERVICE);
  expect(src).toMatch(/'FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED'/);
  expect(src).toMatch(/'FINISHED_GOODS_MOVEMENT'/);
});

test('FinishedGoodsService использует sourceKey PACKED_PASSPORT:<passportId>', () => {
  const src = read(FG_SERVICE);
  // Сервис использует `buildPassportFinishedGoodsOutputSourceKey`,
  // которая возвращает тот же идемпотентный ключ
  // `PACKED_PASSPORT:<passportId>` (см. constants).
  expect(src).toMatch(/buildPassportFinishedGoodsOutputSourceKey/);
  const constantsSrc = read(FG_CONSTANTS);
  expect(constantsSrc).toMatch(
    /buildPassportFinishedGoodsOutputSourceKey[\s\S]*buildPackedPassportSourceKey/,
  );
});

test('finished-goods.constants.ts содержит ключевые константы', () => {
  const src = read(FG_CONSTANTS);
  expect(src).toMatch(/PRODUCTION_RECEIPT:\s*'PRODUCTION_RECEIPT'/);
  expect(src).toMatch(/REVERSAL:\s*'REVERSAL'/);
  expect(src).toMatch(/ADJUSTMENT:\s*'ADJUSTMENT'/);
  expect(src).toMatch(/SHIPMENT:\s*'SHIPMENT'/);
  expect(src).toMatch(/TRANSFER:\s*'TRANSFER'/);
  expect(src).toMatch(/IN:\s*'IN'/);
  expect(src).toMatch(/OUT:\s*'OUT'/);
  expect(src).toMatch(/PACKED_PASSPORT:\s*'PACKED_PASSPORT'/);
  expect(src).toMatch(/buildPackedPassportSourceKey/);
  expect(src).toMatch(/buildFinishedGoodsBalanceKey/);
});

test('FinishedGoodsModule зарегистрирован в AppModule', () => {
  const src = read(APP_MODULE);
  expect(src).toMatch(/FinishedGoodsModule/);
});

test('FinishedGoodsModule экспортирует FinishedGoodsService', () => {
  const src = read(FG_MODULE);
  expect(src).toMatch(/exports:\s*\[\s*FinishedGoodsService\s*\]/);
  // controllers: [FinishedGoodsController, FinishedGoodsOrderShipmentsController]
  // — отгрузка из карточки заказа добавила второй контроллер.
  expect(src).toMatch(/FinishedGoodsController/);
  expect(src).toMatch(/FinishedGoodsOrderShipmentsController/);
});

// ---------------------------------------------------------------------------
// 3. Packing flow integration
// ---------------------------------------------------------------------------

test('PackingModule импортирует FinishedGoodsModule', () => {
  const src = read(PACKING_MODULE);
  expect(src).toMatch(/FinishedGoodsModule/);
});

test('PackingService.addPassport вызывает finishedGoods.recordPackedPassportInTx', () => {
  const src = read(PACKING_SERVICE);
  expect(src).toMatch(/FinishedGoodsService/);
  expect(src).toMatch(/this\.finishedGoods\.recordPackedPassportInTx\(/);
});

test('PackingService передаёт boxId в recordPackedPassportInTx', () => {
  const src = read(PACKING_SERVICE);
  // recordPackedPassportInTx(tx, passportId, employeeId, boxId)
  const callMatch = src.match(
    /recordPackedPassportInTx\([\s\S]*?\)/,
  )?.[0];
  expect(callMatch).toBeTruthy();
  expect(callMatch!).toMatch(/box\.id/);
});

// ---------------------------------------------------------------------------
// 4. Audit entity type
// ---------------------------------------------------------------------------

test('AuditEntityType содержит FINISHED_GOODS_MOVEMENT', () => {
  const src = read(AUDIT_SERVICE);
  expect(src).toMatch(/'FINISHED_GOODS_MOVEMENT'/);
});

// ---------------------------------------------------------------------------
// 5. Read-only API
// ---------------------------------------------------------------------------

test('FinishedGoodsController подключает GET /balances и /movements', () => {
  const src = read(FG_CONTROLLER);
  expect(src).toMatch(/@Controller\('finished-goods'\)/);
  expect(src).toMatch(/@Get\('balances'\)/);
  expect(src).toMatch(/@Get\('movements'\)/);
  expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
});

test('FinishedGoodsController использует Zod-схемы из dto', () => {
  const src = read(FG_CONTROLLER);
  expect(src).toMatch(
    /ZodValidationPipe\(ListFinishedGoodsBalancesQuerySchema\)/,
  );
  expect(src).toMatch(
    /ZodValidationPipe\(ListFinishedGoodsMovementsQuerySchema\)/,
  );
});

test('Balances DTO содержит limit/offset и фильтры', () => {
  const src = read(FG_BALANCES_DTO);
  expect(src).toMatch(/limit:\s*z\.coerce\.number\(\)/);
  expect(src).toMatch(/offset:\s*z\.coerce\.number\(\)/);
  expect(src).toContain('.max(200)');
  expect(src).toMatch(/orderId:/);
  expect(src).toMatch(/productId:/);
  expect(src).toMatch(/sizeId:/);
  expect(src).toMatch(/warehouseId:/);
  expect(src).toMatch(/cellId:/);
  expect(src).toMatch(/positiveOnly:/);
  expect(src).toMatch(/negativeOnly:/);
  expect(src).toMatch(/zeroOnly:/);
  expect(src).toMatch(/superRefine/);
});

test('Movements DTO содержит type/direction enum-ы', () => {
  const src = read(FG_MOVEMENTS_DTO);
  expect(src).toMatch(/limit:\s*z\.coerce\.number\(\)/);
  expect(src).toMatch(/offset:\s*z\.coerce\.number\(\)/);
  expect(src).toMatch(/'PRODUCTION_RECEIPT'/);
  expect(src).toMatch(/'REVERSAL'/);
  expect(src).toMatch(/'SHIPMENT'/);
  expect(src).toMatch(/'TRANSFER'/);
  expect(src).toMatch(/'IN'/);
  expect(src).toMatch(/'OUT'/);
  expect(src).toMatch(/passportId:/);
  expect(src).toMatch(/boxId:/);
});

test('sourceKey НЕ возвращается в read-only API', () => {
  const src = read(FG_SERVICE);
  // В list-item-shape (toMovementListItem) sourceKey должен быть исключён.
  const movementShape = src.match(
    /export interface FinishedGoodsMovementListItem\s*\{[\s\S]*?\n\}/,
  )?.[0];
  expect(movementShape).toBeTruthy();
  expect(movementShape!).not.toMatch(/^\s*sourceKey:/m);
});

// ---------------------------------------------------------------------------
// 6. Не задели существующие контуры
// ---------------------------------------------------------------------------

test('FinishedGoodsService не использует StockService / Stock-таблицы как код', () => {
  const src = read(FG_SERVICE);
  // В комментариях упоминаются StockBalance / StockMovement — это
  // допустимо (служит для объяснения «отдельный контур»). Здесь
  // проверяем именно отсутствие кодового использования: нет import
  // StockService, нет tx.stockBalance / tx.stockMovement, нет
  // прямой работы с этими prisma-моделями.
  expect(src).not.toMatch(/import\s+\{[^}]*StockService[^}]*\}/);
  expect(src).not.toMatch(/\bStockService\b\s*[,)]/);
  expect(src).not.toMatch(/tx\.stockBalance\./);
  expect(src).not.toMatch(/tx\.stockMovement\./);
  expect(src).not.toMatch(/prisma\.stockBalance\./);
  expect(src).not.toMatch(/prisma\.stockMovement\./);
});

test('StockService не получил поля finishedGoods*', () => {
  const src = read(STOCK_SERVICE);
  expect(src).not.toMatch(/finishedGoodsBalance/i);
  expect(src).not.toMatch(/finishedGoodsMovement/i);
  // Foundation методы материалов на месте.
  expect(src).toMatch(/applyMovementInTx/);
});

test('MaterialIssuesService не изменён под готовую продукцию', () => {
  const src = read(MATERIAL_ISSUES_SERVICE);
  expect(src).not.toMatch(/FinishedGoods/);
});

// ---------------------------------------------------------------------------
// 7. Не реализованы transfer / adjustment / новый UI-раздел
// ---------------------------------------------------------------------------

test('Отгрузка готовой продукции и отмена — реализованы из карточки заказа', () => {
  // Итерация «Отгрузка готовой продукции» добавила POST
  // /api/orders/:orderId/finished-goods-shipments; итерация
  // «Отмена / сторно отгрузки» — POST /api/finished-goods/shipments/:id/cancel.
  // Cancel реализуется БЕЗ создания нового документа: тот же
  // FinishedGoodsShipment получает status=CANCELLED + REVERSAL IN
  // (см. `tests/smoke/finished-goods-shipment-cancel.smoke.test.ts`).
  const src = read(FG_SERVICE);
  expect(src).toMatch(/createShipmentForOrder/);
  expect(src).toMatch(/FINISHED_GOODS_MOVEMENT_TYPE\.SHIPMENT/);
  expect(src).toMatch(/cancelShipment/);
  expect(src).toMatch(/FINISHED_GOODS_MOVEMENT_TYPE\.REVERSAL/);
  // Отдельных моделей-документов отмены НЕ появилось — итерация
  // решена через status=CANCELLED + REVERSAL IN.
  expect(src).not.toMatch(/finishedGoodsShipmentReturn/);
  expect(src).not.toMatch(/finishedGoodsShipmentCancel\b\./);
});

test('Не реализован transfer готовой продукции', () => {
  const src = read(FG_SERVICE);
  expect(src).not.toMatch(/createFinishedGoodsTransfer/);
  expect(src).not.toMatch(/recordFinishedGoodsTransfer/);
});

test('Не создан новый UI-раздел под готовую продукцию', () => {
  expect(exists('apps/web/app/admin/finished-goods')).toBe(false);
  expect(exists('apps/web/app/admin/finished-goods/page.tsx')).toBe(false);
});

test('Sidebar не получил новый пункт под готовую продукцию', () => {
  const src = read('apps/web/components/admin-sidebar.tsx');
  expect(src).not.toMatch(/href:\s*'\/admin\/finished-goods'/);
});

// ---------------------------------------------------------------------------
// 8. Migration существует
// ---------------------------------------------------------------------------

test('Migration файл создан', () => {
  expect(
    exists(
      'prisma/migrations/20260615100000_add_finished_goods_foundation/migration.sql',
    ),
  ).toBe(true);
  const src = read(
    'prisma/migrations/20260615100000_add_finished_goods_foundation/migration.sql',
  );
  expect(src).toMatch(/CREATE TABLE "FinishedGoodsBalance"/);
  expect(src).toMatch(/CREATE TABLE "FinishedGoodsMovement"/);
  expect(src).toMatch(/CREATE UNIQUE INDEX.*"FinishedGoodsBalance_balanceKey_key"/s);
  expect(src).toMatch(/CREATE UNIQUE INDEX.*"FinishedGoodsMovement_sourceKey_key"/s);
});
