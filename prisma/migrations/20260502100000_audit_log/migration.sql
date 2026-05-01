-- Универсальный журнал управленческих событий (`AuditLog`).
-- См. `prisma/schema.prisma` модель `AuditLog`,
-- `apps/api/src/modules/audit/audit.service.ts`,
-- `docs/domain.md §«Audit log»`.
--
-- Дизайн (короткое резюме, развёрнутое объяснение — в schema.prisma):
--   * `event`/`entityType` — свободные строки, без enum, чтобы новые
--     типы событий не требовали миграции;
--   * `entityId` — id агрегата строкой, без FK (журнал переживает
--     удаление/архив агрегата);
--   * `employeeId` — nullable, без FK на `Employee` (учётка может
--     быть деактивирована, строка журнала должна уцелеть);
--   * `payload` — `JSONB`, в нём сервис складывает минимальный
--     полезный срез действия;
--   * индексы `(entityType, entityId)` (история по объекту) и
--     `createdAt` (общая лента / последние события).

CREATE TABLE "AuditLog" (
    "id"         TEXT          NOT NULL,
    "event"      TEXT          NOT NULL,
    "entityType" TEXT          NOT NULL,
    "entityId"   TEXT          NOT NULL,
    "payload"    JSONB         NOT NULL,
    "employeeId" TEXT,
    "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_entityType_entityId_idx"
    ON "AuditLog"("entityType", "entityId");

CREATE INDEX "AuditLog_createdAt_idx"
    ON "AuditLog"("createdAt");
