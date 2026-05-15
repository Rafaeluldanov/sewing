-- Этап «Отправить изделие конструктору» (см.
--   prisma/schema.prisma::ConstructorTask,
--   prisma/schema.prisma::ConstructorTaskSizeRow,
--   prisma/schema.prisma::ConstructorTaskFile,
--   apps/api/src/modules/constructor-tasks/*,
--   apps/web/app/admin/orders/new/create-product-inline.tsx).
--
-- Создаём три новые таблицы:
--   - ConstructorTask         (1:1 с PatternItem, привязка к
--                              Employee.id для createdBy/assignedTo);
--   - ConstructorTaskSizeRow  (N строк, привязка к Size.id, погонные
--                              метры по Кулирке/Кашкорсе);
--   - ConstructorTaskFile     (N файлов, любые форматы).
--
-- PatternItem поле НЕ добавляем — связь односторонняя на стороне
-- ConstructorTask.patternItemId (UNIQUE). Размер хранится как FK
-- (nullable, SetNull) + sizeCodeSnapshot (всегда заполнен) — защита
-- от удаления/переименования размера.
--
-- Роль CONSTRUCTOR в enum Role в этой миграции НЕ добавляется —
-- кабинет конструктора будет отдельным PR.

-- ConstructorTask --------------------------------------------------
CREATE TABLE "ConstructorTask" (
  "id"            TEXT PRIMARY KEY,
  "patternItemId" TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'NEW',
  "comment"       TEXT NOT NULL DEFAULT '',
  "createdById"   TEXT,
  "assignedToId"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  "submittedAt"   TIMESTAMP(3)
);

CREATE UNIQUE INDEX "ConstructorTask_patternItemId_key"
  ON "ConstructorTask"("patternItemId");

CREATE INDEX "ConstructorTask_status_idx"
  ON "ConstructorTask"("status");

CREATE INDEX "ConstructorTask_assignedToId_status_idx"
  ON "ConstructorTask"("assignedToId", "status");

ALTER TABLE "ConstructorTask"
  ADD CONSTRAINT "ConstructorTask_patternItemId_fkey"
  FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConstructorTask"
  ADD CONSTRAINT "ConstructorTask_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "Employee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConstructorTask"
  ADD CONSTRAINT "ConstructorTask_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "Employee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ConstructorTaskSizeRow -------------------------------------------
CREATE TABLE "ConstructorTaskSizeRow" (
  "id"               TEXT PRIMARY KEY,
  "taskId"           TEXT NOT NULL,
  "sortOrder"        INTEGER NOT NULL,
  "sizeId"           TEXT,
  "sizeCodeSnapshot" TEXT NOT NULL,
  "kulirkaMeters"    DECIMAL(10, 4),
  "kashkorseMeters"  DECIMAL(10, 4)
);

CREATE UNIQUE INDEX "ConstructorTaskSizeRow_taskId_sizeId_key"
  ON "ConstructorTaskSizeRow"("taskId", "sizeId");

CREATE INDEX "ConstructorTaskSizeRow_taskId_sortOrder_idx"
  ON "ConstructorTaskSizeRow"("taskId", "sortOrder");

ALTER TABLE "ConstructorTaskSizeRow"
  ADD CONSTRAINT "ConstructorTaskSizeRow_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ConstructorTask"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConstructorTaskSizeRow"
  ADD CONSTRAINT "ConstructorTaskSizeRow_sizeId_fkey"
  FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ConstructorTaskFile ----------------------------------------------
CREATE TABLE "ConstructorTaskFile" (
  "id"               TEXT PRIMARY KEY,
  "taskId"           TEXT NOT NULL,
  "fileUrl"          TEXT NOT NULL,
  "originalFileName" TEXT NOT NULL,
  "contentType"      TEXT NOT NULL,
  "sizeBytes"        INTEGER NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ConstructorTaskFile_taskId_idx"
  ON "ConstructorTaskFile"("taskId");

ALTER TABLE "ConstructorTaskFile"
  ADD CONSTRAINT "ConstructorTaskFile_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ConstructorTask"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
