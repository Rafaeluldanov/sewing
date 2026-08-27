-- 2026-08-26 data-fix (prod)
-- Заказ 02-00001 «Худи РСВ», паспорта P-20260731-0006 (6 шт, 3XL) и
-- P-20260731-0008 (8 шт, S), швея Талайбекова Жанара.
--
-- ЧТО ПРОИЗОШЛО.
-- Шаг 2 маршрута заказа = `098642 ОВЕРЛОК` (FIXED 1.00 ₽, rateOverride нет).
-- 15.08 09:11:58 швея открыла смену на станке ОВЕРЛОК (overlok-12), выбрав в
-- списке операций `02 Ф ОВЕРЛОК` — это ДРУГАЯ операция справочника, в маршруте
-- заказа её нет. Через 43 секунды взяла два паспорта и ещё через 15 секунд
-- завершила оба (09:12:41 → 09:13:06 — работы за это время не было).
-- Гейт пропустил: `evaluateRouteOrder` вернул offRoute, а
-- `CompanySettings.offRouteWorkPolicy = WARN` — только запись в AuditLog
-- (`PASSPORT_WORK_OUTSIDE_ROUTE`, 2 шт., 15.08 09:12:41 и 09:12:51).
-- Маршрут при этом НЕ сдвинулся: `currentRouteStepIndex` остался 1 (см.
-- payload `PASSPORT_OPERATION_COMPLETED`: before.idx = after.idx = 1).
--
-- 22.08 07:40–07:50 оба паспорта прошли шаг 2 ПО МАРШРУТУ, на `098642 ОВЕРЛОК`
-- (смена cmt42j0rk0dyazd63edwyrr2v открыта уже на правильной операции), вместе
-- с остальными 8 паспортами заказа; дальше — ОТК 22.08 08:00 и ВТО 22.08 08:30.
-- Итог: физически оверлок сделан один раз, а в базе он записан ДВАЖДЫ —
-- 15.08 мимо маршрута на `02` и 22.08 по маршруту на `098642`.
--
-- ПОСЛЕДСТВИЯ.
--   * Лишняя сделка: 6 × 64.10 + 8 × 64.10 = 897.40 ₽ по справочной расценке
--     `02 Ф ОВЕРЛОК` (BY_SIZE). Обе записи в PENDING_RELEASE, в
--     PayrollPayoutLine не ушли (проверено: 0 строк) — задним числом никого
--     не догоняет.
--   * Фактическая себестоимость заказа несёт 897.40 ₽ на операции вне маршрута.
--   * В истории паспортов оверлок виден дважды.
--
-- ПРАВКА. Удаляем именно СТОРОННЮЮ запись 15.08 (события + сделку), а не
-- переписываем `02` -> `098642`: правильная запись шага 2 уже есть от 22.08,
-- переписывание удвоило бы шаг и упёрлось бы в уникальный индекс
-- `OperationEntry(passportId, operationId, employeeId, sourceEventType,
-- passOrdinal)`.
--   * OperationEntry  — 2 строки (сделка 15.08 на op 02)
--   * PassportEvent   — 4 строки (2 × ISSUED_TO_EMPLOYEE + 2 × OPERATION_FINISHED)
-- `Passport` не трогаем: `currentOperationId` = `014 ВТО ОКЛАД`,
-- `currentRouteStepIndex` = 4 — состояние выставлено проходом 22.08 и верно.
-- `ShiftSession`/`ShiftSegment` 15.08 не трогаем: смена была настоящая,
-- ошибочен только выбор операции.
-- AuditLog не трогаем: это история, а не состояние.
--
-- НЕ `OperationSubstitution` и НЕ `RouteWorkPermit`: замены технологии не было,
-- был промах в выборе операции при открытии смены.
--
-- order       = cms3cwz0f03c5mbl7xata6nl1  (02-00001)
-- op 02       = cmord6c8700057ay5prw5mmff  (Ф ОВЕРЛОК, BY_SIZE, 64.10 ₽)
-- op 098642   = cmqiezdyp00gsy85ss6i5zy7n  (ОВЕРЛОК, шаг 2 маршрута, FIXED 1.00 ₽)
-- P-…-0006    = cms8tl9we05dpj2pnzq7hg3rr
-- P-…-0008    = cms8xkiy508h5j2pn61ixw53h

BEGIN;

WITH pass AS (
  SELECT id FROM "Passport"
  WHERE id IN ('cms8tl9we05dpj2pnzq7hg3rr','cms8xkiy508h5j2pn61ixw53h')
)
, del_entry AS (
  DELETE FROM "OperationEntry" oe
   WHERE oe."operationId" = 'cmord6c8700057ay5prw5mmff'
     AND oe.status = 'PENDING_RELEASE'
     AND oe."passportId" IN (SELECT id FROM pass)
  RETURNING oe.amount
)
, del_event AS (
  DELETE FROM "PassportEvent" ev
   WHERE ev."operationId" = 'cmord6c8700057ay5prw5mmff'
     AND ev.type IN ('ISSUED_TO_EMPLOYEE','OPERATION_FINISHED')
     AND ev."passportId" IN (SELECT id FROM pass)
  RETURNING 1
)
SELECT
  (SELECT count(*)    FROM del_entry) AS entries_deleted,  -- ожидаем 2
  (SELECT sum(amount) FROM del_entry) AS amount_removed,   -- ожидаем 897.40
  (SELECT count(*)    FROM del_event) AS events_deleted;   -- ожидаем 4

COMMIT;
