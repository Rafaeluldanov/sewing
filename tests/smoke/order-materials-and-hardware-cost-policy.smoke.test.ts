/**
 * Smoke: упрощённый MVP давальческого сырья / фурнитуры клиента —
 * `Order.materialsAndHardwareCostPolicy` (см.
 *  `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
 *  `apps/api/src/modules/orders/orders.service.ts`,
 *  `apps/api/src/modules/costs/costs.service.ts`,
 *  `apps/api/src/modules/orders/order-cost-estimates.service.ts`,
 *  `packages/shared/src/orders.ts`,
 *  `apps/web/app/admin/orders/new/admin-create-order-form.tsx`,
 *  `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx`,
 *  `apps/web/components/orders/view/order-management-header.tsx`,
 *  `apps/web/components/orders/summary/build-order-summary-rows.ts`,
 *  `apps/web/components/orders/materials/order-materials-unified-table.tsx`,
 *  `docs/current-state.md §«Давальческое сырьё клиента»`).
 *
 * Это упрощённый вариант: расчёт потребности материалов и фурнитуры
 * продолжает работать; складские движения и MaterialIssue / Stock не
 * меняются. Меняется только финансовое включение MATERIAL / HARDWARE
 * в себестоимость заказа и production cost.
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
const MIGRATION_DIR =
  'prisma/migrations/20260614100000_add_order_materials_and_hardware_cost_policy';
const SHARED_ORDERS = 'packages/shared/src/orders.ts';
const ORDERS_SERVICE = 'apps/api/src/modules/orders/orders.service.ts';
const COSTS_SERVICE = 'apps/api/src/modules/costs/costs.service.ts';
const COST_ESTIMATES_SERVICE =
  'apps/api/src/modules/orders/order-cost-estimates.service.ts';
const CREATE_FORM =
  'apps/web/app/admin/orders/new/admin-create-order-form.tsx';
const EDIT_FORM =
  'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx';
const ORDERS_ACTIONS = 'apps/web/app/orders/actions.ts';
const EDIT_ACTIONS = 'apps/web/app/admin/orders/[id]/edit/actions.ts';
const ORDER_HEADER =
  'apps/web/components/orders/view/order-management-header.tsx';
const SUMMARY_BUILDER =
  'apps/web/components/orders/summary/build-order-summary-rows.ts';
const MATERIALS_TABLE =
  'apps/web/components/orders/materials/order-materials-unified-table.tsx';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const PURCHASE_RECEIPTS_SERVICE =
  'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts';
const WORKSHOP_NEEDS_SERVICE =
  'apps/api/src/modules/workshop-needs/workshop-needs.service.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';

// ---------------------------------------------------------------------------
// 1. Prisma schema + migration.
// ---------------------------------------------------------------------------

test('Prisma Order содержит materialsAndHardwareCostPolicy String @default("INCLUDE") + index', () => {
  const src = read(SCHEMA);
  expect(src).toMatch(
    /materialsAndHardwareCostPolicy\s+String\s+@default\("INCLUDE"\)/,
  );
  expect(src).toMatch(
    /@@index\(\[materialsAndHardwareCostPolicy\]\)/,
  );
});

test('Migration файл существует и поднимает колонку + индекс', () => {
  const sqlPath = `${MIGRATION_DIR}/migration.sql`;
  expect(exists(sqlPath)).toBe(true);
  const sql = read(sqlPath);
  expect(sql).toMatch(/ALTER TABLE "Order"/);
  expect(sql).toMatch(/"materialsAndHardwareCostPolicy"\s+TEXT\s+NOT NULL\s+DEFAULT 'INCLUDE'/);
  expect(sql).toMatch(/CREATE INDEX[\s\S]+materialsAndHardwareCostPolicy/);
});

// ---------------------------------------------------------------------------
// 2. Shared schemas / DTO.
// ---------------------------------------------------------------------------

test('Shared экспортирует ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES', () => {
  const src = read(SHARED_ORDERS);
  expect(src).toMatch(
    /ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES\s*=\s*\[\s*'INCLUDE',\s*'EXCLUDE',?\s*\]/,
  );
  expect(src).toMatch(/ORDER_MATERIALS_AND_HARDWARE_COST_POLICY_LABELS/);
  expect(src).toMatch(/Учитывать материалы и фурнитуру/);
  expect(src).toMatch(/Не учитывать материалы и фурнитуру/);
});

test('CreateOrderSchema принимает materialsAndHardwareCostPolicy', () => {
  const src = read(SHARED_ORDERS);
  const createBlock = src.match(
    /export const CreateOrderSchema[\s\S]*?\}\)\.superRefine/,
  )?.[0];
  expect(createBlock).toBeTruthy();
  expect(createBlock!).toMatch(/materialsAndHardwareCostPolicy/);
});

test('UpdateOrderSchema принимает materialsAndHardwareCostPolicy', () => {
  const src = read(SHARED_ORDERS);
  const updateBlock = src.match(
    /export const UpdateOrderSchema[\s\S]*?\}\);/,
  )?.[0];
  expect(updateBlock).toBeTruthy();
  expect(updateBlock!).toMatch(/materialsAndHardwareCostPolicy/);
});

test('OrderListItemDto содержит materialsAndHardwareCostPolicy', () => {
  const src = read(SHARED_ORDERS);
  expect(src).toMatch(
    /materialsAndHardwareCostPolicy\?:\s*OrderMaterialsAndHardwareCostPolicy/,
  );
});

// ---------------------------------------------------------------------------
// 3. OrdersService backend create/update/detail/list.
// ---------------------------------------------------------------------------

test('OrdersService сохраняет materialsAndHardwareCostPolicy и нормализует', () => {
  const src = read(ORDERS_SERVICE);
  expect(src).toMatch(/resolveMaterialsAndHardwareCostPolicy/);
  expect(src).toMatch(/normalizeMaterialsAndHardwareCostPolicy/);
  // На create default = INCLUDE.
  expect(src).toMatch(
    /materialsAndHardwareCostPolicy:[\s\S]*?resolveMaterialsAndHardwareCostPolicy/,
  );
  // DTO маппинг.
  expect(src).toMatch(
    /materialsAndHardwareCostPolicy:\s*\n?\s*normalizeMaterialsAndHardwareCostPolicy/,
  );
});

// ---------------------------------------------------------------------------
// 4. UI create/edit формы.
// ---------------------------------------------------------------------------

test('Order create form содержит «Учет материалов и фурнитуры в себестоимости»', () => {
  const src = read(CREATE_FORM);
  expect(src).toMatch(/Учет материалов и фурнитуры в себестоимости/);
  expect(src).toMatch(/name="materialsAndHardwareCostPolicy"/);
  expect(src).toMatch(
    /Не учитывать — давальческое сырьё \/ фурнитура клиента/,
  );
});

test('Order edit form содержит «Учет материалов и фурнитуры в себестоимости»', () => {
  const src = read(EDIT_FORM);
  expect(src).toMatch(/Учет материалов и фурнитуры в себестоимости/);
  expect(src).toMatch(/name="materialsAndHardwareCostPolicy"/);
});

test('OrderManagementHeader показывает «Материалы и фурнитура в себестоимости»', () => {
  const src = read(ORDER_HEADER);
  expect(src).toMatch(/Материалы и фурнитура в себестоимости/);
  expect(src).toMatch(/order\.materialsAndHardwareCostPolicy/);
  expect(src).toMatch(/Не учитываются/);
  expect(src).toMatch(/Учитываются/);
  // Бейдж «Давальческое сырьё / фурнитура клиента».
  expect(src).toMatch(/Давальческое сырьё \/ фурнитура клиента/);
});

// ---------------------------------------------------------------------------
// 5. Server actions парсят policy.
// ---------------------------------------------------------------------------

test('createOrderAction / updateOrderAction парсят materialsAndHardwareCostPolicy', () => {
  const ordersActions = read(ORDERS_ACTIONS);
  expect(ordersActions).toMatch(/parseMaterialsAndHardwareCostPolicy/);
  expect(ordersActions).toMatch(/materialsAndHardwareCostPolicy/);

  const editActions = read(EDIT_ACTIONS);
  expect(editActions).toMatch(/materialsAndHardwareCostPolicy/);
});

// ---------------------------------------------------------------------------
// 6. Order summary при EXCLUDE обнуляет план/факт по материалам и
//    фурнитуре; при INCLUDE — старая логика.
// ---------------------------------------------------------------------------

test('build-order-summary-rows.ts применяет policy=EXCLUDE для MATERIAL/HARDWARE', () => {
  const src = read(SUMMARY_BUILDER);
  expect(src).toMatch(/materialsAndHardwareCostPolicy/);
  expect(src).toMatch(/EXCLUDED_SECTIONS_FOR_GIVEN_MATERIAL/);
  expect(src).toMatch(/isFinanciallyExcludedRow/);
  // Material и Hardware в excluded set.
  expect(src).toMatch(/'MATERIAL'.*'HARDWARE'/s);
  // Display label для excluded строк.
  expect(src).toMatch(
    /ORDER_MATERIALS_AND_HARDWARE_EXCLUDED_LABEL\s*=\s*'не учитывается'/,
  );
  // computeOrderSummaryTotals знает про policy и обнуляет факт.
  expect(src).toMatch(
    /isMaterialsAndHardwareExcluded[\s\S]*?materialActualCostRub\s*=\s*0/,
  );
  // Order-level warning.
  expect(src).toMatch(
    /Материалы и фурнитура не учитываются в себестоимости/,
  );
});

// ---------------------------------------------------------------------------
// 7. Materials unified table: при EXCLUDE рисует «не учитывается»
//    в колонках стоимости.
// ---------------------------------------------------------------------------

test('OrderMaterialsUnifiedTable показывает «не учитывается» при EXCLUDE', () => {
  const src = read(MATERIALS_TABLE);
  expect(src).toMatch(/materialsAndHardwareCostPolicy/);
  expect(src).toMatch(/ExcludedCostCell/);
  expect(src).toMatch(/isCostExcludedRow/);
  expect(src).toMatch(/'не учитывается'|не учитывается/);
});

// ---------------------------------------------------------------------------
// 8. CostsService production cost: при EXCLUDE materialCost для
//    паспортов заказа = 0; piecework / salary остаются.
// ---------------------------------------------------------------------------

test('CostsService исключает materialCost для passport.order.materialsAndHardwareCostPolicy = EXCLUDE', () => {
  const src = read(COSTS_SERVICE);
  expect(src).toMatch(/materialsAndHardwareCostPolicy/);
  expect(src).toMatch(/excludedPassportIds/);
  expect(src).toMatch(/EXCLUDE/);
  // piecework / salary не привязаны к политике.
  expect(src).toMatch(/pieceworkCost/);
  expect(src).toMatch(/salaryCost/);
});

// ---------------------------------------------------------------------------
// 9. OrderCostEstimate (плановая себестоимость): при EXCLUDE строки
//    MATERIAL / HARDWARE не входят в totalCostRub.
// ---------------------------------------------------------------------------

test('OrderCostEstimatesService исключает MATERIAL / HARDWARE при EXCLUDE', () => {
  const src = read(COST_ESTIMATES_SERVICE);
  expect(src).toMatch(/materialsAndHardwareCostPolicy/);
  expect(src).toMatch(/isMaterialsAndHardwareExcluded/);
  // APPLICATION должна остаться — кодом проверим, что условие
  // ограничено двумя видами.
  expect(src).toMatch(
    /c\.kind\s*===\s*'MATERIAL'\s*\|\|\s*c\.kind\s*===\s*'HARDWARE'/,
  );
});

// ---------------------------------------------------------------------------
// 10. WorkshopNeed / material requirement расчёт НЕ отключается.
// ---------------------------------------------------------------------------

test('WorkshopNeedsService не получил policy-флаг (расчёт продолжает работать как раньше)', () => {
  const src = read(WORKSHOP_NEEDS_SERVICE);
  expect(src).not.toMatch(/materialsAndHardwareCostPolicy/);
});

// ---------------------------------------------------------------------------
// 11–13. MaterialIssue / Stock / PurchaseReceipt не меняются.
// ---------------------------------------------------------------------------

test('MaterialIssuesService не получил policy-флаг', () => {
  const src = read(MATERIAL_ISSUES_SERVICE);
  expect(src).not.toMatch(/materialsAndHardwareCostPolicy/);
});

test('StockService не получил policy-флаг', () => {
  const src = read(STOCK_SERVICE);
  expect(src).not.toMatch(/materialsAndHardwareCostPolicy/);
  // Foundation-методы остались на месте.
  expect(src).toMatch(/applyMovementInTx/);
});

test('PurchaseReceiptsService не получил policy-флаг', () => {
  const src = read(PURCHASE_RECEIPTS_SERVICE);
  expect(src).not.toMatch(/materialsAndHardwareCostPolicy/);
});

// ---------------------------------------------------------------------------
// 14. Не добавлены модели CustomerMaterialReceipt / MaterialStockLot /
//    master Material и ownership-поля.
// ---------------------------------------------------------------------------

test('Не добавлены отдельные модели давальческого сырья / lot / master Material', () => {
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/^model\s+CustomerMaterialReceipt\s*\{/m);
  expect(schema).not.toMatch(/^model\s+MaterialStockLot\s*\{/m);
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
});

test('Не добавлены ownership-поля (ownerClientId / ownerClient)', () => {
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/ownerClientId/);
  // Точечный матч, чтобы не споткнуться о случайные слова.
  expect(schema).not.toMatch(/\bownerClient\b/);
});

// ---------------------------------------------------------------------------
// 15. Не создана новая страница / sidebar item.
// ---------------------------------------------------------------------------

test('Не создана новая страница под давальческое сырьё', () => {
  expect(exists('apps/web/app/admin/given-materials')).toBe(false);
  expect(exists('apps/web/app/admin/customer-materials')).toBe(false);
});

test('Sidebar не получил новый пункт под давальческое сырьё', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/'Давальческое сырьё'/);
  expect(src).not.toMatch(/href:\s*'\/admin\/given-materials'/);
  expect(src).not.toMatch(/href:\s*'\/admin\/customer-materials'/);
});

// ---------------------------------------------------------------------------
// 16. Не вводим новые роли.
// ---------------------------------------------------------------------------

test('Новые роли (CUSTOMER_MATERIAL_OWNER / GIVEN_MATERIAL_MANAGER) не введены', () => {
  const schema = read(SCHEMA);
  const roleEnum = schema.match(/enum\s+Role\s*\{[\s\S]*?\}/)?.[0] ?? '';
  expect(roleEnum).not.toMatch(/\bCUSTOMER_MATERIAL_OWNER\b/);
  expect(roleEnum).not.toMatch(/\bGIVEN_MATERIAL_MANAGER\b/);
});
