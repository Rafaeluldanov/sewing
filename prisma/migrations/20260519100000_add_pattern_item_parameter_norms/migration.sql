-- Этап «Фурнитура и нормы» — таблица «норма на изделие» по
-- параметру категории (`PatternCategoryParameter`) для конкретной
-- карточки лекала (`PatternItem`).
--
-- См. `prisma/schema.prisma::PatternItemParameterNorm`,
-- `apps/api/src/modules/patterns/patterns.service.ts::replaceParameterNorms`,
-- `apps/web/app/admin/patterns/[id]/parameter-norms-form.tsx`,
-- `packages/shared/src/patterns.ts`,
-- `apps/api/src/modules/workshop-needs/workshop-needs.service.ts`.
--
-- Дизайн миграции:
--   * Чисто additive: создаём одну новую таблицу + FK + индексы.
--   * `PatternMaterialArea` НЕ трогаем — фурнитура хранится отдельно
--     и НЕ попадает в «Площади материалов» (см. ТЗ §11
--     «Не использовать PatternMaterialArea для фурнитуры»).
--   * `PatternCategoryParameter`, `PatternItem` — НЕ трогаем,
--     добавляем только relation-поля на стороне Prisma-модели.
--   * Уникальность `(patternItemId, categoryParameterId)` гарантирует,
--     что норма не задана дважды для одного параметра. Группа
--     «Фурнитура» внутри одной категории может иметь несколько
--     параметров с одним `roleKey = PACKAGING`, но они различаются
--     по `categoryParameterId` (Люверсы / Шнур / Наконечники).
--   * `ON DELETE CASCADE` от обеих сторон: если удалили лекало или
--     параметр категории — соответствующие нормы уезжают вместе.
--     Backend дополнительно архивирует параметры через `status =
--     ARCHIVED`, и архивные параметры не показываются в UI блока
--     «Фурнитура и нормы» (но норма в БД остаётся до явной замены).

CREATE TABLE "PatternItemParameterNorm" (
  "id"                   TEXT          NOT NULL,
  "patternItemId"        TEXT          NOT NULL,
  "categoryParameterId"  TEXT          NOT NULL,
  "roleKey"              TEXT          NOT NULL,
  "labelSnapshot"        TEXT          NOT NULL,
  "inputTypeSnapshot"    TEXT          NOT NULL,
  "unit"                 TEXT          NOT NULL,
  "qtyPerItem"           DECIMAL(14,4) NOT NULL,
  "comment"              TEXT,
  "createdAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "PatternItemParameterNorm_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternItemParameterNorm_pattern_param_uniq"
  ON "PatternItemParameterNorm"("patternItemId", "categoryParameterId");

CREATE INDEX "PatternItemParameterNorm_patternItemId_idx"
  ON "PatternItemParameterNorm"("patternItemId");

CREATE INDEX "PatternItemParameterNorm_categoryParameterId_idx"
  ON "PatternItemParameterNorm"("categoryParameterId");

CREATE INDEX "PatternItemParameterNorm_roleKey_idx"
  ON "PatternItemParameterNorm"("roleKey");

ALTER TABLE "PatternItemParameterNorm"
  ADD CONSTRAINT "PatternItemParameterNorm_patternItemId_fkey"
    FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatternItemParameterNorm"
  ADD CONSTRAINT "PatternItemParameterNorm_categoryParameterId_fkey"
    FOREIGN KEY ("categoryParameterId") REFERENCES "PatternCategoryParameter"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
