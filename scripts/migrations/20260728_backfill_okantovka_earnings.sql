-- 2026-07-28 data-fix (prod). ПРИМЕНЕНО.
--
-- Доначисление сдельной за операцию «11 ОКАНТОВКА ПЛЕЧЕВЫХ И ГОРЛОВИНЫ»
-- (id cmorhg4k3000wc6n16e1uifki) за 01.07-16.07.2026.
--
-- Проблема. У операции 11 до 21.07.2026 не было `fixedRate`, а
-- `EarningsService.createPendingForCompletedOperation` при отсутствии ставки
-- молча выходит (`if (!rate) return;`, apps/api/src/modules/earnings/earnings.service.ts).
-- Начисление `OperationEntry` — снимок: появление ставки задним числом прошлые
-- закрытия НЕ пересчитывает. В итоге 131 закрытие операции (1 944 изделия) у двух
-- СДЕЛЬНЫХ швей осталось без единой копейки, и никто этого не заметил 27 дней.
-- Всплыло при разборе инцидента «работа мимо маршрута» 28.07.2026
-- (см. миграцию 20260930100000_kiperka_substituted_by_okantovka).
--
-- Что начислено (ставка 19.23 ₽/шт — единственная, что когда-либо была у операции 11):
--   Джалилова Айзада  (активна)        64 закрытия / 825 шт / 15 864.75 ₽ → PENDING_RELEASE
--   Джалилова Айзада  (активна)        32 закрытия / 515 шт /  9 903.45 ₽ → APPROVED
--   Андашова Астра    (деактивирована) 35 закрытий / 604 шт / 11 614.92 ₽ → PENDING_RELEASE
--   ИТОГО                             131 закрытие / 1 944 шт / 37 383.12 ₽
--
-- Начисление Андашовой (уволена после 03.07) согласовано владельцем: работа
-- выполнена и принята, паспорта уехали дальше по маршруту.
--
-- Два решения, зеркалящих штатное поведение сервиса (не отсебятина):
--   1. qty = `Passport.qtyGood`, а НЕ `PassportEvent.qty`. Проверено на 40 закрытиях
--      операции 11, где начисление всё-таки создалось: entry.qty там везде равен
--      qtyGood; на 4 паспортах он расходится с qty события (брак после закрытия).
--      Из-за этого итог 1 944 шт, а не 1 951.
--   2. status = APPROVED для паспортов в PACKED, PENDING_RELEASE для остальных.
--      Это ветка `approveImmediately` в earnings.service.ts: на упакованном паспорте
--      второго `approvePendingForPassport` уже не случится, и PENDING_RELEASE завис
--      бы навсегда. Совпадает с фактическим распределением статусов у соседних
--      начислений на тех же паспортах (197 PENDING_RELEASE у IN_PROGRESS, 64 APPROVED у PACKED).
--
-- id начислений с префиксом `oe_` (детерминированный от id события) — чтобы
-- backfill был отличим от штатных cuid-ов и патч был идемпотентен.
--
-- ПРИМЕНЕНО НА ПРОДЕ 2026-07-28. Результат: INSERT 131, долг по операции 11 = 0.

BEGIN;

CREATE TEMP TABLE _debt AS
SELECT e.id            AS event_id,
       e."passportId"  AS passport_id,
       e."employeeId"  AS employee_id,
       p."qtyGood"     AS qty,
       p.status::text  AS passport_status
FROM "PassportEvent" e
JOIN "Passport" p ON p.id = e."passportId"
WHERE e.type = 'OPERATION_FINISHED'
  AND e."operationId" = 'cmorhg4k3000wc6n16e1uifki'
  AND e."employeeId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "OperationEntry" oe
                  WHERE oe."passportId" = e."passportId"
                    AND oe."operationId" = e."operationId");

INSERT INTO "OperationEntry"
  (id, "passportId", "operationId", "employeeId", qty, "ratePerUnit", amount,
   status, "approvalMode", "sourceEventType", "sourceEventId", "createdAt", "approvedAt")
SELECT
  'oe_' || substring(md5(d.event_id || ':okantovka-backfill') for 24),
  d.passport_id,
  'cmorhg4k3000wc6n16e1uifki',
  d.employee_id,
  d.qty,
  19.23,
  round(d.qty * 19.23, 2),
  CASE WHEN d.passport_status = 'PACKED' THEN 'APPROVED' ELSE 'PENDING_RELEASE' END::"EntryStatus",
  'AFTER_RELEASE'::"ApprovalMode",
  'OPERATION_TRANSITION'::"EarningSource",
  d.event_id,
  now(),
  CASE WHEN d.passport_status = 'PACKED' THEN now() ELSE NULL END
FROM _debt d
ON CONFLICT ("passportId", "operationId", "employeeId", "sourceEventType") DO NOTHING;

COMMIT;

-- Контроль (должно быть 0):
-- SELECT count(*) FROM "PassportEvent" e
-- WHERE e.type='OPERATION_FINISHED' AND e."operationId"='cmorhg4k3000wc6n16e1uifki'
--   AND e."employeeId" IS NOT NULL
--   AND NOT EXISTS (SELECT 1 FROM "OperationEntry" oe
--                   WHERE oe."passportId"=e."passportId" AND oe."operationId"=e."operationId");
