-- =============================================================
-- PHASE 3 STEP 1: PayrollPayout data model
-- =============================================================
--
-- Что делает миграция:
--   1. Создаёт enum-ы `PayrollPayoutStatus`
--      (`DRAFT` / `ISSUED` / `ACKNOWLEDGED` / `CANCELLED`)
--      и `PayrollPayoutLineKind` (`PIECEWORK` / `SALARY`).
--   2. Создаёт таблицу `PayrollPayout` — управленческий документ
--      «выплата зарплаты сотруднику за период». Snapshot-итоги
--      `amountPieceworkRub` / `amountSalaryRub` / `amountTotalRub`
--      фиксируются на момент `recompute` / `issue`.
--   3. Создаёт таблицу `PayrollPayoutLine` — строка выплаты,
--      ссылается ровно на одну из (`OperationEntry`, `SalaryEntry`)
--      плюс хранит `snapshot` JSON начисления на момент включения.
--   4. Заводит индексы под фильтры payroll/period
--      (`employeeId, status`, `periodFrom, periodTo`,
--      `status, createdAt`) и под обратные join-ы строк
--      (`payoutId`, `operationEntryId`, `salaryEntryId`,
--      `kind, occurredOn`).
--
-- Что НЕ трогаем:
--   - `OperationEntry` и `SalaryEntry` НЕ получают paid-флагов:
--     статус выплаты живёт только в `PayrollPayout`.
--   - На `PayrollPayoutLine.operationEntryId` /
--     `.salaryEntryId` сознательно НЕТ `UNIQUE`: после
--     `CANCELLED` выплаты строки начислений снова доступны
--     для включения в новую выплату. Активную уникальность
--     («строка в максимум одной не-CANCELLED выплате») проверяет
--     `PayrollPayoutsService` в рантайме.
--
-- Backward compatibility:
--   - Чисто аддитивная миграция: новые типы и таблицы, без
--     изменения существующих колонок / индексов / FK.
--   - Откат: `DROP TABLE "PayrollPayoutLine"; DROP TABLE
--     "PayrollPayout"; DROP TYPE "PayrollPayoutLineKind"; DROP
--     TYPE "PayrollPayoutStatus";`. Никаких внешних зависимостей
--     до появления `PayrollPayoutsService` (PHASE 3 STEP 2+).
-- =============================================================

-- CreateEnum
CREATE TYPE "PayrollPayoutStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollPayoutLineKind" AS ENUM ('PIECEWORK', 'SALARY');

-- CreateTable
CREATE TABLE "PayrollPayout" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "status" "PayrollPayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "amountPieceworkRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amountSalaryRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amountTotalRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "managerComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByEmployeeId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPayoutLine" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "kind" "PayrollPayoutLineKind" NOT NULL,
    "operationEntryId" TEXT,
    "salaryEntryId" TEXT,
    "amountRub" DECIMAL(12,2) NOT NULL,
    "occurredOn" DATE NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollPayoutLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollPayout_employeeId_status_idx" ON "PayrollPayout"("employeeId", "status");

-- CreateIndex
CREATE INDEX "PayrollPayout_periodFrom_periodTo_idx" ON "PayrollPayout"("periodFrom", "periodTo");

-- CreateIndex
CREATE INDEX "PayrollPayout_status_createdAt_idx" ON "PayrollPayout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PayrollPayoutLine_payoutId_idx" ON "PayrollPayoutLine"("payoutId");

-- CreateIndex
CREATE INDEX "PayrollPayoutLine_operationEntryId_idx" ON "PayrollPayoutLine"("operationEntryId");

-- CreateIndex
CREATE INDEX "PayrollPayoutLine_salaryEntryId_idx" ON "PayrollPayoutLine"("salaryEntryId");

-- CreateIndex
CREATE INDEX "PayrollPayoutLine_kind_occurredOn_idx" ON "PayrollPayoutLine"("kind", "occurredOn");

-- AddForeignKey
ALTER TABLE "PayrollPayout"
  ADD CONSTRAINT "PayrollPayout_employeeId_fkey"
  FOREIGN KEY ("employeeId")
  REFERENCES "Employee"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayout"
  ADD CONSTRAINT "PayrollPayout_createdById_fkey"
  FOREIGN KEY ("createdById")
  REFERENCES "Employee"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayout"
  ADD CONSTRAINT "PayrollPayout_issuedById_fkey"
  FOREIGN KEY ("issuedById")
  REFERENCES "Employee"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayout"
  ADD CONSTRAINT "PayrollPayout_acknowledgedByEmployeeId_fkey"
  FOREIGN KEY ("acknowledgedByEmployeeId")
  REFERENCES "Employee"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayout"
  ADD CONSTRAINT "PayrollPayout_cancelledById_fkey"
  FOREIGN KEY ("cancelledById")
  REFERENCES "Employee"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayoutLine"
  ADD CONSTRAINT "PayrollPayoutLine_payoutId_fkey"
  FOREIGN KEY ("payoutId")
  REFERENCES "PayrollPayout"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayoutLine"
  ADD CONSTRAINT "PayrollPayoutLine_operationEntryId_fkey"
  FOREIGN KEY ("operationEntryId")
  REFERENCES "OperationEntry"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayoutLine"
  ADD CONSTRAINT "PayrollPayoutLine_salaryEntryId_fkey"
  FOREIGN KEY ("salaryEntryId")
  REFERENCES "SalaryEntry"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
