-- Этап «Себестоимость заказа» (см. `prisma/schema.prisma`,
-- `apps/api/src/modules/orders/orders.service.ts::completeCalculation`,
-- `packages/shared/src/order-cost-estimates.ts`).
--
-- Дизайн миграции (additive, ничего не удаляем):
--   * расширяем enum `OrderStatus` значением `CALCULATION_DONE` —
--     отдельным statement, потому что Postgres не разрешает
--     `ALTER TYPE … ADD VALUE` внутри транзакции с другими DDL;
--   * добавляем три nullable-колонки snapshot на `Order`
--     (`costEstimateTotalRub` / `costEstimateCompletedAt` /
--     `costEstimateVersion`) — ничего не бэкафиллим, существующие
--     заказы остаются `NULL` и UI рисует «себестоимость не зафиксирована»;
--   * заводим две новые таблицы (`OrderCostEstimate`,
--     `OrderCostEstimateLine`) с FK и индексами.
--
-- Никаких правок `WorkshopNeed`, `PurchaseOrder`, `PurchaseReceipt`,
-- `Supplier`, `Passport`, `OrderApplication`, `PatternItem` и т.п.
-- (`docs/recon-soft-integration.md §«Не менять»`).

-- 1. ALTER TYPE — отдельным statement.
ALTER TYPE "OrderStatus" ADD VALUE 'CALCULATION_DONE';

-- 2. Snapshot-колонки на Order. Все nullable, без default —
--    backward-compatible с существующими заказами.
ALTER TABLE "Order"
  ADD COLUMN "costEstimateTotalRub" DECIMAL(14, 2),
  ADD COLUMN "costEstimateCompletedAt" TIMESTAMP(3),
  ADD COLUMN "costEstimateVersion" INTEGER;

-- 3. OrderCostEstimate — заголовок документа «Себестоимость заказа».
CREATE TABLE "OrderCostEstimate" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "totalCostRub" DECIMAL(14, 2) NOT NULL,
    "usdRateRub" DECIMAL(14, 4),
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCostEstimate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderCostEstimate_orderId_version_key"
    ON "OrderCostEstimate"("orderId", "version");

CREATE INDEX "OrderCostEstimate_orderId_idx" ON "OrderCostEstimate"("orderId");
CREATE INDEX "OrderCostEstimate_status_idx" ON "OrderCostEstimate"("status");

ALTER TABLE "OrderCostEstimate" ADD CONSTRAINT "OrderCostEstimate_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderCostEstimate" ADD CONSTRAINT "OrderCostEstimate_completedById_fkey"
    FOREIGN KEY ("completedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderCostEstimate" ADD CONSTRAINT "OrderCostEstimate_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. OrderCostEstimateLine — строки документа.
CREATE TABLE "OrderCostEstimateLine" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "workshopNeedId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "calculatedQty" DECIMAL(14, 4),
    "purchaseQty" DECIMAL(14, 4) NOT NULL,
    "quotedPrice" DECIMAL(14, 2) NOT NULL,
    "quotedCurrency" TEXT NOT NULL,
    "usdRateRub" DECIMAL(14, 4),
    "lineTotalOriginal" DECIMAL(14, 2) NOT NULL,
    "lineTotalRub" DECIMAL(14, 2) NOT NULL,
    "supplierNameSnapshot" TEXT,
    "purchaseItemNameSnapshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCostEstimateLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderCostEstimateLine_estimateId_idx" ON "OrderCostEstimateLine"("estimateId");
CREATE INDEX "OrderCostEstimateLine_workshopNeedId_idx" ON "OrderCostEstimateLine"("workshopNeedId");
CREATE INDEX "OrderCostEstimateLine_kind_idx" ON "OrderCostEstimateLine"("kind");

ALTER TABLE "OrderCostEstimateLine" ADD CONSTRAINT "OrderCostEstimateLine_estimateId_fkey"
    FOREIGN KEY ("estimateId") REFERENCES "OrderCostEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderCostEstimateLine" ADD CONSTRAINT "OrderCostEstimateLine_workshopNeedId_fkey"
    FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;
