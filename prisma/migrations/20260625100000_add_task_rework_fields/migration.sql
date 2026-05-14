-- Workflow приёмки/доработки задач конструктору. См.:
--   prisma/schema.prisma::ConstructorTask.acceptedAt
--   prisma/schema.prisma::ConstructorTaskFile.direction
--   apps/api/src/modules/constructor-tasks/* (методы accept / requestRework)
--   apps/web/app/admin/constructor-tasks/[id]/* (кнопки приёмки и rework)
--
-- Изменения:
--   1) `ConstructorTask.acceptedAt` — момент финальной приёмки менеджером
--      (PENDING_ACCEPT → DONE). Сбрасывается при rework.
--   2) `ConstructorTaskFile.direction` — INITIAL/REWORK; для разделения
--      файлов брифа и файлов возврата на доработку. Старые записи
--      остаются NULL и трактуются UI как INITIAL.
--
-- Оба поля nullable — миграция безопасна для существующих данных,
-- backfill не требуется.
ALTER TABLE "ConstructorTask" ADD COLUMN "acceptedAt" TIMESTAMP(3);
ALTER TABLE "ConstructorTaskFile" ADD COLUMN "direction" TEXT;
