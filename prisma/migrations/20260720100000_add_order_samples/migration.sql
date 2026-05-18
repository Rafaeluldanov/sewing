-- MVP «Сигнальный образец» (см. `prisma/schema.prisma::OrderSample`,
-- `apps/api/src/modules/order-samples/*`,
-- `docs/order-signal-sample-flow.md`,
-- `docs/order-signal-sample-recon.md`).
--
-- Дизайн миграции:
--   * Additive: добавляем 2 enum + 1 таблицу + 1 nullable колонку
--     на `Passport` + индексы + FK. Существующие колонки не
--     меняются, backfill не нужен.
--   * `Passport.sampleId` — UNIQUE nullable: один паспорт ↔ один
--     `OrderSample`. Тиражные паспорта остаются с `sampleId = NULL`.
--     `ON DELETE SET NULL` — удаление `OrderSample` не сносит
--     паспорт (история сохраняется, связь обнуляется).
--   * `OrderSample.orderId` — `ON DELETE CASCADE`: без заказа
--     образец смысла не имеет.
--   * Никаких изменений `WorkshopNeed`, `OrderItem`, `MaterialIssue`,
--     `OrderRouteStep`, `RouteTemplate`, `Product`, `Size`,
--     `CutReleasePolicy`, `OrderCutIssueRule`, `Operation`,
--     `OperationEntry`, `SalaryEntry`, `Earnings`, payroll-, packing-,
--     QC-, WTO-моделей.
--   * Никаких новых ролей.

-- 1. Enum: жизненный цикл образца.
CREATE TYPE "OrderSampleStatus" AS ENUM (
  'IN_PROGRESS',
  'READY_FOR_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

-- 2. Enum: режим расчёта материалов для образца.
CREATE TYPE "OrderSampleMaterialMode" AS ENUM (
  'SAMPLE_ONLY',
  'FULL_ORDER'
);

-- 3. Таблица OrderSample.
CREATE TABLE "OrderSample" (
    "id"                   TEXT NOT NULL,
    "orderId"              TEXT NOT NULL,
    "productId"            TEXT NOT NULL,
    "sizeId"               TEXT NOT NULL,
    "qty"                  INTEGER NOT NULL DEFAULT 1,

    "routeTemplateId"      TEXT,

    "materialMode"         "OrderSampleMaterialMode" NOT NULL,
    "countsTowardOrderQty" BOOLEAN NOT NULL DEFAULT false,

    "status"               "OrderSampleStatus" NOT NULL DEFAULT 'IN_PROGRESS',

    "comment"              TEXT,
    "rejectionReason"      TEXT,

    "createdById"          TEXT,
    "approvedById"         TEXT,
    "rejectedById"         TEXT,

    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt"           TIMESTAMP(3),
    "rejectedAt"           TIMESTAMP(3),
    "cancelledAt"          TIMESTAMP(3),
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderSample_orderId_status_idx"   ON "OrderSample"("orderId", "status");
CREATE INDEX "OrderSample_orderId_sizeId_idx"   ON "OrderSample"("orderId", "sizeId");
CREATE INDEX "OrderSample_productId_idx"        ON "OrderSample"("productId");
CREATE INDEX "OrderSample_sizeId_idx"           ON "OrderSample"("sizeId");
CREATE INDEX "OrderSample_routeTemplateId_idx"  ON "OrderSample"("routeTemplateId");

ALTER TABLE "OrderSample"
  ADD CONSTRAINT "OrderSample_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderSample"
  ADD CONSTRAINT "OrderSample_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderSample"
  ADD CONSTRAINT "OrderSample_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderSample"
  ADD CONSTRAINT "OrderSample_routeTemplateId_fkey"
    FOREIGN KEY ("routeTemplateId") REFERENCES "RouteTemplate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Passport.sampleId — связь паспорта с OrderSample (1 ↔ 1).
ALTER TABLE "Passport" ADD COLUMN "sampleId" TEXT;

CREATE UNIQUE INDEX "Passport_sampleId_key" ON "Passport"("sampleId");

ALTER TABLE "Passport"
  ADD CONSTRAINT "Passport_sampleId_fkey"
    FOREIGN KEY ("sampleId") REFERENCES "OrderSample"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
