-- Sample-needs link: `WorkshopNeed.orderSampleId` (см.
-- `prisma/schema.prisma::WorkshopNeed`,
-- `apps/api/src/modules/order-samples/order-samples.service.ts`,
-- `apps/api/src/modules/workshop-needs/workshop-needs.service.ts::calculateForSampleInTx`,
-- `docs/order-signal-sample-flow.md §«Material modes»`).
--
-- Дизайн:
--   * Additive: 1 nullable колонка + 1 индекс + 1 FK. Старые строки
--     `WorkshopNeed` (тиражные) сохраняют `orderSampleId = NULL` —
--     инвариант «sample не пересекается с bulk» по умолчанию.
--   * `ON DELETE SET NULL`: удаление `OrderSample` (cascade от
--     заказа либо ручное) не сносит исторические строки
--     потребности; связь обнуляется. Это совместимо с инвариантом
--     `sourceId` (там тоже без FK ради сохранения истории).

ALTER TABLE "WorkshopNeed" ADD COLUMN "orderSampleId" TEXT;

CREATE INDEX "WorkshopNeed_orderSampleId_idx" ON "WorkshopNeed"("orderSampleId");

ALTER TABLE "WorkshopNeed"
  ADD CONSTRAINT "WorkshopNeed_orderSampleId_fkey"
    FOREIGN KEY ("orderSampleId") REFERENCES "OrderSample"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
