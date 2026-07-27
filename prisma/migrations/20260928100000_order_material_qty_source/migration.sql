-- Норма расхода строки снимка: откуда взята и чем трассируется.
--   NOMENCLATURE — из карточки номенклатуры (нормы фурнитуры / погонные метры / площади);
--   TEMPLATE     — из шаблона техкарты;
--   ORDER        — правлена прямо в заказе (главнее номенклатуры).
-- NULL — строки, созданные до этой миграции: пересчёт их не переписывает.
ALTER TABLE "OrderMaterialRequirement" ADD COLUMN "qtySource" TEXT;
ALTER TABLE "OrderMaterialRequirement" ADD COLUMN "qtySourceRef" TEXT;
