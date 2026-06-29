-- Переход окладного контура на ПОЧАСОВУЮ оплату (повременка).
--
-- 1. Employee.salaryPerHour — новая ставка ₽/час. salaryPerShift
--    становится legacy (в расчёте больше не участвует, колонка
--    сохранена ради истории и бэкфилла ниже).
-- 2. SalaryEntry.workedSeconds — фактически отработанные секунды за
--    день по закрытым сменам, на основе которых посчитан amount.
-- 3. Бэкфилл: для действующих окладников (SALARY/MIXED) с заданной
--    ставкой за смену переносим её в почасовую из расчёта 8 ч/смену
--    (решение пользователя). Менеджер потом сможет поправить вручную.

ALTER TABLE "Employee" ADD COLUMN "salaryPerHour" DECIMAL(12,2);

ALTER TABLE "SalaryEntry" ADD COLUMN "workedSeconds" INTEGER;

UPDATE "Employee"
SET "salaryPerHour" = ROUND("salaryPerShift" / 8.0, 2)
WHERE "compensationType" IN ('SALARY', 'MIXED')
  AND "salaryPerShift" IS NOT NULL
  AND "salaryPerHour" IS NULL;
