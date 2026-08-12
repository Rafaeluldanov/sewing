-- Этап 5 плана «техкарты → номенклатура» (анализ 11.08.2026): снос
-- шаблонного слоя техкарт. Состав материалов ведёт спецификация карточки
-- номенклатуры (этапы 1–4), бэкфилл выполнен миграцией
-- 20261013100000_backfill_pattern_material_spec — миграции упорядочены,
-- на проде данные переезжают ДО дропа.
--
-- СНАПШОТНЫЙ слой заказов не трогаем: OrderMaterialRequirement /
-- OrderOutsourceRequirement / OrderTechCardParameter живут дальше.
-- Исторические колонки трассировки (sourceTechCardId,
-- sourceTechCardLineId) ОСТАЮТСЯ строками без FK — снимок обязан
-- пережить источник (ADR-0022 §snapshot independence); удаляются только
-- сами FK-констрейнты, которые мешают дропу таблиц.

-- 1. FK снапшотов на строки шаблона (колонки остаются).
ALTER TABLE "OrderMaterialRequirement"
  DROP CONSTRAINT IF EXISTS "OrderMaterialRequirement_sourceTechCardLineId_fkey";
ALTER TABLE "OrderOutsourceRequirement"
  DROP CONSTRAINT IF EXISTS "OrderOutsourceRequirement_sourceTechCardLineId_fkey";

-- 2. Ссылки заказа/расцветки на шаблон — колонки удаляются целиком:
--    источник состава теперь один (Order.patternItemId → спецификация).
ALTER TABLE "Order"
  DROP CONSTRAINT IF EXISTS "Order_techCardId_fkey";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "techCardId";
ALTER TABLE "OrderVariant"
  DROP CONSTRAINT IF EXISTS "OrderVariant_techCardId_fkey";
ALTER TABLE "OrderVariant" DROP COLUMN IF EXISTS "techCardId";

-- 3. Таблицы шаблонного слоя.
DROP TABLE IF EXISTS "TechCardParameter";
DROP TABLE IF EXISTS "TechCardMaterialLine";
DROP TABLE IF EXISTS "TechCardOutsourceLine";
DROP TABLE IF EXISTS "TechCardTemplate";
