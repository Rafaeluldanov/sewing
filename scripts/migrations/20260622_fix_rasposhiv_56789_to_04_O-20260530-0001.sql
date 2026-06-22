-- 2026-06-22 data-fix (prod)
-- Заказ O-20260530-0001, паспорта P-20260530-0141 / -0143 / -0157.
--
-- Проблема: завершающая операция распошива была записана на мусорную
-- операцию `56789 РАСПОШИВ` (fixedRate = 1.00 ₽), хотя маршрут заказа
-- (OrderRouteStep index 4) содержит правильную `04 РАСПОШИВ ФУТБОЛКА`
-- (fixedRate = 20.00 ₽, parallelGroup 1 с КИПЕРКА 03).
--
-- Правка: заменить ссылки 56789 -> 04 на этих 3 паспортах в:
--   * OperationEntry  (сделка: operationId, ratePerUnit 1->20, amount = qty*20)
--   * PassportEvent   (ISSUED_TO_EMPLOYEE + OPERATION_FINISHED: operationId)
--   * Passport        (currentOperationId)
-- Записи сделки в статусе PENDING_RELEASE (в выплату не ушли).
--
-- op 56789 = cmqif1d1c00hky85sa1o1w9st
-- op 04    = cmorgh5oh000310sv7nyr7fve  (РАСПОШИВ ФУТБОЛКА, 20.00 ₽)

BEGIN;

WITH pass AS (
  SELECT id FROM "Passport"
  WHERE number IN ('P-20260530-0141','P-20260530-0143','P-20260530-0157')
)
, fix_entry AS (
  UPDATE "OperationEntry" oe
     SET "operationId" = 'cmorgh5oh000310sv7nyr7fve',
         "ratePerUnit" = 20.00,
         "amount"      = oe.qty * 20.00
   WHERE oe."operationId" = 'cmqif1d1c00hky85sa1o1w9st'
     AND oe."passportId" IN (SELECT id FROM pass)
  RETURNING 1
)
, fix_event AS (
  UPDATE "PassportEvent" ev
     SET "operationId" = 'cmorgh5oh000310sv7nyr7fve'
   WHERE ev."operationId" = 'cmqif1d1c00hky85sa1o1w9st'
     AND ev."passportId" IN (SELECT id FROM pass)
  RETURNING 1
)
, fix_passport AS (
  UPDATE "Passport" p
     SET "currentOperationId" = 'cmorgh5oh000310sv7nyr7fve'
   WHERE p."currentOperationId" = 'cmqif1d1c00hky85sa1o1w9st'
     AND p.id IN (SELECT id FROM pass)
  RETURNING 1
)
SELECT
  (SELECT count(*) FROM fix_entry)    AS entries_fixed,
  (SELECT count(*) FROM fix_event)    AS events_fixed,
  (SELECT count(*) FROM fix_passport) AS passports_fixed;

COMMIT;
