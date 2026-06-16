-- Этап «Корректировка материалов после просчёта».
--
-- 1) WorkshopNeed.isManual — флаг ручной строки потребности, добавленной
--    человеком уже после старта расчёта (sourceType=MANUAL_ADDITION), чтобы
--    покрыть непредвиденный расход материала внутри заказа. Аддитивно,
--    default false — поведение существующих строк не меняется.
--
-- 2) OrderExtraCost — прочие / непредвиденные расходы по заказу
--    (логистика, аутсорс, штрафы и т.п.), управленческая строка, которая
--    при includeInCostPrice=true вливается в OrderCostEstimateLine при
--    завершении / пересчёте себестоимости.

ALTER TABLE "WorkshopNeed" ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "WorkshopNeed_isManual_idx" ON "WorkshopNeed"("isManual");

CREATE TABLE "OrderExtraCost" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "includeInCostPrice" BOOLEAN NOT NULL DEFAULT true,
    "createdAtStatus" TEXT,
    "comment" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderExtraCost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderExtraCost_orderId_idx" ON "OrderExtraCost"("orderId");

ALTER TABLE "OrderExtraCost" ADD CONSTRAINT "OrderExtraCost_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderExtraCost" ADD CONSTRAINT "OrderExtraCost_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
