-- =============================================================
-- PHASE 2 STEP 2: link Employee to CompanyDivision
-- =============================================================
--
-- Что делает миграция:
--   1. Добавляет колонку `Employee.companyDivisionId` (nullable
--      FK на `CompanyDivision`). Используется payroll-фильтром
--      `/api/payroll/period?divisionCode=...` для окладной части
--      ведомости и в управленческих списках сотрудников. Для
--      сдельной части подразделение по-прежнему берётся из
--      `Order.companyDivisionId` через `Passport → Order`.
--   2. Создаёт FK `Employee.companyDivisionId → CompanyDivision.id`
--      с `ON DELETE SET NULL` — снос подразделения отвязывает
--      сотрудника, а не сносит его карточку.
--   3. Создаёт индекс `Employee_companyDivisionId_idx` под
--      `WHERE companyDivisionId = $1` (payroll-агрегатор +
--      EmployeesService.list по division).
--
-- Что НЕ трогаем:
--   - Существующих сотрудников НЕ привязываем автоматически — у
--     каждой инсталляции свой состав цеха, и backfill «по умолчанию
--     MARKETPLACE» был бы слишком широким мазком. Менеджер
--     проставит подразделение в `/admin/employees/[id]` после
--     обновления (на этом же шаге UI получает selectbox).
--   - Не меняем семантику `Order.companyDivisionId` или
--     `DisplayScreenConfig.companyDivisionId`.
--
-- Backward compatibility:
--   - Колонка nullable; старые insert-ы без `companyDivisionId`
--     продолжают работать. Payroll, увидев `companyDivisionId =
--     NULL` у окладника, по-прежнему отнесёт его к «без
--     подразделения» при выборе divisionCode-фильтра.
--   - Откат: `DROP COLUMN`. Поле новое, никаких внешних зависимостей.
-- =============================================================

ALTER TABLE "Employee"
  ADD COLUMN "companyDivisionId" TEXT;

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_companyDivisionId_fkey"
  FOREIGN KEY ("companyDivisionId")
  REFERENCES "CompanyDivision"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "Employee_companyDivisionId_idx"
  ON "Employee"("companyDivisionId");
