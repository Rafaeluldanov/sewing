-- Inline-создание изделия из формы заказа (см.
--   prisma/schema.prisma::Order,
--   prisma/schema.prisma::TechCardTemplate,
--   apps/api/src/modules/orders/orders.service.ts::create,
--   apps/web/app/admin/orders/new/admin-create-order-form.tsx).
--
-- Добавляем три поля:
--   - Order.productCreationMode (String, default EXISTING_PATTERN) —
--     режим заведения изделия по заказу: 'EXISTING_PATTERN' (старый
--     путь) или 'CREATE_FOR_CALCULATION' (новый inline-сценарий).
--     Свободная строка ради расширяемости (зарезервировано
--     'SEND_TO_CONSTRUCTOR'); Zod-валидация в shared.
--   - Order.patternDevelopmentCostRub (Decimal(12,2)?) —
--     стоимость разработки лекала из формы создания заказа,
--     заполняется только в новом сценарии. Управленческое поле,
--     в текущий расчёт себестоимости/потребности НЕ входит.
--   - TechCardTemplate.patternCategoryId (TEXT?) — soft-привязка
--     техкарты к группе номенклатуры. NULL допустим (исторические
--     техкарты), используется как фильтр в селекте при inline-
--     создании и как hint для совместимости. Совместимость
--     (TECH_CARD_NOT_COMPATIBLE_WITH_CATEGORY) валидируется
--     отдельно по materialRole vs параметрам категории.

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
