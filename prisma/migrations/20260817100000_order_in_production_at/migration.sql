-- Этап «Ввод в производство» в карточке заказа.
-- Добавляем `Order.inProductionAt` — момент перехода заказа в IN_PRODUCTION.
ALTER TABLE "Order" ADD COLUMN "inProductionAt" TIMESTAMP(3);

-- Backfill исторических заказов: для уже находящихся в производстве
-- (IN_PRODUCTION) либо завершённых из него (DONE) точной даты запуска
-- нет, поэтому используем `updatedAt` как лучшее доступное приближение.
-- CANCELLED намеренно не трогаем: заказ мог быть отменён из DRAFT, так
-- что факт «был в производстве» не гарантирован.
UPDATE "Order"
SET "inProductionAt" = "updatedAt"
WHERE "status" IN ('IN_PRODUCTION', 'DONE')
  AND "inProductionAt" IS NULL;
