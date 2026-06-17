-- Подтип параметра категории (см. `prisma/schema.prisma::PatternCategoryParameter`,
-- каталог `@sewing/shared::MATERIAL_SUBTYPES`, UI `/admin/pattern-categories`).
-- Аддитивно: nullable-колонка `subtypeKey` для связи параметра категории с
-- конкретным подтипом из таблицы TEEON.pdf (SINTEPON / ZIPPER / DUBLERIN / ...).
-- `NULL` = параметр заведён вручную («Другое»), как во всех существующих
-- категориях, поэтому бэкфилл не нужен.
ALTER TABLE "PatternCategoryParameter"
  ADD COLUMN "subtypeKey" TEXT;
