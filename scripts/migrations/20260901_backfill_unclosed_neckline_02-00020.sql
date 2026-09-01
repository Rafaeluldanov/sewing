-- 2026-09-01 data-fix (prod). ПРИМЕНЕНО 2026-09-01.
-- Результат: INSERT 1 события + 1 начисления, 19 изделий, 365.37 ₽
-- Джалиловой Айзаде (P-20260822-0013). Контрольный запрос = 0.
-- Хронология паспорта осталась монотонной: взяли 16:12:36 → закрыли
-- 16:17:20.941 → ОТК увела 16:17:21.941 → QC_PASSED 17:32:23.
--
-- Заказ 02-00020 (id cmsrlre980jy99fyz90827wea), операция
-- «NECKLINE_COVERSTICH Ф РАСПОШИВ ГОРЛОВИНЫ» (id cmt4t4as60p2jzd63o5vjjmfa),
-- швея Джалилова Айзада (id cmpe2mm7x00ylvqgu1wbc4qxb),
-- ОДИН паспорт: P-20260822-0013 (id cmt4iprsw0kp3zd63f0jvf52b).
--
-- ЧТО ПРОИЗОШЛО.
-- 31.08 в 16:10-16:12 UTC швея взяла подряд 11 паспортов 02-00020 на
-- распошив горловины (шаг 3 маршрута). В 16:11:51-16:17:21 контролёр
-- Турдибекова Ситора отсканировала пять из них на «05 ОТК» — паспорта
-- уехали на проверку прямо из рук, а взятая операция осталась
-- незакрытой. Четыре (0014, 0017, 0018, 0020) швея пере-взяла в 16:20
-- и закрыла штатно; до пятого — P-20260822-0013, перехваченного
-- последним в 16:17:21, — она не дошла. Он прошёл ОТК (`QC_PASSED`
-- 17:32) и на сегодня стоит на шаге 4 в статусе IN_PROGRESS.
--
-- ПОЧЕМУ СИСТЕМА ЭТО ПРОПУСТИЛА — тот же корень, что у 02-00013
-- (см. 20260823_backfill_unclosed_rasposhiv_02-00013.sql): скан не
-- смотрит владельца (ADR-0003 §6), а маршрутный гейт проверял только
-- шаги СТРОГО МЕЖДУ текущим и целевым, поэтому шаг, на котором паспорт
-- СТОИТ, не проверялся никогда. Детектор, поставленный 23.08
-- (`route-debt.ts` + секция «Незакрытая работа»), этот случай ПОКАЗАЛ,
-- но не удержал: блокировать тогда сознательно не стали.
--
-- ПОСЛЕДСТВИЕ. Сделка не начислена НИКОМУ: `OperationEntry` создаётся
-- только в `completeOperationByEmployee`, а скан следующего исполнителя
-- предыдущую операцию не закрывает. 19 изделий × 19.23 ₽ = 365.37 ₽.
--
-- Работа выполнена физически: без распошива горловины паспорт не прошёл
-- бы ОТК, а он её прошёл (`QC_PASSED` 31.08 17:32:23).
--
-- ПРАВКА — зеркало правки от 23.08, те же три решения:
--   1. `createdAt` события = момент перехвата (16:17:21.941) минус
--      секунда. Работа закончилась до того, как паспорт увели, и
--      хронология остаётся монотонной: взяли → закрыли → ОТК увела.
--      `now()` поставить нельзя — закрытие оказалось бы ПОСЛЕ ОТК.
--   2. `qty` = `Passport.qtyGood` (19) — так пишет штатный
--      `completeOperationByEmployee` и так устроены соседние начисления.
--   3. `status = PENDING_RELEASE` — паспорт в `IN_PROGRESS`, ветка
--      `approveImmediately` в earnings.service.ts включается только для
--      `PACKED`; подтвердит упаковщик при закрытии коробки.
--
-- Ставка 19.23: `Operation.pricingMode = FIXED`, `fixedRate = 19.23`,
-- у шага 3 маршрута `rateOverride` нет; все 55 существующих начислений
-- по этой операции — ровно 19.23, `passOrdinal = 0` (операция стоит в
-- маршруте один раз).
--
-- НЕ наряд-допуск и НЕ `OperationSubstitution`: технология не менялась,
-- операция в маршруте есть и сделана именно она. Это пропущенное
-- нажатие «Завершить» — точнее, отобранная возможность его нажать.
--
-- id с префиксами `pe_`/`oe_`, детерминированные от id события взятия —
-- backfill отличим от штатных cuid-ов, повторный прогон идемпотентен.
--
-- ДЫРУ В КОДЕ ЗАКРЫВАЕТ НЕ ЭТОТ ФАЙЛ, а коммит b334e5f: гейт
-- `PASSPORT_CURRENT_STEP_INCOMPLETE` (перехват паспорта из рук с
-- незакрытым швейным шагом) + секция «Не закрыто вами» на `/work`,
-- где швея закрывает такой долг сама, не двигая паспорт по маршруту.
-- Этот скрипт нужен потому, что до деплоя паспорт может уехать в
-- упаковку, а по `PACKED` кнопка недоступна.

BEGIN;

CREATE TEMP TABLE _debt AS
SELECT
  iss.id            AS issue_event_id,
  p.id              AS passport_id,
  p.number          AS passport_number,
  p."qtyGood"       AS qty,
  iss."employeeId"  AS employee_id,
  iss."equipmentId" AS equipment_id,
  (
    SELECT min(nxt."createdAt")
      FROM "PassportEvent" nxt
     WHERE nxt."passportId" = p.id
       AND nxt."createdAt" > iss."createdAt"
  ) - interval '1 second' AS finished_at
FROM "Passport" p
JOIN "PassportEvent" iss
  ON iss."passportId" = p.id
 AND iss.type = 'ISSUED_TO_EMPLOYEE'
 AND iss."operationId" = 'cmt4t4as60p2jzd63o5vjjmfa'
WHERE p."orderId" = 'cmsrlre980jy99fyz90827wea'
  AND NOT EXISTS (
    SELECT 1 FROM "PassportEvent" f
     WHERE f."passportId" = p.id
       AND f.type = 'OPERATION_FINISHED'
       AND f."operationId" = 'cmt4t4as60p2jzd63o5vjjmfa'
  );

INSERT INTO "PassportEvent"
  (id, "passportId", type, "operationId", "fromOperationId", "employeeId",
   "equipmentId", qty, payload, "createdAt")
SELECT
  'pe_' || substring(md5(d.issue_event_id || ':neckline-backfill') for 24),
  d.passport_id,
  'OPERATION_FINISHED',
  'cmt4t4as60p2jzd63o5vjjmfa',
  'cmt4t4as60p2jzd63o5vjjmfa',
  d.employee_id,
  d.equipment_id,
  d.qty,
  jsonb_build_object(
    'backfill', 'unclosed-neckline-02-00020',
    'reason', 'QC scanned the passport away from the seamstress 4m45s after she took it; her route step stayed unclosed and the piece-rate unpaid',
    'issueEventId', d.issue_event_id
  ),
  d.finished_at
FROM _debt d;

INSERT INTO "OperationEntry"
  (id, "passportId", "operationId", "employeeId", qty, "ratePerUnit", amount,
   status, "approvalMode", "sourceEventType", "sourceEventId", "createdAt",
   "approvedAt", "passOrdinal")
SELECT
  'oe_' || substring(md5(d.issue_event_id || ':neckline-backfill') for 24),
  d.passport_id,
  'cmt4t4as60p2jzd63o5vjjmfa',
  d.employee_id,
  d.qty,
  19.23,
  round(d.qty * 19.23, 2),
  'PENDING_RELEASE'::"EntryStatus",
  'AFTER_RELEASE'::"ApprovalMode",
  'OPERATION_TRANSITION'::"EarningSource",
  'pe_' || substring(md5(d.issue_event_id || ':neckline-backfill') for 24),
  now(),
  NULL,
  0
FROM _debt d
ON CONFLICT ("passportId", "operationId", "employeeId", "sourceEventType", "passOrdinal")
DO NOTHING;

SELECT
  (SELECT count(*) FROM _debt)                   AS passports,  -- ожидаем 1
  (SELECT string_agg(passport_number, ', ') FROM _debt) AS numbers,
  (SELECT sum(qty) FROM _debt)                   AS qty,        -- ожидаем 19
  (SELECT round(sum(qty) * 19.23, 2) FROM _debt) AS amount;     -- ожидаем 365.37

COMMIT;

-- Контроль (должно быть 0):
-- SELECT count(*) FROM "Passport" p
--  WHERE p."orderId" = 'cmsrlre980jy99fyz90827wea'
--    AND EXISTS (SELECT 1 FROM "PassportEvent" i WHERE i."passportId"=p.id
--                 AND i.type='ISSUED_TO_EMPLOYEE' AND i."operationId"='cmt4t4as60p2jzd63o5vjjmfa')
--    AND NOT EXISTS (SELECT 1 FROM "PassportEvent" f WHERE f."passportId"=p.id
--                     AND f.type='OPERATION_FINISHED' AND f."operationId"='cmt4t4as60p2jzd63o5vjjmfa');
