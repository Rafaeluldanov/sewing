-- =============================================================
-- PHASE 3 STEP 6.1: PayrollAccrualDocument data model
-- =============================================================
--
-- Что делает миграция:
--   1. Создаёт enum `PayrollAccrualDocumentStatus`
--      (`DRAFT` / `PAID` / `CANCELLED`).
--   2. Создаёт таблицу `PayrollAccrualDocument` — управленческий
--      документ «начисление зарплаты на дату». `accrualDate` —
--      дата расчёта включительно. Snapshot-итоги
--      `totalPieceworkRub` / `totalSalaryRub` / `totalAdjustRub` /
--      `totalToPayRub` фиксируются при формировании строк.
--   3. Создаёт таблицу `PayrollAccrualDocumentLine` — строка
--      документа, по одной на сотрудника. Хранит snapshot
--      начислений (`Json`) и опциональный FK `payoutId` на
--      созданный `PayrollPayout` после PAID.
--   4. Заводит индексы под фильтры list-API
--      (`status, accrualDate`, `createdById`, `paidById`,
--      `cancelledById`, `createdAt`) и под обратные join-ы строк
--      (`documentId`, `employeeId`, `payoutId`).
--   5. Unique-constraint `(documentId, employeeId)` гарантирует
--      ровно одну строку на сотрудника в документе.
--
-- Что НЕ трогаем:
--   - `OperationEntry`, `SalaryEntry`, `PayrollPayout` и весь
--     payroll-pipeline не меняются.
--   - `PayrollAccrualDocumentLine.payoutId` — опционально, `null`
--     до момента создания выплаты; `onDelete: SetNull`.
--
-- Backward compatibility:
--   - Чисто аддитивная миграция: новые тип и таблицы, без
--     изменения существующих колонок / индексов / FK.
--   - Откат: `DROP TABLE "PayrollAccrualDocumentLine"; DROP TABLE
--     "PayrollAccrualDocument"; DROP TYPE
--     "PayrollAccrualDocumentStatus";`. Никаких внешних
--     зависимостей до появления сервисного слоя (PHASE 3 STEP 6.2+).
-- =============================================================

-- CreateEnum
CREATE TYPE "PayrollAccrualDocumentStatus" AS ENUM ('DRAFT', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "PayrollAccrualDocument" (
    "id" TEXT NOT NULL,
    "accrualDate" DATE NOT NULL,
    "status" "PayrollAccrualDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "totalPieceworkRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalSalaryRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAdjustRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalToPayRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "managerComment" TEXT,
    "createdById" TEXT NOT NULL,
    "paidById" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "PayrollAccrualDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAccrualDocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amountPieceworkRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amountSalaryRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "manualAdjustRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "manualComment" TEXT,
    "amountToPayRub" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "payoutId" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollAccrualDocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollAccrualDocument_status_accrualDate_idx" ON "PayrollAccrualDocument"("status", "accrualDate");

-- CreateIndex
CREATE INDEX "PayrollAccrualDocument_createdById_idx" ON "PayrollAccrualDocument"("createdById");

-- CreateIndex
CREATE INDEX "PayrollAccrualDocument_paidById_idx" ON "PayrollAccrualDocument"("paidById");

-- CreateIndex
CREATE INDEX "PayrollAccrualDocument_cancelledById_idx" ON "PayrollAccrualDocument"("cancelledById");

-- CreateIndex
CREATE INDEX "PayrollAccrualDocument_createdAt_idx" ON "PayrollAccrualDocument"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAccrualDocumentLine_documentId_employeeId_key" ON "PayrollAccrualDocumentLine"("documentId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollAccrualDocumentLine_employeeId_idx" ON "PayrollAccrualDocumentLine"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollAccrualDocumentLine_payoutId_idx" ON "PayrollAccrualDocumentLine"("payoutId");

-- CreateIndex
CREATE INDEX "PayrollAccrualDocumentLine_documentId_idx" ON "PayrollAccrualDocumentLine"("documentId");

-- AddForeignKey
ALTER TABLE "PayrollAccrualDocument" ADD CONSTRAINT "PayrollAccrualDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAccrualDocument" ADD CONSTRAINT "PayrollAccrualDocument_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAccrualDocument" ADD CONSTRAINT "PayrollAccrualDocument_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAccrualDocumentLine" ADD CONSTRAINT "PayrollAccrualDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PayrollAccrualDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAccrualDocumentLine" ADD CONSTRAINT "PayrollAccrualDocumentLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAccrualDocumentLine" ADD CONSTRAINT "PayrollAccrualDocumentLine_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "PayrollPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
