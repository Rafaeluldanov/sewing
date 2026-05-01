-- Cut-ready readiness for outsource lines (MVP-2 техкарт, ADR-0022
-- §«Cut-ready readiness»).
--
-- Изменение чисто additive: добавляем enum `OutsourceTriggerType`,
-- два поля `triggerType` с дефолтом `MANUAL` (на template-строке и в
-- snapshot-е заказа). Существующие данные не ломаются — все строки
-- получают `MANUAL`, и поведение карточки заказа совпадает с тем, что
-- было до миграции (UI просто не показывает индикатор готовности).
--
-- Никаких side-effect (status-колонок, history-таблиц, индексов под
-- background sync) сознательно не добавляется: readiness считается
-- on-read в `OrdersService.getOne()` по `Passport.currentCellId`.

-- CreateEnum
CREATE TYPE "OutsourceTriggerType" AS ENUM ('MANUAL', 'CUT_READY');

-- AlterTable
ALTER TABLE "TechCardOutsourceLine" ADD COLUMN "triggerType" "OutsourceTriggerType" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "OrderOutsourceRequirement" ADD COLUMN "triggerType" "OutsourceTriggerType" NOT NULL DEFAULT 'MANUAL';
