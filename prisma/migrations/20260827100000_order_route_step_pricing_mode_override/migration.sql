-- Per-order переопределение способа оплаты операции (оклад ⇄ сделка ⇄
-- поразмерная сделка) ВНУТРИ ЗАКАЗА. Справочник Operation.pricingMode не
-- меняется. Аддитивно, nullable; null = режим по дефолту операции.
ALTER TABLE "OrderRouteStep"
  ADD COLUMN IF NOT EXISTS "pricingModeOverride" "PricingMode";
