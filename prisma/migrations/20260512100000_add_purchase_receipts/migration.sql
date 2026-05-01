-- Этап 7А «Приёмка поставок» — фактическая приёмка по конкретному
-- `PurchaseOrder` + размещение в физической ячейке (см.
-- `prisma/schema.prisma::PurchaseReceipt` / `PurchaseReceiptLine`,
-- `apps/api/src/modules/purchase-receipts/*`,
-- `docs/recon-soft-integration.md §«Этап 7А»`).
--
-- Дизайн миграции:
--   * Добавляем две новые таблицы `PurchaseReceipt` и
--     `PurchaseReceiptLine` (плюс индексы).
--   * Добавляем FK:
--       - PurchaseReceipt.purchaseOrderId            → PurchaseOrder.id        ON DELETE RESTRICT
--       - PurchaseReceipt.supplierId                 → Supplier.id             ON DELETE SET NULL
--       - PurchaseReceipt.customerOrderId            → Order.id                ON DELETE SET NULL
--       - PurchaseReceipt.receivedById               → Employee.id             ON DELETE SET NULL
--       - PurchaseReceiptLine.purchaseReceiptId      → PurchaseReceipt.id      ON DELETE CASCADE
--       - PurchaseReceiptLine.purchaseOrderLineId    → PurchaseOrderLine.id    ON DELETE SET NULL
--       - PurchaseReceiptLine.workshopNeedId         → WorkshopNeed.id         ON DELETE SET NULL
--       - PurchaseReceiptLine.supplierCatalogItemId  → SupplierCatalogItem.id  ON DELETE SET NULL
--       - PurchaseReceiptLine.cellId                 → Cell.id                 ON DELETE SET NULL
--   * `status` — `TEXT` (без Postgres enum), список валидируется
--     Zod-ом на API (см. `@sewing/shared/purchase-receipts`).
--   * Backward-compatibility:
--       - не трогаем `Order`, `OrderItem`, `Passport`, `TechCard*`,
--         `Pattern*`, `Route*`, `Product`, `Warehouse*`, `CellContent`
--         — этап 7А чисто additive.
--       - `PurchaseOrder.status` / `PurchaseOrderLine.status` /
--         `WorkshopNeed.status` остаются `TEXT` без CHECK-инвариантов;
--         новые статусы (`PARTIALLY_RECEIVED`/`RECEIVED`) добавляются
--         только в Zod-листы (см. `@sewing/shared/*`), без миграции.
--       - Никаких новых ролей в `Role` enum не вводим.
--   * НЕТ создания `MaterialStock` / `FabricRoll` / `CellContent` —
--     это сознательная граница MVP. Размещение хранится прямо в
--     `PurchaseReceiptLine.cellId`.

-- ---------------------------------------------------------------------------
-- PurchaseReceipt
-- ---------------------------------------------------------------------------

CREATE TABLE "PurchaseReceipt" (
    "id"                      TEXT         NOT NULL,
    "number"                  TEXT         NOT NULL,
    "purchaseOrderId"         TEXT         NOT NULL,
    "supplierId"              TEXT,
    "supplierNameSnapshot"    TEXT,
    "supplierPhoneSnapshot"   TEXT,
    "supplierWebsiteSnapshot" TEXT,
    "supplierAddressSnapshot" TEXT,
    "customerOrderId"         TEXT,
    "status"                  TEXT         NOT NULL DEFAULT 'POSTED',
    "receivedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt"             TIMESTAMP(3),
    "receivedById"            TEXT,
    "comment"                 TEXT,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseReceipt_number_key" ON "PurchaseReceipt"("number");

CREATE INDEX "PurchaseReceipt_purchaseOrderId_idx" ON "PurchaseReceipt"("purchaseOrderId");
CREATE INDEX "PurchaseReceipt_supplierId_idx"      ON "PurchaseReceipt"("supplierId");
CREATE INDEX "PurchaseReceipt_customerOrderId_idx" ON "PurchaseReceipt"("customerOrderId");
CREATE INDEX "PurchaseReceipt_status_idx"          ON "PurchaseReceipt"("status");
CREATE INDEX "PurchaseReceipt_receivedAt_idx"      ON "PurchaseReceipt"("receivedAt");
CREATE INDEX "PurchaseReceipt_createdAt_idx"       ON "PurchaseReceipt"("createdAt");

ALTER TABLE "PurchaseReceipt"
  ADD CONSTRAINT "PurchaseReceipt_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceipt"
  ADD CONSTRAINT "PurchaseReceipt_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceipt"
  ADD CONSTRAINT "PurchaseReceipt_customerOrderId_fkey"
    FOREIGN KEY ("customerOrderId") REFERENCES "Order"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceipt"
  ADD CONSTRAINT "PurchaseReceipt_receivedById_fkey"
    FOREIGN KEY ("receivedById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PurchaseReceiptLine
-- ---------------------------------------------------------------------------

CREATE TABLE "PurchaseReceiptLine" (
    "id"                       TEXT          NOT NULL,
    "purchaseReceiptId"        TEXT          NOT NULL,
    "purchaseOrderLineId"      TEXT,
    "workshopNeedId"           TEXT,
    "supplierCatalogItemId"    TEXT,
    "itemNameSnapshot"         TEXT          NOT NULL,
    "supplierArticleSnapshot"  TEXT,
    "unitSnapshot"             TEXT          NOT NULL,
    "orderedQtySnapshot"       DECIMAL(14,4),
    "confirmedQtySnapshot"     DECIMAL(14,4),
    "priceSnapshot"            DECIMAL(14,2),
    "currencySnapshot"         TEXT,
    "receivedQty"              DECIMAL(14,4) NOT NULL,
    "unit"                     TEXT          NOT NULL,
    "batchNumber"              TEXT,
    "rollNumber"               TEXT,
    "shade"                    TEXT,
    "actualWidthCm"            INTEGER,
    "actualDensityGsm"         INTEGER,
    "cellId"                   TEXT,
    "locationNote"             TEXT,
    "status"                   TEXT          NOT NULL DEFAULT 'POSTED',
    "comment"                  TEXT,
    "createdAt"                TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "PurchaseReceiptLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseReceiptLine_purchaseReceiptId_idx"     ON "PurchaseReceiptLine"("purchaseReceiptId");
CREATE INDEX "PurchaseReceiptLine_purchaseOrderLineId_idx"   ON "PurchaseReceiptLine"("purchaseOrderLineId");
CREATE INDEX "PurchaseReceiptLine_workshopNeedId_idx"        ON "PurchaseReceiptLine"("workshopNeedId");
CREATE INDEX "PurchaseReceiptLine_supplierCatalogItemId_idx" ON "PurchaseReceiptLine"("supplierCatalogItemId");
CREATE INDEX "PurchaseReceiptLine_cellId_idx"                ON "PurchaseReceiptLine"("cellId");
CREATE INDEX "PurchaseReceiptLine_status_idx"                ON "PurchaseReceiptLine"("status");

ALTER TABLE "PurchaseReceiptLine"
  ADD CONSTRAINT "PurchaseReceiptLine_purchaseReceiptId_fkey"
    FOREIGN KEY ("purchaseReceiptId") REFERENCES "PurchaseReceipt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceiptLine"
  ADD CONSTRAINT "PurchaseReceiptLine_purchaseOrderLineId_fkey"
    FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceiptLine"
  ADD CONSTRAINT "PurchaseReceiptLine_workshopNeedId_fkey"
    FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceiptLine"
  ADD CONSTRAINT "PurchaseReceiptLine_supplierCatalogItemId_fkey"
    FOREIGN KEY ("supplierCatalogItemId") REFERENCES "SupplierCatalogItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseReceiptLine"
  ADD CONSTRAINT "PurchaseReceiptLine_cellId_fkey"
    FOREIGN KEY ("cellId") REFERENCES "Cell"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
