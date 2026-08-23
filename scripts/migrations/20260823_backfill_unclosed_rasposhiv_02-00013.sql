-- 2026-08-23 data-fix (prod). ПРИМЕНЕНО 2026-08-23.
-- Результат: INSERT 10 событий + 10 начислений, 146 изделий, 3 743.44 ₽
-- Кенжабаевой (было 16 начислений / 161 шт / 4 128.04 ₽ по этой операции
-- в заказе, стало 26 / 307 / 7 871.48 ₽). Контрольный запрос = 0.
--
-- Заказ 02-00013, операция «04 Ф РАСПОШИВ» (id cmorgh5oh000310sv7nyr7fve),
-- швея Кенжабаева Барчиной (id cms37u5zx02r1mbl7f36vjw3u), 10 паспортов:
--   P-20260810-0005, -0011, -0027, -0028, -0029,
--   P-20260810-0084, -0088, -0090, -0106, -0108.
--
-- ЧТО ПРОИЗОШЛО.
-- 14.08 и 17.08 швея взяла эти 10 паспортов на распошив
-- (`ISSUED_TO_EMPLOYEE.operationId = 04` — верно, это шаг 4 маршрута
-- заказа) и ни одного не завершила. На следующий день каждый паспорт
-- увела вперёд ОТК своим сканом (`OPERATION_SCAN` на «05 ОТК»), дальше
-- они прошли ОТК и ВТО и сейчас стоят на шагах 5-6.
--
-- ПОЧЕМУ СИСТЕМА ЭТО ПРОПУСТИЛА — три независимых места, каждое по
-- отдельности сознательное:
--   1. `PassportsService.scanOnOperation` не проверяет, у кого паспорт
--      на руках («любое сканирование = переход», ADR-0003 §6). В
--      `issueToEmployee` тот же случай даёт 409 PASSPORT_ALREADY_ISSUED,
--      в скане — нет.
--   2. Маршрутный гейт `evaluateRouteOrder` проверяет только шаги
--      СТРОГО МЕЖДУ текущим и целевым (`rep > currentRep && rep <
--      targetRep`). Шаг, на котором паспорт СТОИТ, не проверяется
--      никогда — уйти с него незакрытым можно всегда.
--   3. AND-гейт перед ОТК (`QcService.assertParallelGroupCompleteForQc`)
--      смотрит только параллельные группы. Маршрут 02-00013 линейный,
--      группы в нём нет — ОТК не удержала.
--
-- ПОСЛЕДСТВИЯ.
--   1. Шаг 4 маршрута не закрыт ни на одном из 10 паспортов.
--   2. Сдельная не начислена НИКОМУ: `OperationEntry` создаётся только в
--      `completeOperationByEmployee` (см. `EarningsService.
--      createPendingForCompletedOperation`), а скан следующего
--      исполнителя предыдущую операцию не закрывает. 146 изделий по
--      ставке 25.64 ₽/шт = 3 743.44 ₽ у Кенжабаевой.
--   3. Увидеть это было негде: вкладка «Расхождения» ловит закрытие
--      операции ВНЕ маршрута, здесь ровно наоборот — операция в
--      маршруте есть, а закрытия нет.
--
-- Работа выполнена физически: без распошива паспорта не прошли бы ОТК, а
-- все 10 её прошли (`QC_PASSED`) и закрылись на ВТО.
--
-- ПРАВКА. Дописываем недостающее закрытие и сделку:
--   * PassportEvent  — 10 × OPERATION_FINISHED (operationId =
--     fromOperationId = 04, employeeId/equipmentId из события взятия,
--     qty = `Passport.qtyGood`);
--   * OperationEntry — 10 × сделка по 25.64 ₽/шт (у шага нет
--     `rateOverride`, операция FIXED 25.64; сверка: соседние начисления
--     по 04 в этом же заказе — ровно 25.64).
--
-- Три решения, зеркалящих штатное поведение сервиса (не отсебятина):
--   1. `createdAt` события = момент, когда паспорт увели вперёд, минус
--      секунда. Работа закончилась до перехвата, и хронология событий
--      паспорта остаётся монотонной: взяли -> закрыли -> ОТК увела.
--      Ставить `now()` нельзя — закрытие оказалось бы ПОСЛЕ ОТК и ВТО.
--   2. `qty` = `Passport.qtyGood`, а не `qtyCut` — так пишет и штатный
--      `completeOperationByEmployee`, и так устроены соседние
--      начисления по этому заказу.
--   3. `status = PENDING_RELEASE` — все 10 паспортов в `IN_PROGRESS`
--      (ветка `approveImmediately` в earnings.service.ts включается
--      только для `PACKED`, иначе начисление зависло бы навсегда).
--
-- НЕ наряд-допуск и НЕ `OperationSubstitution`: технология не менялась,
-- операция стоит в маршруте и сделана именно она. Это пропущенное
-- нажатие «Завершить», а не замена шага.
--
-- id с префиксами `pe_`/`oe_`, детерминированные от id события взятия —
-- backfill отличим от штатных cuid-ов, а повторный прогон идемпотентен.
--
-- Дыру в коде закрывает не этот файл, а сопутствующая правка:
-- `production-board/route-debt.ts` + секция «Незакрытая работа» у
-- мастера + проверка `ORDER_WORK_LEFT_UNCLOSED` в диагностике + аудит
-- `PASSPORT_TAKEN_FROM_EMPLOYEE` при перехвате паспорта сканом.

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
 AND iss."operationId" = 'cmorgh5oh000310sv7nyr7fve'
WHERE p."orderId" = 'cmsj37zf10008labg9qcxmk9t'
  AND NOT EXISTS (
    SELECT 1 FROM "PassportEvent" f
     WHERE f."passportId" = p.id
       AND f.type = 'OPERATION_FINISHED'
       AND f."operationId" = 'cmorgh5oh000310sv7nyr7fve'
  );

INSERT INTO "PassportEvent"
  (id, "passportId", type, "operationId", "fromOperationId", "employeeId",
   "equipmentId", qty, payload, "createdAt")
SELECT
  'pe_' || substring(md5(d.issue_event_id || ':rasposhiv-backfill') for 24),
  d.passport_id,
  'OPERATION_FINISHED',
  'cmorgh5oh000310sv7nyr7fve',
  'cmorgh5oh000310sv7nyr7fve',
  d.employee_id,
  d.equipment_id,
  d.qty,
  jsonb_build_object(
    'backfill', 'unclosed-rasposhiv-02-00013',
    'reason', 'seamstress took the passport on 04 and never pressed complete; the next scanner (QC) took the passport away, leaving the route step unclosed and the piece-rate unpaid',
    'issueEventId', d.issue_event_id
  ),
  d.finished_at
FROM _debt d;

INSERT INTO "OperationEntry"
  (id, "passportId", "operationId", "employeeId", qty, "ratePerUnit", amount,
   status, "approvalMode", "sourceEventType", "sourceEventId", "createdAt",
   "approvedAt", "passOrdinal")
SELECT
  'oe_' || substring(md5(d.issue_event_id || ':rasposhiv-backfill') for 24),
  d.passport_id,
  'cmorgh5oh000310sv7nyr7fve',
  d.employee_id,
  d.qty,
  25.64,
  round(d.qty * 25.64, 2),
  'PENDING_RELEASE'::"EntryStatus",
  'AFTER_RELEASE'::"ApprovalMode",
  'OPERATION_TRANSITION'::"EarningSource",
  'pe_' || substring(md5(d.issue_event_id || ':rasposhiv-backfill') for 24),
  now(),
  NULL,
  0
FROM _debt d
ON CONFLICT ("passportId", "operationId", "employeeId", "sourceEventType", "passOrdinal")
DO NOTHING;

SELECT
  (SELECT count(*) FROM _debt)                        AS passports,   -- ожидаем 10
  (SELECT sum(qty) FROM _debt)                        AS qty,         -- ожидаем 146
  (SELECT round(sum(qty) * 25.64, 2) FROM _debt)      AS amount;      -- ожидаем 3743.44

COMMIT;

-- Контроль (должно быть 0):
-- SELECT count(*) FROM "Passport" p
--  WHERE p."orderId" = 'cmsj37zf10008labg9qcxmk9t'
--    AND EXISTS (SELECT 1 FROM "PassportEvent" i WHERE i."passportId"=p.id
--                 AND i.type='ISSUED_TO_EMPLOYEE' AND i."operationId"='cmorgh5oh000310sv7nyr7fve')
--    AND NOT EXISTS (SELECT 1 FROM "PassportEvent" f WHERE f."passportId"=p.id
--                     AND f.type='OPERATION_FINISHED' AND f."operationId"='cmorgh5oh000310sv7nyr7fve');
