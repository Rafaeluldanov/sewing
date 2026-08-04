-- 2026-08-04 data-fix (prod)
-- Заказ 02-00001 «Худи РСВ», 12 паспортов P-20260730-0017…-0019,
-- P-20260731-0001…-0009, швея Талайбекова Жанара.
--
-- ЧТО ПРОИЗОШЛО.
-- 03.08 07:48 швея открыла смену на станке ПРЯМОСТРОЧКА и в 07:50–07:55
-- взяла 12 паспортов заказа: `ISSUED_TO_EMPLOYEE.operationId =
-- STRAIGHT_STEECH` — верно, это шаг 1 маршрута заказа.
-- 04.08 07:31:29 она закрыла ту смену и через 19 секунд открыла новую —
-- на ОВЕРЛОКЕ (`02 Ф ОВЕРЛОК`). В 07:32:27, ещё через 39 секунд, пакетно
-- нажала «завершить» по всем 12 паспортам вчерашней прямострочки.
--
-- `completeOperationByEmployee` (apps/api/src/modules/passports/
-- passports.service.ts §2643) берёт завершаемую операцию из АКТИВНОЙ СМЕНЫ
-- (`session.operationId`), а не из того, на что паспорт был выдан. Это
-- сознательное решение (иначе после issue без scan в логе появлялось бы
-- «завершил Деление кроя»), но здесь оно записало работу на операцию,
-- которой в маршруте заказа нет вообще.
-- Гейт не удержал: `evaluateRouteOrder` вернул `offRoute: true`, а
-- `CompanySettings.offRouteWorkPolicy = WARN` — только предупреждение в лог.
-- `allowIfAlreadyIssued` не спас: он ищет ISSUED на ТУ ЖЕ операцию (02), а
-- выдача была на STRAIGHT_STEECH.
--
-- ПОСЛЕДСТВИЯ.
--   1. Шаг 1 маршрута (ПРЯМОСТРОЧКА) не закрыт ни на одном паспорте.
--      Заказ при этом НЕ встал: между шагом 1 и ОТК (шаг 2) нет швейных
--      шагов, а `sequentialBefore` берёт строго промежуточные — паспорта
--      прошли бы ОТК/ВТО/упаковку молча, с незакрытой прямострочкой.
--   2. Сделка начислена по справочной расценке ОВЕРЛОКА 64.10 ₽/шт вместо
--      расценки заказа для ПРЯМОСТРОЧКИ (`OrderRouteStep.rateOverride`
--      = 615.40 ₽/шт; сверка: план заказа 62 109.80 ₽ = 100 × 615.40 +
--      569.80 окладных). 102 шт: начислено 6 538.20 ₽, должно 62 770.80 ₽ —
--      недоплата 56 232.60 ₽.
--   3. Фактическая себестоимость заказа висит на операции вне маршрута.
--
-- ПРАВКА. Переписываем 02 -> STRAIGHT_STEECH на этих 12 паспортах в:
--   * PassportEvent   (12 × OPERATION_FINISHED: operationId)
--   * OperationEntry  (12 × сделка: operationId, ratePerUnit, amount)
--   * Passport        (currentOperationId)
-- `currentRouteStepIndex` уже = 1 (шаг ПРЯМОСТРОЧКИ) — off-route завершение
-- его не двигало, менять нечего.
-- `ISSUED_TO_EMPLOYEE` уже на STRAIGHT_STEECH — не трогаем.
-- `fromOperationId` этих событий уже STRAIGHT_STEECH — после правки
-- from == to, ровно как в штатном потоке scan -> complete.
-- AuditLog не переписываем: это история, а не состояние.
-- Все 12 записей сделки в PENDING_RELEASE, в PayrollPayoutLine не ушли
-- (проверено: 0 строк) — правка расценки никого не догоняет задним числом.
--
-- НЕ наряд-допуск (`RouteWorkPermit`) и НЕ `OperationSubstitution`:
-- это не смена технологии, а промах смены. Допуск узаконил бы оверлок как
-- замену прямострочки на весь заказ и оставил бы расценку 64.10 ₽.
--
-- order           = cms3cwz0f03c5mbl7xata6nl1  (02-00001)
-- op 02           = cmord6c8700057ay5prw5mmff  (Ф ОВЕРЛОК, BY_SIZE, 64.10 ₽ для этих размеров)
-- op STRAIGHT_..  = cmqhu639200afsv8vjqgaxxw7  (ПРЯМОСТРОЧКА, FIXED, в заказе 615.40 ₽)

BEGIN;

WITH pass AS (
  SELECT id FROM "Passport" WHERE "orderId" = 'cms3cwz0f03c5mbl7xata6nl1'
)
, fix_event AS (
  UPDATE "PassportEvent" ev
     SET "operationId" = 'cmqhu639200afsv8vjqgaxxw7'
   WHERE ev."operationId" = 'cmord6c8700057ay5prw5mmff'
     AND ev.type = 'OPERATION_FINISHED'
     AND ev."passportId" IN (SELECT id FROM pass)
  RETURNING 1
)
, fix_entry AS (
  UPDATE "OperationEntry" oe
     SET "operationId" = 'cmqhu639200afsv8vjqgaxxw7',
         "ratePerUnit" = 615.40,
         "amount"      = oe.qty * 615.40
   WHERE oe."operationId" = 'cmord6c8700057ay5prw5mmff'
     AND oe.status = 'PENDING_RELEASE'
     AND oe."passportId" IN (SELECT id FROM pass)
  RETURNING oe.amount
)
, fix_passport AS (
  UPDATE "Passport" p
     SET "currentOperationId" = 'cmqhu639200afsv8vjqgaxxw7'
   WHERE p."currentOperationId" = 'cmord6c8700057ay5prw5mmff'
     AND p.id IN (SELECT id FROM pass)
  RETURNING 1
)
SELECT
  (SELECT count(*)   FROM fix_event)    AS events_fixed,     -- ожидаем 12
  (SELECT count(*)   FROM fix_entry)    AS entries_fixed,    -- ожидаем 12
  (SELECT sum(amount) FROM fix_entry)   AS entries_sum,      -- ожидаем 62770.80
  (SELECT count(*)   FROM fix_passport) AS passports_fixed;  -- ожидаем 12

COMMIT;
