-- Этап «Фурнитура: разрешить несколько параметров категории с одним roleKey».
-- См. `prisma/schema.prisma` — `model PatternCategoryParameter`,
-- `packages/shared/src/pattern-categories.ts` — Zod-валидация уникальности
-- `roleKey` теперь живёт только для `inputType = AREA_M2_BY_SIZE` (на других
-- inputType-ах одинаковые `roleKey` допустимы — например, фурнитура с
-- `PACKAGING` для Люверсов / Молнии / Кнопок).
--
-- Дизайн миграции:
--   * Чисто ослабление ограничения: уникальный индекс
--     `PatternCategoryParameter_category_role_uniq` заменяем обычным
--     индексом с тем же набором колонок. Все существующие данные
--     остаются валидными, никакого backfill, никаких удалений
--     колонок или таблиц.
--   * Имя нового индекса соответствует Prisma-конвенции для
--     `@@index([categoryId, roleKey])`:
--     `PatternCategoryParameter_categoryId_roleKey_idx`.
--   * `PatternMaterialArea`, `Order`, `Product`, `WorkshopNeed`,
--     `PurchaseOrder`, `PurchaseReceipt`, `TechCardMaterialLine` —
--     не трогаем. См. ТЗ §10 «Не делать».
--   * Технический ключ `PACKAGING` остаётся в `MATERIAL_ROLES` как
--     legacy/internal, пользователь видит «Фурнитура» (UI labels
--     обновлены отдельно — см. форму категории).

-- Один Prisma-DDL-statement на индекс — никаких транзакций
-- (Prisma migrate сам обернёт в транзакцию).

-- Сначала снимаем уникальный индекс.
-- IF EXISTS — defence-in-depth для случаев, когда уникальный индекс
-- уже был ранее снят руками (например, на пилотных стендах).
DROP INDEX IF EXISTS "PatternCategoryParameter_category_role_uniq";

-- Затем создаём обычный индекс с тем же набором колонок.
-- IF NOT EXISTS — на случай, если индекс уже был создан вручную с
-- этим именем.
CREATE INDEX IF NOT EXISTS "PatternCategoryParameter_categoryId_roleKey_idx"
  ON "PatternCategoryParameter"("categoryId", "roleKey");
