-- Фича «Варианты просчёта», итерация 3: стадия расчёта PER ВАРИАНТ.
--
-- Жалоба цеха: «Перевести в расчёт» на одном варианте выглядел так,
-- будто в расчёт ушли ВСЕ варианты (статус — один на заказ), а
-- переключение вкладки само считало потребности варианта.
--
-- `OrderCalculation.sentToCalculationAt` — когда вариант ЯВНО отправлен
-- на расчёт. Черновики (null) не считаются ни активацией, ни клоном —
-- только кнопкой. Статус заказа остаётся документным (взводится первым
-- отправленным вариантом).
--
-- Бэкфилл: отправленным считается вариант, у которого уже есть строки
-- потребности, ЛИБО активный вариант заказа, прошедшего DRAFT.

-- AlterTable
ALTER TABLE "OrderCalculation" ADD COLUMN "sentToCalculationAt" TIMESTAMP(3);

-- Backfill 1: у варианта есть строки потребности → отправлен.
UPDATE "OrderCalculation" oc
SET "sentToCalculationAt" = CURRENT_TIMESTAMP
WHERE oc."sentToCalculationAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "WorkshopNeed" wn
    WHERE wn."orderCalculationId" = oc."id"
  );

-- Backfill 2: активный вариант заказа, ушедшего дальше черновика.
UPDATE "OrderCalculation" oc
SET "sentToCalculationAt" = CURRENT_TIMESTAMP
FROM "Order" o
WHERE o."id" = oc."orderId"
  AND oc."isActive"
  AND oc."sentToCalculationAt" IS NULL
  AND o."status" IN (
    'CALCULATION', 'CALCULATION_DONE', 'SAMPLE_PRODUCTION',
    'IN_PRODUCTION', 'DONE'
  );
