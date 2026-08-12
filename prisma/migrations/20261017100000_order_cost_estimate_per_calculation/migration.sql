-- Фича «Варианты просчёта заказа»: смета принадлежит ВАРИАНТУ.
--
-- Расчёт завершают по каждому варианту (клиент сравнивает готовые сметы),
-- выбор фиксирует запуск в производство. Поэтому `COMPLETED`-смет у
-- заказа может быть несколько — по одной на рассчитанный вариант, а
-- «смета заказа» = смета активного варианта.
--
-- См. `prisma/schema.prisma::OrderCostEstimate.orderCalculationId`,
-- `apps/api/src/modules/orders/cost-estimate-scope.ts`.

ALTER TABLE "OrderCostEstimate" ADD COLUMN "orderCalculationId" TEXT;

CREATE INDEX "OrderCostEstimate_orderCalculationId_idx"
  ON "OrderCostEstimate"("orderCalculationId");

ALTER TABLE "OrderCostEstimate"
  ADD CONSTRAINT "OrderCostEstimate_orderCalculationId_fkey"
  FOREIGN KEY ("orderCalculationId") REFERENCES "OrderCalculation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Бэкфилл: всё, что посчитано до фичи, принадлежит АКТИВНОМУ варианту
-- заказа (до этой миграции переключение вкладок было запрещено с
-- момента завершения расчёта, поэтому активный вариант и есть тот, по
-- которому смета считалась).
UPDATE "OrderCostEstimate" e
   SET "orderCalculationId" = c."id"
  FROM "OrderCalculation" c
 WHERE c."orderId" = e."orderId"
   AND c."isActive" = true
   AND e."orderCalculationId" IS NULL;
