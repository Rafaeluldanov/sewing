-- Этап «Ручная отметка поступления материала» — override готовности к
-- крою, который позволяет ADMIN/SHOP_MANAGER вручную пометить материал
-- как «поступивший» без оформления складской приёмки (см.
-- `prisma/schema.prisma::OrderMaterialArrivalOverride`,
-- `apps/api/src/modules/order-material-arrivals/*`,
-- `apps/api/src/modules/cut-readiness/cut-readiness.service.ts`).
--
-- Дизайн миграции:
--   * Добавляем одну новую таблицу `OrderMaterialArrivalOverride`
--     (плюс индексы и FK).
--   * НЕ трогаем `Order` / `OrderItem` / `WorkshopNeed` /
--     `PurchaseReceipt` / `PurchaseReceiptLine` / `CellContent` /
--     `Warehouse` / `Cell` / `Passport` / `OperationEntry` /
--     `SalaryEntry` / etc — миграция чисто additive.
--   * `status` — `TEXT` (без Postgres enum), список валидируется
--     Zod-ом на API (см.
--     `@sewing/shared/order-material-arrivals::ORDER_MATERIAL_ARRIVAL_OVERRIDE_STATUSES`).
--   * `comment` хранится TEXT, `min(2)`-валидация — Zod на API.
--   * FK:
--       - OrderMaterialArrivalOverride.orderId         → Order.id        ON DELETE CASCADE
--       - OrderMaterialArrivalOverride.workshopNeedId  → WorkshopNeed.id ON DELETE SET NULL
--       - OrderMaterialArrivalOverride.createdById     → Employee.id     ON DELETE SET NULL
--       - OrderMaterialArrivalOverride.revokedById     → Employee.id     ON DELETE SET NULL
--   * Без destructive-операций. На уже принятый материал (POSTED
--     `PurchaseReceiptLine`) override не влияет — он только
--     дополняет картину, никаких UPDATE/DELETE по чужим таблицам.

CREATE TABLE "OrderMaterialArrivalOverride" (
    "id"             TEXT          NOT NULL,
    "orderId"        TEXT          NOT NULL,
    "workshopNeedId" TEXT,
    "materialRole"   TEXT,
    "description"    TEXT,
    "qty"            DECIMAL(14,4),
    "unit"           TEXT,
    "status"         TEXT          NOT NULL DEFAULT 'ACTIVE',
    "comment"        TEXT,
    "createdById"    TEXT,
    "revokedAt"      TIMESTAMP(3),
    "revokedById"    TEXT,
    "revokeReason"   TEXT,
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "OrderMaterialArrivalOverride_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderMaterialArrivalOverride_orderId_idx"        ON "OrderMaterialArrivalOverride"("orderId");
CREATE INDEX "OrderMaterialArrivalOverride_workshopNeedId_idx" ON "OrderMaterialArrivalOverride"("workshopNeedId");
CREATE INDEX "OrderMaterialArrivalOverride_status_idx"         ON "OrderMaterialArrivalOverride"("status");
CREATE INDEX "OrderMaterialArrivalOverride_materialRole_idx"   ON "OrderMaterialArrivalOverride"("materialRole");

ALTER TABLE "OrderMaterialArrivalOverride"
  ADD CONSTRAINT "OrderMaterialArrivalOverride_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderMaterialArrivalOverride"
  ADD CONSTRAINT "OrderMaterialArrivalOverride_workshopNeedId_fkey"
    FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderMaterialArrivalOverride"
  ADD CONSTRAINT "OrderMaterialArrivalOverride_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderMaterialArrivalOverride"
  ADD CONSTRAINT "OrderMaterialArrivalOverride_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
