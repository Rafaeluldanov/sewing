-- Manual execution status для внешней потребности заказа
-- (MVP-3 техкарт, ADR-0022 §«Manual execution status»).
--
-- Изменение чисто additive: добавляем enum
-- `OrderOutsourceExecutionStatus`, три новые колонки на
-- `OrderOutsourceRequirement` (`executionStatus`, `orderedAt`,
-- `receivedAt`) и ничего больше. Существующие строки получают
-- `executionStatus = PLANNED` (backward-compat: поведение карточки
-- заказа без ручных переходов совпадает с MVP-2).
--
-- Сознательно НЕ добавляем:
--   - status `READY_TO_ORDER` в БД (он остаётся derived в
--     `OrdersService.getOne()` по `Passport.currentCellId`);
--   - отдельную history/event-log-таблицу под переходы (один
--     ручной flow менеджера — не повод заводить universal
--     workflow engine);
--   - background sync / cron / FK на vendor (vendor-directory и
--     procurement отложены).

-- CreateEnum
CREATE TYPE "OrderOutsourceExecutionStatus" AS ENUM ('PLANNED', 'ORDERED', 'RECEIVED');

-- AlterTable
ALTER TABLE "OrderOutsourceRequirement" ADD COLUMN "executionStatus" "OrderOutsourceExecutionStatus" NOT NULL DEFAULT 'PLANNED';
ALTER TABLE "OrderOutsourceRequirement" ADD COLUMN "orderedAt" TIMESTAMP(3);
ALTER TABLE "OrderOutsourceRequirement" ADD COLUMN "receivedAt" TIMESTAMP(3);
