-- Stage «Patterns MVP-1» — изолированный модуль «Лекала».
-- См. `prisma/schema.prisma` (`model PatternItem`, `model PatternSizeFile`,
-- `model PatternMaterialArea`), `apps/api/src/modules/patterns/*`,
-- `docs/recon-soft-integration.md §«План внедрения»`.
--
-- Дизайн миграции:
--   * три новые таблицы, ничего из существующих (`Order`, `OrderItem`,
--     `TechCard*`, `Passport`, `Size`, `Employee`, …) НЕ меняется.
--     Соответствует требованию «soft integration without touching orders».
--   * `PatternItem.article` глобально уникален — управленческий
--     идентификатор, дубликат → 409 на API (`PATTERN_ARTICLE_TAKEN`).
--   * `PatternSizeFile`: уникальный составной ключ
--     `(patternItemId, sizeId, version)` гарантирует, что версии файлов
--     по одному и тому же размеру не пересекаются. Версия считается
--     сервисом (`max(version) + 1`); удаление через UI = архивация
--     (`status = 'ARCHIVED'`), физический файл с диска НЕ удаляется.
--   * `PatternMaterialArea`: одна площадь на пару `(размер, роль)`. Роль
--     хранится строкой (без Postgres enum) — список ролей живёт в
--     `@sewing/shared/patterns::MATERIAL_ROLES`, расширяется без
--     миграции схемы.
--   * Cascade-удаление со стороны `PatternItem` (sizeFiles + materialAreas)
--     — ручная архивация лекала становится дешёвой операцией без
--     orphan-строк в дочерних таблицах.
--   * FK на `Size` БЕЗ каскадного удаления — справочник размеров
--     управленческий, удаление размера должно блокироваться, если на
--     него ссылается хотя бы одно лекало.
--   * FK `PatternSizeFile.uploadedById` — `ON DELETE SET NULL`: удаление
--     учётки сотрудника не должно сносить уже загруженный файл лекала.

CREATE TABLE "PatternItem" (
    "id"              TEXT         NOT NULL,
    "name"            TEXT         NOT NULL,
    "article"         TEXT         NOT NULL,
    "categoryCode"    TEXT,
    "previewImageUrl" TEXT,
    "description"     TEXT,
    "status"          TEXT         NOT NULL DEFAULT 'ACTIVE',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatternItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternItem_article_key" ON "PatternItem"("article");
CREATE INDEX "PatternItem_status_idx" ON "PatternItem"("status");

CREATE TABLE "PatternSizeFile" (
    "id"               TEXT         NOT NULL,
    "patternItemId"    TEXT         NOT NULL,
    "sizeId"           TEXT         NOT NULL,
    "fileUrl"          TEXT         NOT NULL,
    "originalFileName" TEXT         NOT NULL,
    "version"          INTEGER      NOT NULL DEFAULT 1,
    "status"           TEXT         NOT NULL DEFAULT 'ACTIVE',
    "uploadedById"     TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatternSizeFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternSizeFile_pattern_size_version_uniq"
    ON "PatternSizeFile"("patternItemId", "sizeId", "version");
CREATE INDEX "PatternSizeFile_patternItemId_idx" ON "PatternSizeFile"("patternItemId");

ALTER TABLE "PatternSizeFile"
  ADD CONSTRAINT "PatternSizeFile_patternItemId_fkey"
    FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatternSizeFile"
  ADD CONSTRAINT "PatternSizeFile_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PatternSizeFile"
  ADD CONSTRAINT "PatternSizeFile_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PatternMaterialArea" (
    "id"            TEXT          NOT NULL,
    "patternItemId" TEXT          NOT NULL,
    "sizeId"        TEXT          NOT NULL,
    "materialRole"  TEXT          NOT NULL,
    "areaM2"        DECIMAL(10,4) NOT NULL,
    "comment"       TEXT,
    "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "PatternMaterialArea_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternMaterialArea_pattern_size_role_uniq"
    ON "PatternMaterialArea"("patternItemId", "sizeId", "materialRole");
CREATE INDEX "PatternMaterialArea_patternItemId_materialRole_idx"
    ON "PatternMaterialArea"("patternItemId", "materialRole");

ALTER TABLE "PatternMaterialArea"
  ADD CONSTRAINT "PatternMaterialArea_patternItemId_fkey"
    FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatternMaterialArea"
  ADD CONSTRAINT "PatternMaterialArea_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
