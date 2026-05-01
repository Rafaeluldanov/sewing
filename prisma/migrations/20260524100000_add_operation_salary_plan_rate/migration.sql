-- Плановая окладная стоимость операции (см. ТЗ
-- «Плановая стоимость окладных операций по нормам времени»).
--
-- Что добавляем (additive):
--   1. `Operation.salaryPlanRubPerShift Decimal(14,2)` — плановая
--      стоимость одной смены этой операции (для расчёта
--      ПЛАНОВОЙ себестоимости, не фактической зарплаты).
--   2. `Operation.salaryPlanShiftSeconds Int DEFAULT 28800` —
--      длительность «расчётной смены» в секундах. По умолчанию
--      8 часов = 28800 секунд.
--
-- Используется в `OrderOperationPlanService` для веток
-- `pricingMode = SALARY_ONLY`:
--     cost = timeSec × (salaryPlanRubPerShift / salaryPlanShiftSeconds) × qty
--
-- Что НЕ трогаем (см. recon §15):
--   - `Employee.salaryPerShift` / `EmployeeCompensation` — это
--     фактический payroll;
--   - `SalaryEntry` / `OperationEntry` / `Passport` — фактические
--     начисления;
--   - `OperationRateBySize` / `OperationTimeNormBySize` — это
--     отдельные оси (сдельная ставка / норма времени);
--   - `Order` / `OrderCostEstimate` / `WorkshopNeed` —
--     `operationCostPlanRub`/`operationTimePlanSec` уже есть; меняется
--     только формула расчёта внутри `OrderOperationPlanService`.
--
-- Backfill-стратегия: ничего не делаем. Для всех существующих
-- операций `salaryPlanRubPerShift` остаётся `NULL` (план для
-- окладных операций не считается, `cost = 0` + warning), а
-- `salaryPlanShiftSeconds` получает default 28800 через DDL —
-- менеджер при первом редактировании окладной операции задаёт
-- ставку.
--
-- Additive only: ALTER TABLE ... ADD COLUMN не нарушает чтение
-- старыми клиентами и не ломает уже существующие индексы.

ALTER TABLE "Operation"
    ADD COLUMN "salaryPlanRubPerShift"  DECIMAL(14, 2),
    ADD COLUMN "salaryPlanShiftSeconds" INTEGER DEFAULT 28800;
