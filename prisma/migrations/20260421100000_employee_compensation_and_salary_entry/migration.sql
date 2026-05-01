-- Employee compensation model + ежедневные окладные начисления
-- (см. ADR-0021, `docs/domain.md §9a`, `docs/api.md §10a`,
-- `docs/erd.md §2.13b`).
--
-- Что добавляем (полностью additive):
--   1. Enum "CompensationType" (PIECEWORK | SALARY | MIXED).
--   2. Enum "SalaryEntrySource" (SHIFT_DAY | MANUAL).
--   3. Колонки "Employee.compensationType", "Employee.salaryPerShift".
--   4. Таблица "SalaryEntry" с уникальным
--      (employeeId, date, source) и индексами по дате.
--
-- Что НЕ трогаем:
--   - "Employee.paymentType" / "salaryBase" — остаются как есть,
--     это исторические поля сдельного pipeline и справочный
--     месячный оклад. Источник истины для оплаты за смену —
--     "salaryPerShift".
--   - "OperationEntry" — модель сдельных начислений не меняется
--     (см. ADR-0005, ADR-0012). Окладные и сдельные живут в
--     раздельных таблицах, чтобы не путать инварианты и RBAC.
--
-- Backfill стратегии:
--   - "compensationType" на всех существующих сотрудниках получает
--     дефолт "PIECEWORK" (безопасно: автогенерация SalaryEntry не
--     запускается, пока менеджер явно не переключит сотрудника на
--     SALARY/MIXED через "/admin/employees"). Demo-сотрудников seed
--     перепишет в нужное состояние при следующем "npm run db:seed".

-- =============================================================
-- 1. Enums
-- =============================================================

CREATE TYPE "CompensationType" AS ENUM ('PIECEWORK', 'SALARY', 'MIXED');
CREATE TYPE "SalaryEntrySource" AS ENUM ('SHIFT_DAY', 'MANUAL');

-- =============================================================
-- 2. ALTER Employee
-- =============================================================

ALTER TABLE "Employee"
    ADD COLUMN "compensationType" "CompensationType" NOT NULL DEFAULT 'PIECEWORK',
    ADD COLUMN "salaryPerShift" DECIMAL(12,2);

CREATE INDEX "Employee_compensationType_idx"
    ON "Employee"("compensationType");

-- =============================================================
-- 3. CREATE TABLE SalaryEntry
-- =============================================================

CREATE TABLE "SalaryEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" "SalaryEntrySource" NOT NULL DEFAULT 'SHIFT_DAY',
    "editedManually" BOOLEAN NOT NULL DEFAULT false,
    "managerComment" TEXT,
    "editedByEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalaryEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalaryEntry_employeeId_date_source_key"
    ON "SalaryEntry"("employeeId", "date", "source");

CREATE INDEX "SalaryEntry_employeeId_date_idx"
    ON "SalaryEntry"("employeeId", "date");

CREATE INDEX "SalaryEntry_date_idx"
    ON "SalaryEntry"("date");

ALTER TABLE "SalaryEntry"
    ADD CONSTRAINT "SalaryEntry_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalaryEntry"
    ADD CONSTRAINT "SalaryEntry_editedByEmployeeId_fkey"
    FOREIGN KEY ("editedByEmployeeId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
