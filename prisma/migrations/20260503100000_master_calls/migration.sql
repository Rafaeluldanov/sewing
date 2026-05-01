-- Роль `SHOPFLOOR_MASTER` и модель `MasterCall` (MVP «Мастер цеха»).
--
-- См. `prisma/schema.prisma` (`enum Role`, `enum MasterCallStatus`,
-- `model MasterCall`), `apps/api/src/modules/master-calls/*`,
-- `docs/domain.md §«Мастер цеха»`, `docs/flows.md §«Вызов мастера»`.
--
-- Дизайн (короткое резюме, развёрнутое — в schema.prisma):
--   * новая роль `SHOPFLOOR_MASTER` добавляется в существующий enum
--     `Role` без break-change для уже выпущенных учёток;
--   * `MasterCallStatus` сразу содержит `OPEN/RESOLVED/CANCELLED` —
--     `CANCELLED` зарезервирован под будущее (auto-expire / отмена
--     рабочим), на MVP не пишется ни одним кодом;
--   * `equipmentId` / `operationId` — nullable: backend копирует их из
--     активной `ShiftSession` сотрудника при создании вызова, но если
--     смены нет (рабочий нажал кнопку до старта) — они остаются NULL,
--     и в этом случае дисплей рисует вызов в отдельном «orphan»-блоке
--     `Вызовы мастера`;
--   * `resolvedById` — nullable FK на `Employee` (мастер закрыл вызов;
--     учётка может быть удалена позже — поле остаётся valid через ON
--     SET NULL, но FK всё равно поставлен ради ясности и read-перфа);
--   * индексы рассчитаны на самые горячие выборки: `(status, createdAt)`
--     для очереди мастера, `(employeeId, status)` для idempotency, и
--     `(equipmentId, status)` для подсветки плиток оборудования на
--     `/shopfloor/display`.

-- 1. Роль -------------------------------------------------------------------

ALTER TYPE "Role" ADD VALUE 'SHOPFLOOR_MASTER';

-- 2. Enum статуса вызова ----------------------------------------------------

CREATE TYPE "MasterCallStatus" AS ENUM ('OPEN', 'RESOLVED', 'CANCELLED');

-- 3. Таблица вызовов --------------------------------------------------------

CREATE TABLE "MasterCall" (
    "id"           TEXT             NOT NULL,
    "employeeId"   TEXT             NOT NULL,
    "equipmentId"  TEXT,
    "operationId"  TEXT,
    "status"       "MasterCallStatus" NOT NULL DEFAULT 'OPEN',
    "message"      TEXT,
    "createdAt"    TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"   TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "MasterCall_pkey" PRIMARY KEY ("id")
);

-- 4. Индексы ----------------------------------------------------------------

CREATE INDEX "MasterCall_status_createdAt_idx"
    ON "MasterCall"("status", "createdAt");

CREATE INDEX "MasterCall_employeeId_status_idx"
    ON "MasterCall"("employeeId", "status");

CREATE INDEX "MasterCall_equipmentId_status_idx"
    ON "MasterCall"("equipmentId", "status");

-- 5. FK ---------------------------------------------------------------------

ALTER TABLE "MasterCall"
    ADD CONSTRAINT "MasterCall_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MasterCall"
    ADD CONSTRAINT "MasterCall_equipmentId_fkey"
    FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MasterCall"
    ADD CONSTRAINT "MasterCall_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "Operation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MasterCall"
    ADD CONSTRAINT "MasterCall_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
