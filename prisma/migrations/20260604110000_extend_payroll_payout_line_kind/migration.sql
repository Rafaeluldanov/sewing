-- Migration: extend_payroll_payout_line_kind
-- PHASE 3 STEP 6.4: добавляем BONUS / DEDUCTION / ADVANCE / ADJUSTMENT в enum.
-- PostgreSQL требует ADD VALUE IF NOT EXISTS — значения нельзя добавить
-- внутри транзакции, поэтому миграция не оборачивается в BEGIN/COMMIT.

-- AlterEnum
ALTER TYPE "PayrollPayoutLineKind" ADD VALUE IF NOT EXISTS 'BONUS';
ALTER TYPE "PayrollPayoutLineKind" ADD VALUE IF NOT EXISTS 'DEDUCTION';
ALTER TYPE "PayrollPayoutLineKind" ADD VALUE IF NOT EXISTS 'ADVANCE';
ALTER TYPE "PayrollPayoutLineKind" ADD VALUE IF NOT EXISTS 'ADJUSTMENT';
