-- Этап «B2B cutter compensation» (см.
-- `docs/payroll-cutter-compensation-recon.md`).
--
-- Добавляем nullable-колонку `Employee.cutterB2bSewingPercent`,
-- хранящую процент начисления закройщика для B2B-заказов
-- (Decimal(5, 2): значения вида `5.00` = 5%).
--
-- Миграция строго additive:
--   - колонка nullable, без default (значение `null` означает
--     «процент у этого сотрудника не задан, использовать fallback
--     из ENV `CUTTER_B2B_SEWING_PERCENT`»);
--   - старые сотрудники не затрагиваются — у всех существующих
--     строк колонка получает `NULL`;
--   - индексы не нужны: чтение всегда идёт точечным
--     `findUnique({ id })` из payroll-flow.
--
-- Поле читается только `EarningsService.createImmediateForCutter`
-- для сотрудников с ролью `CUTTER` и только когда
-- `Order.division ∈ { OTHER (legacy B2B), B2B }`. Marketplace-flow
-- продолжает работать по старой схеме `Operation.fixedRate ×
-- passport.qtyCut` и этого поля не читает.

ALTER TABLE "Employee"
  ADD COLUMN "cutterB2bSewingPercent" DECIMAL(5, 2);
