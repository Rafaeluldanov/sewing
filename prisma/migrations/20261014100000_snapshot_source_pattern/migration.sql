-- Этап 3 плана «техкарты → номенклатура»: трассировка снапшота заказа на
-- НОМЕНКЛАТУРУ. Строка/параметр, материализованные из спецификации
-- карточки (`PatternItemMaterialLine` / `PatternItemSpecParameter`),
-- помечаются источником-лекалом — по этим полям пересборка решает
-- «перечитать источник или только пересчитать» (та же роль, что у
-- `sourceTechCardId`/`sourceTechCardLineId` для техкарт).
--
-- Без FK — сознательно, как у всех source-полей снапшота: источник могут
-- править и удалять, снимок обязан пережить (ADR-0022 §snapshot
-- independence). Существующие строки остаются с NULL (материализованы из
-- техкарты) и ведут себя как раньше.

ALTER TABLE "OrderMaterialRequirement"
  ADD COLUMN "sourcePatternItemId" TEXT,
  ADD COLUMN "sourcePatternLineId" TEXT;

ALTER TABLE "OrderTechCardParameter"
  ADD COLUMN "sourcePatternItemId" TEXT;
