-- «Табель дня» в кабинете мастера: где сотрудник был, сколько времени и
-- сколько сделал (вкладка «Сотрудники» на `/master`).
--
-- Проблема, которую решает таблица. Смена (`ShiftSession`) умеет менять
-- операцию НА ЛЕТУ: `ShiftsService.switchOperation` перезаписывает
-- `operationId` у активной смены, не закрывая её (на одном станке
-- разрешено несколько операций — «Распошив подгиб» / «Распошив рукава», —
-- и швея переключается одним движением). Из-за этого от предыдущей
-- операции не остаётся следа: смена 8 часов с тремя переключениями в
-- отчёте выглядит как 8 часов ПОСЛЕДНЕЙ операции.
--
-- Смена участка (оверлок → ВТО → ОТК) работает иначе: она закрывает саму
-- смену (`MeService.switchWorkplace`), поэтому время по участкам
-- восстанавливалось и раньше. Сегменты дают ту же точность внутри смены.
--
-- Инвариант «не более одного открытого сегмента на смену» держит partial
-- unique index `shift_segment_open_session_uniq` — он заводится в
-- `apps/api/src/prisma/prisma-client-manager.ts` (там же, где
-- `shift_session_active_employee_uniq`), чтобы каждый тенант получал его
-- одинаково; здесь его нет сознательно.

CREATE TABLE "ShiftSegment" (
    "id" TEXT NOT NULL,
    "shiftSessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ShiftSegment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShiftSegment_employeeId_startedAt_idx" ON "ShiftSegment"("employeeId", "startedAt");
CREATE INDEX "ShiftSegment_shiftSessionId_idx" ON "ShiftSegment"("shiftSessionId");

ALTER TABLE "ShiftSegment" ADD CONSTRAINT "ShiftSegment_shiftSessionId_fkey"
    FOREIGN KEY ("shiftSessionId") REFERENCES "ShiftSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftSegment" ADD CONSTRAINT "ShiftSegment_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftSegment" ADD CONSTRAINT "ShiftSegment_equipmentId_fkey"
    FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftSegment" ADD CONSTRAINT "ShiftSegment_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Бэкфилл: по одному сегменту на каждую существующую смену.
--
-- Точность истории до этой миграции — до УЧАСТКА, не до операции:
-- переключения операции внутри смены не сохранялись нигде (только
-- `logger.log`), восстановить их неоткуда. Операция сегмента = та, что
-- осталась в смене последней; границы = границы самой смены. Для
-- закрытых смен это ровно прежняя картина, для открытых сегмент тоже
-- остаётся открытым — его закроет обычный `stop`.
INSERT INTO "ShiftSegment" ("id", "shiftSessionId", "employeeId", "equipmentId", "operationId", "startedAt", "endedAt")
SELECT
    -- Детерминированный id вместо cuid(): миграция обязана быть
    -- идемпотентной по данным, а gen_random_uuid() требует pgcrypto.
    'seg_backfill_' || "id",
    "id",
    "employeeId",
    "equipmentId",
    "operationId",
    "startedAt",
    "endedAt"
FROM "ShiftSession";
