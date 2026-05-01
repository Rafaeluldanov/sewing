-- Этап «Категории номенклатуры» — типизированный справочник категорий
-- лекал и их параметров материалов. См. `prisma/schema.prisma`
-- (`model PatternCategory`, `model PatternCategoryParameter`,
-- `model PatternItem.categoryId`),
-- `apps/api/src/modules/pattern-categories/*`,
-- `packages/shared/src/pattern-categories.ts`,
-- `docs/recon-soft-integration.md §«Этап Категории»».
--
-- Дизайн миграции:
--   * Чисто additive: создаём две новые таблицы и одно nullable поле
--     `categoryId` на `PatternItem` + FK `ON DELETE SET NULL`.
--   * Никаких destructive изменений: `categoryCode` остаётся как
--     legacy-fallback — старые записи без `categoryId` продолжают
--     работать; новые карточки используют `categoryId`.
--   * `PatternMaterialArea` НЕ трогается: `materialRole` остаётся
--     строкой, валидируется на API через параметры категории
--     (`PatternCategoryParameter.roleKey`) при наличии categoryId,
--     иначе fallback на глобальный `MATERIAL_ROLES`.
--   * `PatternCategoryParameter` каскадно удаляется вместе с
--     категорией (`ON DELETE CASCADE`), чтобы не оставалось висящих
--     параметров без родителя. Менеджер использует soft-archive —
--     hard-delete не предусмотрен на API уровне.
--   * Все индексы (`status`, `sortOrder`, `categoryId`) — для
--     дефолтных запросов списка/фильтра категорий и фильтра лекал
--     по категории.

-- 1) PatternCategory — справочник категорий.
CREATE TABLE "PatternCategory" (
  "id"          TEXT      NOT NULL,
  "name"        TEXT      NOT NULL,
  "slug"        TEXT      NOT NULL,
  "iconKey"     TEXT      NOT NULL,
  "sortOrder"   INTEGER   NOT NULL DEFAULT 100,
  "status"      TEXT      NOT NULL DEFAULT 'ACTIVE',
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PatternCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternCategory_slug_key" ON "PatternCategory"("slug");
CREATE INDEX "PatternCategory_status_idx" ON "PatternCategory"("status");
CREATE INDEX "PatternCategory_sortOrder_idx" ON "PatternCategory"("sortOrder");

-- 2) PatternCategoryParameter — параметры категории.
CREATE TABLE "PatternCategoryParameter" (
  "id"          TEXT      NOT NULL,
  "categoryId"  TEXT      NOT NULL,
  "roleKey"     TEXT      NOT NULL,
  "label"       TEXT      NOT NULL,
  "inputType"   TEXT      NOT NULL DEFAULT 'AREA_M2_BY_SIZE',
  "unit"        TEXT      NOT NULL DEFAULT 'м²',
  "isRequired"  BOOLEAN   NOT NULL DEFAULT false,
  "sortOrder"   INTEGER   NOT NULL DEFAULT 100,
  "status"      TEXT      NOT NULL DEFAULT 'ACTIVE',
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PatternCategoryParameter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternCategoryParameter_category_role_uniq"
  ON "PatternCategoryParameter"("categoryId", "roleKey");
CREATE INDEX "PatternCategoryParameter_categoryId_idx"
  ON "PatternCategoryParameter"("categoryId");
CREATE INDEX "PatternCategoryParameter_status_idx"
  ON "PatternCategoryParameter"("status");
CREATE INDEX "PatternCategoryParameter_sortOrder_idx"
  ON "PatternCategoryParameter"("sortOrder");

ALTER TABLE "PatternCategoryParameter"
  ADD CONSTRAINT "PatternCategoryParameter_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "PatternCategory"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) PatternItem.categoryId — soft FK на справочник.
ALTER TABLE "PatternItem"
  ADD COLUMN "categoryId" TEXT;

CREATE INDEX "PatternItem_categoryId_idx" ON "PatternItem"("categoryId");

ALTER TABLE "PatternItem"
  ADD CONSTRAINT "PatternItem_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "PatternCategory"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
