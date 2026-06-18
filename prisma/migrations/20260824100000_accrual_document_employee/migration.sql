-- Документ начисления зарплаты: опциональный фильтр по сотруднику.
-- `employeeId IS NULL` — документ по всем сотрудникам (поведение по умолчанию);
-- задан — документ формируется только по этому сотруднику (одна строка).
-- Хранится на документе, чтобы пересчёт (recompute) сохранял охват.

ALTER TABLE "PayrollAccrualDocument" ADD COLUMN "employeeId" TEXT;

CREATE INDEX "PayrollAccrualDocument_employeeId_idx" ON "PayrollAccrualDocument"("employeeId");

ALTER TABLE "PayrollAccrualDocument" ADD CONSTRAINT "PayrollAccrualDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
