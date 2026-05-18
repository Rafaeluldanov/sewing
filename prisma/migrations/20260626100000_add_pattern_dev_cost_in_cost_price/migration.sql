-- Чекбокс «входит в текущий расчёт себестоимости» рядом с полем
-- «Стоимость разработки лекала» (см.
--   prisma/schema.prisma::Order.patternDevelopmentCostInCostPrice,
--   apps/api/src/modules/orders/order-cost-estimates.service.ts::completeCalculation,
--   apps/web/app/admin/orders/new/create-product-inline.tsx).
--
-- Если флаг = true и patternDevelopmentCostRub > 0, completeCalculation
-- добавляет отдельную строку сметы (kind=OTHER) и сумма входит в
-- OrderCostEstimate.totalCostRub. Default true — историческое
-- поведение «не входит» меняется на «входит» по умолчанию (явно
-- запрошено в задаче).

ALTER TABLE "Order"
  ADD COLUMN "patternDevelopmentCostInCostPrice" BOOLEAN NOT NULL DEFAULT true;
