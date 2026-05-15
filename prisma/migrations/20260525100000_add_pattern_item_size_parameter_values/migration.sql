-- Этап «Погонные метры по размерам» — отдельная таблица численных
-- значений по размерам для параметра категории
-- (`PatternCategoryParameter`) в карточке лекала (`PatternItem`).
--
-- См. `prisma/schema.prisma::PatternItemSizeParameterValue`,
-- `apps/api/src/modules/patterns/patterns.service.ts::replaceSizeParameterValues`,
-- `apps/web/app/admin/patterns/[id]/size-parameter-values-form.tsx`,
-- `packages/shared/src/patterns.ts`,
-- `apps/api/src/modules/workshop-needs/workshop-needs.service.ts`.
--
-- Дизайн миграции:
--   * Чисто additive: создаём одну новую таблицу + FK + индексы.
--   * `PatternMaterialArea` НЕ трогаем — она хранит только AREA_M2_BY_SIZE
--     (площади м²) и используется как раньше. Погонные метры идут в
--     ОТДЕЛЬНУЮ таблицу, потому что AREA-таблица семантически про
--     `areaM2` (см. ТЗ §5 «Не использовать PatternMaterialArea»).
--   * `PatternItemParameterNorm` НЕ трогаем — фурнитура (QTY_PER_ITEM)
--     по-прежнему хранится там.
--   * `PatternCategoryParameter`, `PatternItem`, `Size` — не трогаем,
--     добавляем только relation-поля на стороне Prisma-моделей.
--   * Уникальность `(patternItemId, categoryParameterId, sizeId)`
--     гарантирует, что значение не задано дважды для одной тройки.
--   * `ON DELETE CASCADE` от трёх сторон: если удалили лекало,
--     параметр категории или размер — соответствующие значения
--     уезжают вместе. Backend дополнительно архивирует параметры
--     через `status = ARCHIVED` — архивные параметры не показываются
--     в UI блока «Погонные метры», но значения в БД остаются до
--     явной замены.
--   * На MVP таблица используется только для
--     `inputTypeSnapshot = LINEAR_M_BY_SIZE` (погонные метры),
--     `unit = "м пог."`, но schema допускает любые numeric-by-size
--     значения (snapshot полей различает их).

CREATE TABLE "PatternItemSizeParameterValue" (
  "id"                   TEXT          NOT NULL,
  "patternItemId"        TEXT          NOT NULL,
  "categoryParameterId"  TEXT          NOT NULL,
  "sizeId"               TEXT          NOT NULL,
  "roleKey"              TEXT          NOT NULL,
  "labelSnapshot"        TEXT          NOT NULL,
  "inputTypeSnapshot"    TEXT          NOT NULL,
  "unit"                 TEXT          NOT NULL,
  "value"                DECIMAL(14,4) NOT NULL,
  "comment"              TEXT,
  "createdAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "PatternItemSizeParameterValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternItemSizeParameterValue_patternItemId_categoryParamet_key"
  ON "PatternItemSizeParameterValue"("patternItemId", "categoryParameterId", "sizeId");

CREATE INDEX "PatternItemSizeParameterValue_patternItemId_idx"
  ON "PatternItemSizeParameterValue"("patternItemId");

CREATE INDEX "PatternItemSizeParameterValue_categoryParameterId_idx"
  ON "PatternItemSizeParameterValue"("categoryParameterId");

CREATE INDEX "PatternItemSizeParameterValue_sizeId_idx"
  ON "PatternItemSizeParameterValue"("sizeId");

CREATE INDEX "PatternItemSizeParameterValue_roleKey_idx"
  ON "PatternItemSizeParameterValue"("roleKey");

ALTER TABLE "PatternItemSizeParameterValue"
  ADD CONSTRAINT "PatternItemSizeParameterValue_patternItemId_fkey"
    FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatternItemSizeParameterValue"
  ADD CONSTRAINT "PatternItemSizeParameterValue_categoryParameterId_fkey"
    FOREIGN KEY ("categoryParameterId") REFERENCES "PatternCategoryParameter"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatternItemSizeParameterValue"
  ADD CONSTRAINT "PatternItemSizeParameterValue_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
