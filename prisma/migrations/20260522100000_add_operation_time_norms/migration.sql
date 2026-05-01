-- Operation time norms (Этап 1 из `docs/operation-time-norms-recon.md`).
--
-- Что добавляем (additive):
--   1. Колонки `Operation.timeNormMode TEXT NOT NULL DEFAULT 'FIXED'`,
--      `Operation.timeNormSec INT NULL`.
--   2. Таблицу `OperationTimeNormBySize` с уникальным
--      `(operationId, sizeId)` и индексами.
--
-- Что НЕ трогаем:
--   - `Operation.pricingMode` / `Operation.fixedRate` — это другая ось
--     (тариф/деньги), payroll читает её через
--     `OperationsService.resolveRate`. Норма времени — отдельный
--     плановый контур (см. recon §10).
--   - `OperationRateBySize` — поразмерные ставки оставляем как есть.
--   - `Order` / `OrderCostEstimate` / `WorkshopNeed` — на этом этапе
--     заказов и себестоимости не касаемся.
--
-- Backfill-стратегия: ничего не делаем. Для всех существующих операций
-- срабатывает default `timeNormMode = 'FIXED'` и `timeNormSec = NULL`,
-- что в DTO интерпретируется как «норма не задана» и UI рисует «—».
-- Старые операции продолжают редактироваться без изменений поведения.

-- =============================================================
-- 1. ALTER Operation: timeNormMode, timeNormSec
-- =============================================================

ALTER TABLE "Operation"
    ADD COLUMN "timeNormMode" TEXT NOT NULL DEFAULT 'FIXED',
    ADD COLUMN "timeNormSec"  INTEGER;

-- =============================================================
-- 2. CREATE TABLE OperationTimeNormBySize
-- =============================================================

CREATE TABLE "OperationTimeNormBySize" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationTimeNormBySize_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationTimeNormBySize_operationId_sizeId_key"
    ON "OperationTimeNormBySize"("operationId", "sizeId");

CREATE INDEX "OperationTimeNormBySize_operationId_idx"
    ON "OperationTimeNormBySize"("operationId");

CREATE INDEX "OperationTimeNormBySize_sizeId_idx"
    ON "OperationTimeNormBySize"("sizeId");

ALTER TABLE "OperationTimeNormBySize"
    ADD CONSTRAINT "OperationTimeNormBySize_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "Operation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OperationTimeNormBySize"
    ADD CONSTRAINT "OperationTimeNormBySize_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
