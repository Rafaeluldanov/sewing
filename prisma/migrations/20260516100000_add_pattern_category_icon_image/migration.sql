-- Этап «Загружаемая JPEG-иконка категории» — additive миграция: у
-- `PatternCategory` появляются два nullable-поля под загружаемую
-- иконку. См. `prisma/schema.prisma::PatternCategory`,
-- `apps/api/src/modules/pattern-categories/pattern-categories-storage.service.ts`,
-- `apps/web/app/admin/pattern-categories/new/*`.
--
-- Дизайн миграции:
--   * Чисто additive: добавляем `iconImageUrl` (TEXT NULL) и
--     `iconOriginalFileName` (TEXT NULL). Обе колонки nullable, чтобы
--     старые записи продолжали работать через legacy `iconKey`-fallback
--     (UI рисует lucide-иконку, если `iconImageUrl IS NULL`).
--   * Никаких destructive изменений: `iconKey` НЕ удаляется и НЕ
--     становится nullable — это сознательно, чтобы не ломать
--     существующие категории и не делать destructive миграцию.
--   * Никаких ALTER TABLE на других таблицах — Order / Product /
--     WorkshopNeed / PurchaseOrder / PurchaseReceipt / PatternMaterialArea
--     не трогаем.

ALTER TABLE "PatternCategory" ADD COLUMN "iconImageUrl"         TEXT;
ALTER TABLE "PatternCategory" ADD COLUMN "iconOriginalFileName" TEXT;
