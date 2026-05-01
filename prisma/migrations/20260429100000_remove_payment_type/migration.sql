-- Удаление исторического `Employee.paymentType` + enum `PaymentType`.
--
-- Контекст: с post-Шага 18 / Шага 19 (ADR-0021) параллельно
-- существовали `paymentType` (источник истины для `EarningsService`)
-- и `compensationType` (управленческая ось для `SalaryService`). После
-- этой задачи единственный источник истины «как платим» —
-- `compensationType`. `EarningsService` теперь гейтит сдельные
-- начисления так:
--   `compensationType = SALARY`           -> молча пропустить;
--   `compensationType IN (PIECEWORK, MIXED)` -> создать `OperationEntry`.
--
-- Чтобы не сломать payroll старых данных, перед DROP COLUMN мы
-- бэкфилим `compensationType` для тех сотрудников, у которых
-- `paymentType = SALARY`, а `compensationType` остался дефолтным
-- `PIECEWORK` (так предыдущая миграция
-- `20260421100000_employee_compensation_and_salary_entry` поставила
-- значение всем существующим строкам). Без этого backfill окладные
-- роли (ОТК / ВТО / упаковка / помощник раскройщика), у которых
-- админ ещё не успел переключить компенсацию вручную, начали бы
-- получать сдельные `OperationEntry`. После DROP COLUMN восстановить
-- этот сигнал из БД нельзя — поэтому делаем здесь.
--
-- Если у сотрудника `salaryPerShift IS NULL`, он остаётся в
-- `compensationType = SALARY`, но `SalaryService` уже умеет тихо
-- пропускать такие записи (см. `apps/api/src/modules/salary/salary.service.ts`,
-- guard `employee.salaryPerShift === null`). Менеджер дозаполнит
-- ставку через `/admin/employees/[id]` — прежний UX.

UPDATE "Employee"
SET "compensationType" = 'SALARY'
WHERE "paymentType" = 'SALARY'
  AND "compensationType" = 'PIECEWORK';

ALTER TABLE "Employee" DROP COLUMN "paymentType";

DROP TYPE IF EXISTS "PaymentType";
