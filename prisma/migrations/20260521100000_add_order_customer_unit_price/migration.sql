-- Этап «Цена продажи за единицу» (см. `prisma/schema.prisma`,
-- `apps/api/src/modules/orders/orders.service.ts`,
-- `packages/shared/src/orders.ts`).
--
-- Управленческое поле «цена продажи за 1 изделие» на заказе
-- покупателя. Используется в карточке заказа и списке заказов,
-- чтобы видеть выручку и маржу:
--   revenue = customerUnitPrice × Σ qtyPlan
--   margin  = revenue (RUB) − costEstimateTotalRub
--
-- Дизайн миграции — чисто additive:
--   * `customerUnitPrice` — `DECIMAL(14, 2)` nullable, ничего не
--     бэкафиллим. Исторические заказы остаются с `NULL`, UI рисует
--     «Цена продажи не указана».
--   * `customerCurrency` — `TEXT` nullable. На уровне Zod ограничено
--     `RUB`/`USD` (см. `MoneyCurrencySchema`); в БД оставляем
--     свободным TEXT, чтобы расширить список валют без новой
--     миграции.
--
-- Никаких изменений `WorkshopNeed` / `PurchaseOrder` /
-- `PurchaseReceipt` / `Supplier` / `PatternItem` / `TechCard` /
-- `Route` / `Passport` / payroll (`docs/recon-soft-integration.md
-- §«Не менять»).

ALTER TABLE "Order"
  ADD COLUMN "customerUnitPrice" DECIMAL(14, 2),
  ADD COLUMN "customerCurrency" TEXT;
