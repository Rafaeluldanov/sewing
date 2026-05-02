-- =============================================================
-- PHASE 2 STEP 1: drop legacy salary base and piece rates
-- =============================================================
--
-- Что делает миграция:
--   1. Удаляет колонку `Employee.salaryBase` (legacy «месячный
--      оклад»). Runtime никогда её не читал — ни `EarningsService`,
--      ни `SalaryService`, ни payroll-агрегатор. Источник истины
--      для оплаты за смену — `Employee.salaryPerShift` + `compensationType`
--      (см. ADR-0021, `docs/domain.md §9a`).
--   2. Удаляет таблицу `PieceRate` целиком вместе со всеми FK и
--      индексами. Со Шага 18 (`prisma/migrations/20260420100000_operation_pricing_model`)
--      сдельные ставки живут в `Operation.fixedRate` /
--      `OperationRateBySize`; `EarningsService.resolveRate` ходит
--      только туда. Runtime-кода, читающего `PieceRate`, нет
--      (`grep prisma\\.pieceRate` пусто); таблица оставалась лишь
--      для аудита/rollback. PHASE 2 убирает её, чтобы не путать
--      реальную модель зарплаты перед PHASE 3 PayrollPayout.
--
-- Что НЕ трогаем:
--   - `OperationEntry`, `SalaryEntry`, `OperationRateBySize`,
--     `Operation.fixedRate`, `Operation.pricingMode` — это новый
--     контур, остаётся как есть.
--   - `Employee.salaryPerShift`, `Employee.cutterB2bSewingPercent`,
--     `Employee.compensationType` — runtime-источники истины.
--   - Класс `PieceRateNotFoundException` (`apps/api/src/common/errors.ts`)
--     удалён в коде в этом же commit-е; миграция за него не отвечает.
--
-- Backward compatibility:
--   - На стороне БД операция деструктивная (DROP TABLE / DROP COLUMN).
--     Откат — restore из backup (см. `docs/ops.md §«Backups»`).
--   - На пилоте: данные из `PieceRate` уже бэкфилены в
--     `OperationRateBySize` миграцией Шага 18; `salaryBase` не
--     участвует ни в одном расчёте, потеря значений не влияет на
--     payroll.
-- =============================================================

-- ----------------------------------------------------------------
-- 1. Drop Employee.salaryBase
-- ----------------------------------------------------------------

ALTER TABLE "Employee" DROP COLUMN "salaryBase";

-- ----------------------------------------------------------------
-- 2. Drop PieceRate (сначала FK, потом сам стол)
-- ----------------------------------------------------------------

ALTER TABLE "PieceRate" DROP CONSTRAINT IF EXISTS "PieceRate_operationId_fkey";
ALTER TABLE "PieceRate" DROP CONSTRAINT IF EXISTS "PieceRate_productId_fkey";
ALTER TABLE "PieceRate" DROP CONSTRAINT IF EXISTS "PieceRate_sizeId_fkey";

DROP INDEX IF EXISTS "PieceRate_operationId_productId_sizeId_validFrom_idx";

DROP TABLE IF EXISTS "PieceRate";
