/**
 * Source-level smoke-тесты модуля «Приёмка поставок» (Purchase
 * Receipts, Этап 7А, см. `apps/api/src/modules/purchase-receipts/*`,
 * `apps/web/app/admin/purchase-receipts/*`,
 * `docs/recon-soft-integration.md §«Этап 7А»`).
 *
 * Зачем нужны smoke-тесты: они быстро ловят регрессии «модуль
 * случайно отвалился из навигации / API-route ушёл в 404 / бэкенд
 * собирается без `PurchaseReceiptsModule`», без поднятия БД.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Purchase receipts (Этап 7А) — smoke', () => {
  test('AppModule подключает PurchaseReceiptsModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/PurchaseReceiptsModule/);
    expect(src).toMatch(/purchase-receipts\/purchase-receipts.module/);
  });

  test('Backend контроллеры повешены под нужные пути и RBAC', () => {
    const main = readSrc(
      'apps/api/src/modules/purchase-receipts/purchase-receipts.controller.ts',
    );
    expect(main).toMatch(/@Controller\(['"]purchase-receipts['"]\)/);
    expect(main).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);
    expect(main).toMatch(/from-purchase-order/);
    expect(main).toMatch(/\/cancel/);

    const orderCtrl = readSrc(
      'apps/api/src/modules/purchase-receipts/purchase-receipts.order-controller.ts',
    );
    expect(orderCtrl).toMatch(/@Controller\(['"]orders['"]\)/);
    expect(orderCtrl).toMatch(/:id\/purchase-receipts/);
    expect(orderCtrl).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);

    const poCtrl = readSrc(
      'apps/api/src/modules/purchase-receipts/purchase-receipts.purchase-order-controller.ts',
    );
    expect(poCtrl).toMatch(/@Controller\(['"]purchase-orders['"]\)/);
    expect(poCtrl).toMatch(/:id\/receipts/);
    expect(poCtrl).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);
  });

  test('Sidebar показывает пункт «Приёмка поставок» только за фичефлагом', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS/);
    expect(src).toMatch(/FEATURE_PURCHASE_RECEIPTS_ENABLED/);
    expect(src).toMatch(/Приёмка поставок/);
    expect(src).toMatch(/\/admin\/purchase-receipts/);
  });

  test('Поступления видны через OrderMaterialsUnifiedTable во вкладке «Потребности»', () => {
    // Order management redesign: отдельной вкладки «Логистика» с
    // `PurchaseReceiptsCard` на управленческой карточке больше нет —
    // данные о приёмках интегрированы в `OrderMaterialsUnifiedTable`
    // (колонки «Принято», «В ячейках», «Дата поступления»). Сам
    // компонент `PurchaseReceiptsCard` остался переиспользуемым.
    const page = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(page).not.toMatch(/PurchaseReceiptsCard/);
    const unified = readSrc(
      'apps/web/components/orders/materials/order-materials-unified-table.tsx',
    );
    expect(unified).toMatch(/getOrderPurchaseReceipts/);
  });

  test('Карточка PO содержит блок «Приёмки» + кнопку «Принять поступление»', () => {
    const card = readSrc(
      'apps/web/app/admin/purchase-orders/[id]/receipts-card.tsx',
    );
    expect(card).toMatch(/getPurchaseOrderReceipts/);
    expect(card).toMatch(/Принять поступление/);
    expect(card).toMatch(/\/admin\/purchase-orders\/\$\{purchaseOrderId\}\/receive/);

    const receivePage = readSrc(
      'apps/web/app/admin/purchase-orders/[id]/receive/page.tsx',
    );
    expect(receivePage).toMatch(/ReceivePurchaseOrderForm/);
    expect(receivePage).toMatch(/PURCHASE_ORDER_RECEIVABLE_STATUSES/);
  });

  test('PurchaseReceiptsCard читает PR и линкует в /admin/purchase-receipts', () => {
    const card = readSrc(
      'apps/web/components/orders/purchase-receipts-card.tsx',
    );
    expect(card).toMatch(/getOrderPurchaseReceipts/);
    expect(card).toMatch(/PURCHASE_RECEIPT_STATUS_LABELS/);
    expect(card).toMatch(/\/admin\/purchase-receipts/);
  });

  test('API-клиент покрывает все требуемые методы', () => {
    const api = readSrc('apps/web/lib/purchase-receipts-api.ts');
    expect(api).toMatch(/listPurchaseReceipts/);
    expect(api).toMatch(/getPurchaseReceipt/);
    expect(api).toMatch(/createPurchaseReceiptFromPurchaseOrder/);
    expect(api).toMatch(/cancelPurchaseReceipt/);
    expect(api).toMatch(/getPurchaseOrderReceipts/);
    expect(api).toMatch(/getOrderPurchaseReceipts/);
  });

  test('Shared контракт экспортирует статусы / схемы / DTO', () => {
    const shared = readSrc('packages/shared/src/purchase-receipts.ts');
    expect(shared).toMatch(/PURCHASE_RECEIPT_STATUSES/);
    expect(shared).toMatch(/PURCHASE_RECEIPT_STATUS_LABELS/);
    expect(shared).toMatch(/PURCHASE_RECEIPT_LINE_STATUSES/);
    expect(shared).toMatch(/PURCHASE_RECEIPT_LINE_STATUS_LABELS/);
    expect(shared).toMatch(/CreatePurchaseReceiptFromPurchaseOrderSchema/);
    expect(shared).toMatch(/CancelPurchaseReceiptSchema/);
    expect(shared).toMatch(/ListPurchaseReceiptsQuerySchema/);
    expect(shared).toMatch(/PurchaseReceiptListItemDto/);
    expect(shared).toMatch(/PurchaseReceiptDetailDto/);
    expect(shared).toMatch(/PurchaseReceiptLineDto/);

    const barrel = readSrc('packages/shared/src/index.ts');
    expect(barrel).toMatch(/purchase-receipts/);

    const pkg = JSON.parse(readSrc('packages/shared/package.json')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./purchase-receipts']).toBe(
      './src/purchase-receipts.ts',
    );
  });

  test('Errors объявляют все исключения с правильными кодами', () => {
    const src = readSrc('apps/api/src/common/errors.ts');
    expect(src).toMatch(/PurchaseReceiptNotFoundException/);
    expect(src).toMatch(/PURCHASE_RECEIPT_NOT_FOUND/);
    expect(src).toMatch(/PurchaseReceiptLinesRequiredException/);
    expect(src).toMatch(/PURCHASE_RECEIPT_LINES_REQUIRED/);
    expect(src).toMatch(/PurchaseReceiptInvalidPurchaseOrderStatusException/);
    expect(src).toMatch(/PURCHASE_RECEIPT_INVALID_PURCHASE_ORDER_STATUS/);
    expect(src).toMatch(/PurchaseReceiptLineNotInOrderException/);
    expect(src).toMatch(/PURCHASE_RECEIPT_LINE_NOT_IN_ORDER/);
    expect(src).toMatch(/PurchaseReceiptQtyRequiredException/);
    expect(src).toMatch(/PURCHASE_RECEIPT_QTY_REQUIRED/);
    expect(src).toMatch(/PurchaseReceiptCellNotFoundException/);
    expect(src).toMatch(/PURCHASE_RECEIPT_CELL_NOT_FOUND/);
  });

  test('AuditService содержит entityType PURCHASE_RECEIPT', () => {
    const src = readSrc('apps/api/src/modules/audit/audit.service.ts');
    expect(src).toMatch(/['"]PURCHASE_RECEIPT['"]/);
    expect(src).toMatch(/PURCHASE_RECEIPT_CREATED/);
    expect(src).toMatch(/PURCHASE_RECEIPT_CANCELLED/);
  });

  test('Prisma schema объявляет PurchaseReceipt + PurchaseReceiptLine + back-relations', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/model PurchaseReceipt\s*\{/);
    expect(src).toMatch(/model PurchaseReceiptLine\s*\{/);
    // Status — TEXT (String), без enum.
    expect(src).toMatch(/status\s+String\s+@default\("POSTED"\)/);
    // Back-relations.
    expect(src).toMatch(/purchaseReceipts\s+PurchaseReceipt\[\]/);
    expect(src).toMatch(/receiptLines\s+PurchaseReceiptLine\[\]/);
    expect(src).toMatch(/receivedPurchaseReceipts PurchaseReceipt\[\]/);
    // `\s+` (а не одинарный пробел) — `prisma format` выравнивает
    // колонки по самому длинному имени связи в блоке Cell, и
    // добавление новых back-relations может расширить отступ.
    expect(src).toMatch(/purchaseReceiptLines\s+PurchaseReceiptLine\[\]/);
  });

  test('Migration создаёт таблицы PurchaseReceipt + PurchaseReceiptLine с FK', () => {
    const src = readSrc(
      'prisma/migrations/20260512100000_add_purchase_receipts/migration.sql',
    );
    expect(src).toMatch(/CREATE TABLE "PurchaseReceipt"/);
    expect(src).toMatch(/CREATE TABLE "PurchaseReceiptLine"/);
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceipt_purchaseOrderId_fkey"\s+FOREIGN KEY \("purchaseOrderId"\) REFERENCES "PurchaseOrder"\("id"\)\s+ON DELETE RESTRICT/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceipt_supplierId_fkey"\s+FOREIGN KEY \("supplierId"\) REFERENCES "Supplier"\("id"\)\s+ON DELETE SET NULL/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceipt_customerOrderId_fkey"\s+FOREIGN KEY \("customerOrderId"\) REFERENCES "Order"\("id"\)\s+ON DELETE SET NULL/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceipt_receivedById_fkey"\s+FOREIGN KEY \("receivedById"\) REFERENCES "Employee"\("id"\)\s+ON DELETE SET NULL/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceiptLine_purchaseReceiptId_fkey"\s+FOREIGN KEY \("purchaseReceiptId"\) REFERENCES "PurchaseReceipt"\("id"\)\s+ON DELETE CASCADE/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceiptLine_purchaseOrderLineId_fkey"\s+FOREIGN KEY \("purchaseOrderLineId"\) REFERENCES "PurchaseOrderLine"\("id"\)\s+ON DELETE SET NULL/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceiptLine_workshopNeedId_fkey"\s+FOREIGN KEY \("workshopNeedId"\) REFERENCES "WorkshopNeed"\("id"\)\s+ON DELETE SET NULL/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceiptLine_supplierCatalogItemId_fkey"\s+FOREIGN KEY \("supplierCatalogItemId"\) REFERENCES "SupplierCatalogItem"\("id"\)\s+ON DELETE SET NULL/,
    );
    expect(src).toMatch(
      /CONSTRAINT "PurchaseReceiptLine_cellId_fkey"\s+FOREIGN KEY \("cellId"\) REFERENCES "Cell"\("id"\)\s+ON DELETE SET NULL/,
    );
    expect(src).toMatch(/CREATE UNIQUE INDEX "PurchaseReceipt_number_key"/);
    expect(src).toMatch(/CREATE INDEX "PurchaseReceipt_status_idx"/);
    expect(src).toMatch(/CREATE INDEX "PurchaseReceiptLine_status_idx"/);
    expect(src).toMatch(/CREATE INDEX "PurchaseReceiptLine_cellId_idx"/);
  });

  test('PURCHASE_ORDER / WORKSHOP_NEED статусы расширены PARTIALLY_RECEIVED / RECEIVED', () => {
    const po = readSrc('packages/shared/src/purchase-orders.ts');
    expect(po).toMatch(/['"]PARTIALLY_RECEIVED['"]/);
    expect(po).toMatch(/['"]RECEIVED['"]/);
    expect(po).toMatch(/PARTIALLY_RECEIVED:\s*['"]Частично получено['"]/);
    expect(po).toMatch(/RECEIVED:\s*['"]Получено['"]/);
    expect(po).toMatch(/PURCHASE_ORDER_RECEIVABLE_STATUSES/);

    const need = readSrc('packages/shared/src/workshop-needs.ts');
    expect(need).toMatch(/['"]PARTIALLY_RECEIVED['"]/);
    expect(need).toMatch(/['"]RECEIVED['"]/);
    expect(need).toMatch(/PARTIALLY_RECEIVED:\s*['"]Частично получено['"]/);
    expect(need).toMatch(/RECEIVED:\s*['"]Получено['"]/);
  });

  test('Cancel server action есть в /admin/purchase-receipts', () => {
    const actions = readSrc('apps/web/app/admin/purchase-receipts/actions.ts');
    expect(actions).toMatch(/createPurchaseReceiptFromPurchaseOrderAction/);
    expect(actions).toMatch(/cancelPurchaseReceiptAction/);
  });

  test('.env.example документирует NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS', () => {
    const src = readSrc('.env.example');
    expect(src).toMatch(/NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS/);
  });
});
