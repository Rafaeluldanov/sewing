-- Фича «Расцветки»: расчёт потребности цеха ПО КАЖДОЙ расцветке
-- (своя техкарта × поразмерный план цвета). Аддитивно, nullable:
-- старые строки = NULL = order-level (legacy). FK SetNull — удаление
-- расцветки не сносит историческую потребность/snapshot.

ALTER TABLE "WorkshopNeed" ADD COLUMN "orderVariantId" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "variantColor" TEXT;
ALTER TABLE "OrderMaterialRequirement" ADD COLUMN "orderVariantId" TEXT;
ALTER TABLE "OrderMaterialRequirement" ADD COLUMN "variantColor" TEXT;

CREATE INDEX "WorkshopNeed_orderVariantId_idx" ON "WorkshopNeed"("orderVariantId");
CREATE INDEX "OrderMaterialRequirement_orderVariantId_idx" ON "OrderMaterialRequirement"("orderVariantId");

ALTER TABLE "WorkshopNeed" ADD CONSTRAINT "WorkshopNeed_orderVariantId_fkey"
  FOREIGN KEY ("orderVariantId") REFERENCES "OrderVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderMaterialRequirement" ADD CONSTRAINT "OrderMaterialRequirement_orderVariantId_fkey"
  FOREIGN KEY ("orderVariantId") REFERENCES "OrderVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
