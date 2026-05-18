-- Inline-создание изделия из формы заказа (см.
--   prisma/schema.prisma::Order,
--   prisma/schema.prisma::TechCardTemplate,
--   apps/api/src/modules/orders/orders.service.ts::create,
--   apps/web/app/admin/orders/new/admin-create-order-form.tsx).
--
-- Добавляем три поля:
--   - Order.productCreationMode (String, default EXISTING_PATTERN);
--   - Order.patternDevelopmentCostRub (Decimal(12,2)?);
--   - TechCardTemplate.patternCategoryId (TEXT?, onDelete SET NULL).

ALTER TABLE "Order"
  ADD COLUMN "productCreationMode" TEXT NOT NULL DEFAULT 'EXISTING_PATTERN',
  ADD COLUMN "patternDevelopmentCostRub" DECIMAL(12, 2);

CREATE INDEX "Order_productCreationMode_idx"
  ON "Order"("productCreationMode");

ALTER TABLE "TechCardTemplate"
  ADD COLUMN "patternCategoryId" TEXT;

ALTER TABLE "TechCardTemplate"
  ADD CONSTRAINT "TechCardTemplate_patternCategoryId_fkey"
  FOREIGN KEY ("patternCategoryId") REFERENCES "PatternCategory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TechCardTemplate_patternCategoryId_idx"
  ON "TechCardTemplate"("patternCategoryId");
