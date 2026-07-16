-- Фича «Варианты просчёта» (FEATURE_ORDER_CALCULATIONS), итерация 2:
-- потребности СОСУЩЕСТВУЮТ для нескольких вариантов одного заказа.
--
-- `WorkshopNeed.orderCalculationId` — штамп калькуляции, при которой
-- строка рассчитана (`calculateForOrder` штампует активную; пересчёт
-- удаляет/пересоздаёт ТОЛЬКО строки своей калькуляции). Производственно-
-- финансовые читатели фильтруются каноническим фрагментом
-- `OR: [{orderCalculationId: null}, {orderCalculation: {isActive: true}}]`;
-- закупочные экраны показывают все варианты с меткой.
--
-- Бэкфилл: тиражные строки (без orderSampleId) получают АКТИВНУЮ
-- калькуляцию своего заказа; sample-строки остаются NULL — контур
-- образцов от вариантов не зависит.

-- AlterTable
ALTER TABLE "WorkshopNeed" ADD COLUMN "orderCalculationId" TEXT;

-- CreateIndex
CREATE INDEX "WorkshopNeed_orderCalculationId_idx" ON "WorkshopNeed"("orderCalculationId");

-- AddForeignKey
ALTER TABLE "WorkshopNeed" ADD CONSTRAINT "WorkshopNeed_orderCalculationId_fkey" FOREIGN KEY ("orderCalculationId") REFERENCES "OrderCalculation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: тиражные строки → активная калькуляция заказа.
UPDATE "WorkshopNeed" wn
SET "orderCalculationId" = oc."id"
FROM "OrderCalculation" oc
WHERE oc."orderId" = wn."orderId"
  AND oc."isActive"
  AND wn."orderSampleId" IS NULL
  AND wn."orderCalculationId" IS NULL;
