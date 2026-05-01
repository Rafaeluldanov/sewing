-- Этап 6А «Заказы поставщикам» — закупочный документ без приёмки и
-- без склада (см. `prisma/schema.prisma::PurchaseOrder`,
-- `apps/api/src/modules/purchase-orders/*`,
-- `docs/recon-soft-integration.md §«Этап 6А»`).
--
-- Дизайн миграции:
--   * Добавляем две новые таблицы `PurchaseOrder` и
--     `PurchaseOrderLine` (плюс индексы).
--   * Добавляем FK:
--       - PurchaseOrder.supplierId        → Supplier.id        ON DELETE RESTRICT
--       - PurchaseOrder.customerOrderId   → Order.id           ON DELETE SET NULL
--       - PurchaseOrder.createdById       → Employee.id        ON DELETE SET NULL
--       - PurchaseOrderLine.purchaseOrderId         → PurchaseOrder.id        ON DELETE CASCADE
--       - PurchaseOrderLine.workshopNeedId          → WorkshopNeed.id         ON DELETE SET NULL
--       - PurchaseOrderLine.supplierCatalogItemId   → SupplierCatalogItem.id  ON DELETE SET NULL
--   * `status` — `TEXT` (без Postgres enum), список валидируется
--     Zod-ом на API (см. `@sewing/shared/purchase-orders`).
--   * Backward-compatibility:
--       - не трогаем `Order`, `OrderItem`, `Passport`,
--         `TechCard*`, `Pattern*`, `Route*`, `Product`,
--         `Warehouse*`, `Cell*` — этап 6А чисто additive.
--       - `WorkshopNeed.status` остаётся `TEXT` без проверки
--         CHECK; новый статус `ORDERED` валидируется только Zod-ом
--         (см. `WORKSHOP_NEED_STATUSES`).
--       - Никаких новых ролей в `Role` enum не добавляем.
--   * Никакой приёмки, MaterialReceipt, FabricRoll, складских
--     остатков, ячеек — это сознательная граница MVP.

-- ---------------------------------------------------------------------------
-- PurchaseOrder
-- ---------------------------------------------------------------------------

CREATE TABLE "PurchaseOrder" (
    "id"                      TEXT         NOT NULL,
    "number"                  TEXT         NOT NULL,
    "supplierId"              TEXT         NOT NULL,
    "supplierNameSnapshot"    TEXT         NOT NULL,
    "supplierPhoneSnapshot"   TEXT,
    "supplierWebsiteSnapshot" TEXT,
    "supplierAddressSnapshot" TEXT,
    "customerOrderId"         TEXT,
    "status"                  TEXT         NOT NULL DEFAULT 'DRAFT',
    "expectedDeliveryDate"    TIMESTAMP(3),
    "sentAt"                  TIMESTAMP(3),
    "confirmedAt"             TIMESTAMP(3),
    "cancelledAt"             TIMESTAMP(3),
    "comment"                 TEXT,
    "createdById"             TEXT,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseOrder_number_key" ON "PurchaseOrder"("number");

CREATE INDEX "PurchaseOrder_supplierId_idx"            ON "PurchaseOrder"("supplierId");
CREATE INDEX "PurchaseOrder_customerOrderId_idx"       ON "PurchaseOrder"("customerOrderId");
CREATE INDEX "PurchaseOrder_status_idx"                ON "PurchaseOrder"("status");
CREATE INDEX "PurchaseOrder_expectedDeliveryDate_idx"  ON "PurchaseOrder"("expectedDeliveryDate");
CREATE INDEX "PurchaseOrder_createdAt_idx"             ON "PurchaseOrder"("createdAt");

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_customerOrderId_fkey"
    FOREIGN KEY ("customerOrderId") REFERENCES "Order"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseOrderLine
-- ---------------------------------------------------------------------------

CREATE TABLE "PurchaseOrderLine" (
    "id"                       TEXT         NOT NULL,
    "purchaseOrderId"          TEXT         NOT NULL,
    "workshopNeedId"           TEXT,
    "supplierCatalogItemId"    TEXT,
    "itemNameSnapshot"         TEXT         NOT NULL,
    "supplierArticleSnapshot"  TEXT,
    "unitSnapshot"             TEXT         NOT NULL,
    "catalogLastPriceSnapshot" DECIMAL(14,2),
    "qty"                      DECIMAL(14,4) NOT NULL,
    "price"                    DECIMAL(14,2),
    "currency"                 TEXT,
    "expectedDeliveryDate"     TIMESTAMP(3),
    "confirmedQty"             DECIMAL(14,4),
    "confirmedPrice"           DECIMAL(14,2),
    "confirmedDeliveryDate"    TIMESTAMP(3),
    "status"                   TEXT         NOT NULL DEFAULT 'DRAFT',
    "comment"                  TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx"       ON "PurchaseOrderLine"("purchaseOrderId");
CREATE INDEX "PurchaseOrderLine_workshopNeedId_idx"        ON "PurchaseOrderLine"("workshopNeedId");
CREATE INDEX "PurchaseOrderLine_supplierCatalogItemId_idx" ON "PurchaseOrderLine"("supplierCatalogItemId");
CREATE INDEX "PurchaseOrderLine_status_idx"                ON "PurchaseOrderLine"("status");

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_workshopNeedId_fkey"
    FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_supplierCatalogItemId_fkey"
    FOREIGN KEY ("supplierCatalogItemId") REFERENCES "SupplierCatalogItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
