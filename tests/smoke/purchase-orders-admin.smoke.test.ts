/**
 * Source-level smoke-тесты модуля «Заказы поставщикам» (Purchase
 * Orders, Этап 6А, см. `apps/api/src/modules/purchase-orders/*`,
 * `apps/web/app/admin/purchase-orders/*`,
 * `docs/recon-soft-integration.md §«Этап 6А»`).
 *
 * Зачем нужны smoke-тесты: они быстро ловят регрессии «модуль
 * случайно отвалился из навигации / API-route ушёл в 404 / бэкенд
 * собирается без `PurchaseOrdersModule`», без поднятия БД.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Purchase orders (Этап 6А) — smoke', () => {
  test('AppModule подключает PurchaseOrdersModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/PurchaseOrdersModule/);
    expect(src).toMatch(/purchase-orders\/purchase-orders.module/);
  });

  test('Backend контроллеры повешены под нужные пути и RBAC', () => {
    const main = readSrc(
      'apps/api/src/modules/purchase-orders/purchase-orders.controller.ts',
    );
    expect(main).toMatch(/@Controller\(['"]purchase-orders['"]\)/);
    expect(main).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);
    expect(main).toMatch(/from-needs/);
    expect(main).toMatch(/\/send/);
    expect(main).toMatch(/\/confirm/);
    expect(main).toMatch(/\/cancel/);

    const orderCtrl = readSrc(
      'apps/api/src/modules/purchase-orders/purchase-orders.order-controller.ts',
    );
    expect(orderCtrl).toMatch(/@Controller\(['"]orders['"]\)/);
    expect(orderCtrl).toMatch(/:id\/purchase-orders/);
    expect(orderCtrl).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);
  });

  test('Sidebar показывает пункт «Заказы поставщикам» только за фичефлагом', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    // Runtime-гейт: пункт строится при `modules.purchaseOrders`
    // (набор с сервера через /api/auth/me), а не из build-time env.
    expect(src).toMatch(/modules\.purchaseOrders/);
    expect(src).toMatch(/Заказы поставщикам/);
    expect(src).toMatch(/\/admin\/purchase-orders/);
  });

  test('Закупки видны через OrderMaterialsUnifiedTable во вкладке «Потребности»', () => {
    // Order management redesign: отдельной вкладки «Логистика» с
    // `PurchaseOrdersCard` на управленческой карточке больше нет —
    // данные о PO интегрированы в `OrderMaterialsUnifiedTable`
    // (колонки «К закупке», «Поставщик», «Дата поступления» и т.п.),
    // и таблица рендерится из `OrderNeedsTab`. Сам компонент
    // `PurchaseOrdersCard` оставлен в коде как переиспользуемый
    // блок (используется на других admin-экранах).
    const page = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(page).not.toMatch(/PurchaseOrdersCard/);
    const unified = readSrc(
      'apps/web/components/orders/materials/order-materials-unified-table.tsx',
    );
    expect(unified).toMatch(/getOrderPurchaseOrders/);
  });

  test('PurchaseOrdersCard читает PO и линкует в /admin/purchase-orders', () => {
    const card = readSrc(
      'apps/web/components/orders/purchase-orders-card.tsx',
    );
    expect(card).toMatch(/getOrderPurchaseOrders/);
    expect(card).toMatch(/PURCHASE_ORDER_STATUS_LABELS/);
    expect(card).toMatch(/\/admin\/purchase-orders/);
  });

  test('API-клиент покрывает все требуемые методы', () => {
    const api = readSrc('apps/web/lib/purchase-orders-api.ts');
    expect(api).toMatch(/listPurchaseOrders/);
    expect(api).toMatch(/getPurchaseOrder/);
    expect(api).toMatch(/createPurchaseOrderFromNeeds/);
    expect(api).toMatch(/updatePurchaseOrder/);
    expect(api).toMatch(/updatePurchaseOrderLine/);
    expect(api).toMatch(/sendPurchaseOrder/);
    expect(api).toMatch(/confirmPurchaseOrder/);
    expect(api).toMatch(/cancelPurchaseOrder/);
    expect(api).toMatch(/getOrderPurchaseOrders/);
  });

  test('Shared контракт экспортирует статусы / схемы / DTO', () => {
    const shared = readSrc('packages/shared/src/purchase-orders.ts');
    expect(shared).toMatch(/PURCHASE_ORDER_STATUSES/);
    expect(shared).toMatch(/PURCHASE_ORDER_STATUS_LABELS/);
    expect(shared).toMatch(/PURCHASE_ORDER_LINE_STATUSES/);
    expect(shared).toMatch(/PURCHASE_ORDER_LINE_STATUS_LABELS/);
    expect(shared).toMatch(/CreatePurchaseOrderFromNeedsSchema/);
    expect(shared).toMatch(/UpdatePurchaseOrderSchema/);
    expect(shared).toMatch(/UpdatePurchaseOrderLineSchema/);
    expect(shared).toMatch(/ConfirmPurchaseOrderSchema/);
    expect(shared).toMatch(/ListPurchaseOrdersQuerySchema/);
    expect(shared).toMatch(/PurchaseOrderListItemDto/);
    expect(shared).toMatch(/PurchaseOrderDetailDto/);
    expect(shared).toMatch(/PurchaseOrderLineDto/);

    const barrel = readSrc('packages/shared/src/index.ts');
    expect(barrel).toMatch(/purchase-orders/);

    const pkg = JSON.parse(readSrc('packages/shared/package.json')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./purchase-orders']).toBe('./src/purchase-orders.ts');
  });

  test('Errors объявляют все исключения с правильными кодами', () => {
    const src = readSrc('apps/api/src/common/errors.ts');
    expect(src).toMatch(/PurchaseOrderNotFoundException/);
    expect(src).toMatch(/PURCHASE_ORDER_NOT_FOUND/);
    expect(src).toMatch(/PurchaseOrderLineNotFoundException/);
    expect(src).toMatch(/PURCHASE_ORDER_LINE_NOT_FOUND/);
    expect(src).toMatch(/PurchaseOrderNeedsRequiredException/);
    expect(src).toMatch(/PURCHASE_ORDER_NEEDS_REQUIRED/);
    expect(src).toMatch(/PurchaseOrderNeedsSupplierRequiredException/);
    expect(src).toMatch(/PURCHASE_ORDER_NEEDS_SUPPLIER_REQUIRED/);
    expect(src).toMatch(/PurchaseOrderNeedsDifferentSuppliersException/);
    expect(src).toMatch(/PURCHASE_ORDER_NEEDS_DIFFERENT_SUPPLIERS/);
    expect(src).toMatch(/PurchaseOrderNeedsDifferentOrdersException/);
    expect(src).toMatch(/PURCHASE_ORDER_NEEDS_DIFFERENT_ORDERS/);
    expect(src).toMatch(/PurchaseOrderNeedAlreadyOrderedException/);
    expect(src).toMatch(/PURCHASE_ORDER_NEED_ALREADY_ORDERED/);
    expect(src).toMatch(/PurchaseOrderNeedPurchaseQtyRequiredException/);
    expect(src).toMatch(/PURCHASE_ORDER_NEED_PURCHASE_QTY_REQUIRED/);
    expect(src).toMatch(/PurchaseOrderInvalidStatusTransitionException/);
    expect(src).toMatch(/PURCHASE_ORDER_INVALID_STATUS_TRANSITION/);
  });

  test('AuditService содержит entityType PURCHASE_ORDER', () => {
    const src = readSrc('apps/api/src/modules/audit/audit.service.ts');
    expect(src).toMatch(/['"]PURCHASE_ORDER['"]/);
    expect(src).toMatch(/PURCHASE_ORDER_CREATED/);
    expect(src).toMatch(/PURCHASE_ORDER_UPDATED/);
    expect(src).toMatch(/PURCHASE_ORDER_LINE_UPDATED/);
    expect(src).toMatch(/PURCHASE_ORDER_SENT/);
    expect(src).toMatch(/PURCHASE_ORDER_CONFIRMED/);
    expect(src).toMatch(/PURCHASE_ORDER_CANCELLED/);
  });

  test('Prisma schema объявляет PurchaseOrder + PurchaseOrderLine + back-relations', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/model PurchaseOrder\s*\{/);
    expect(src).toMatch(/model PurchaseOrderLine\s*\{/);
    // Status — TEXT (String), без enum.
    expect(src).toMatch(/status\s+String\s+@default\("DRAFT"\)/);
    // Back-relations.
    expect(src).toMatch(/purchaseOrders\s+PurchaseOrder\[\]/);
    expect(src).toMatch(/purchaseOrderLines\s+PurchaseOrderLine\[\]/);
    expect(src).toMatch(/createdPurchaseOrders PurchaseOrder\[\]/);
  });

  test('Migration создаёт таблицы PurchaseOrder + PurchaseOrderLine с FK', () => {
    const src = readSrc(
      'prisma/migrations/20260511100000_add_purchase_orders/migration.sql',
    );
    expect(src).toMatch(/CREATE TABLE "PurchaseOrder"/);
    expect(src).toMatch(/CREATE TABLE "PurchaseOrderLine"/);
    expect(src).toMatch(
      /CONSTRAINT "PurchaseOrder_supplierId_fkey"\s+FOREIGN KEY \("supplierId"\) REFERENCES "Supplier"\("id"\)/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseOrder_customerOrderId_fkey"\s+FOREIGN KEY \("customerOrderId"\) REFERENCES "Order"\("id"\)/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey"\s+FOREIGN KEY \("purchaseOrderId"\) REFERENCES "PurchaseOrder"\("id"\)\s+ON DELETE CASCADE/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseOrderLine_workshopNeedId_fkey"\s+FOREIGN KEY \("workshopNeedId"\) REFERENCES "WorkshopNeed"\("id"\)/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseOrderLine_supplierCatalogItemId_fkey"\s+FOREIGN KEY \("supplierCatalogItemId"\) REFERENCES "SupplierCatalogItem"\("id"\)/,
    );
    expect(src).toMatch(/CREATE UNIQUE INDEX "PurchaseOrder_number_key"/);
    expect(src).toMatch(/CREATE INDEX "PurchaseOrder_status_idx"/);
    expect(src).toMatch(/CREATE INDEX "PurchaseOrderLine_status_idx"/);
  });

  test('Workshop-needs admin содержит UI для создания PO', () => {
    const single = readSrc(
      'apps/web/app/admin/workshop-needs/create-po-button.tsx',
    );
    expect(single).toMatch(/createPurchaseOrderFromNeedsAction/);
    expect(single).toMatch(/Создать заказ поставщику/);

    const bulk = readSrc(
      'apps/web/app/admin/workshop-needs/bulk-create-po.tsx',
    );
    expect(bulk).toMatch(/createPurchaseOrderFromNeedsAction/);
    expect(bulk).toMatch(/BulkCreatePoProvider/);
    expect(bulk).toMatch(/BulkCreatePoCheckbox/);
  });

  test('WORKSHOP_NEED_STATUSES расширены ORDERED', () => {
    const src = readSrc('packages/shared/src/workshop-needs.ts');
    expect(src).toMatch(/['"]ORDERED['"]/);
    expect(src).toMatch(/ORDERED:\s*['"]Заказано поставщику['"]/);
  });

  test('.env.example документирует FEATURE_PURCHASE_ORDERS', () => {
    const src = readSrc('.env.example');
    expect(src).toMatch(/FEATURE_PURCHASE_ORDERS/);
  });
});
