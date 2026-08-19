-- 19.08.2026 — снятие владельца с паспортов, зависших на ОТК после
-- ПОВТОРНОГО скана уже проверенного паспорта.
--
-- УЖЕ ПРИМЕНЕНО НА ПРОДЕ 2026-08-19 ~14:40 UTC (11 строк, ассерты
-- прошли). Файл — журнал для истории и воспроизведения на других
-- средах.
--
-- Причина. `QcService.completeQc` пишет `QC_PASSED`, снимает владельца,
-- но НЕ двигает `currentOperationId` / `currentRouteStepIndex`: паспорт
-- остаётся стоять на ОТК, пока его не заберёт следующая операция.
-- Физически он так и лежит на столе контролёра — и уходит в повторный
-- скан из стопки. До 11.08.2026 такой скан был безобиден: владельцем
-- оставалась сама ОТК, и `PassportsService.scanOnOperation` уходил в
-- идемпотентную ветку `sameOp && sameEmployee`. После фикса «ОТК
-- отпускает паспорт» (`completeQc`, инцидент 10.08.2026, см.
-- `20260810_release_stuck_qc_wto_passport_owners.sql`) владельца больше
-- нет, `sameEmployee` = false — и скан шёл в полную ветку перехода,
-- снова забирая проверенный паспорт контролёру на руки.
--
-- Дальше паспорт вставал намертво:
--   - следующий исполнитель получал 409 `PASSPORT_ALREADY_ISSUED`
--     (ветка route-WIP без ячейки в `issueToEmployee`);
--   - сама ОТК отпустить его уже не могла: `QcService.loadDetail`
--     считал `removedFromQc` по «есть `OPERATION_SCAN` после
--     `QC_PASSED`» — а это был её же скан, — и терминал отвечал
--     «Паспорт ушёл на следующую операцию», не открывая карточку ни
--     сканом, ни из «В работе у вас».
-- Снимал только мастер: так 19.08.2026 расшили `P-20260810-0109`
-- (`MASTER_PASSPORT_ROUTE_STEP_SET` от Урмановой).
--
-- Инцидент: заказ 02-00013, ОТК Турдибекова Ситора, 10 паспортов
-- 14–19.08.2026 (шесть — одной пачкой 15.08 с 15:00:33 до 15:01:50:
-- прогоняла стопку, на каждый получала «паспорт ушёл дальше»).
-- Плюс два паспорта Андашовой от 29.05.2026 (`P-20260511-0115`,
-- `-0118`) — тот же класс: скрипт от 10.08 их намеренно не тронул,
-- рассчитывая, что ОТК закроет их повторным «Проверка выполнена», но
-- карточка для них как раз и не открывалась.
--
-- Код починен в той же ветке:
--   - `PassportsService.scanOnOperation` — повторный скан паспорта,
--     у которого все проходы ОТК закрыты, теперь no-op (не пишет
--     событие, не забирает владельца), см. `isQcPassSettled`;
--   - `QcService.loadDetail` — `removedFromQc` больше не считает
--     сканы по самой ОТК-категории «уходом на следующую операцию»,
--     так что карточка проверенного паспорта снова открывается.
-- Этот скрипт разбирает то, что накопилось ДО фикса.
--
-- Что делаем. Только `currentEmployeeId = NULL`. Операцию, шаг
-- маршрута, ячейку и статус НЕ трогаем — это не движение по маршруту,
-- а то же освобождение, что делает мастер
-- (`MasterActionsService.unassign`). Паспорт остаётся `IN_PROGRESS` на
-- шаге ОТК и уходит дальше штатно.
--
-- Кого берём:
--   - `status = IN_PROGRESS`, владелец проставлен, паспорт стоит на
--     операции категории QC;
--   - все проходы ОТК по маршруту закрыты — число `QC_PASSED` после
--     последнего `OPERATION_REWORK_OPENED` на этой же операции не
--     меньше числа вхождений операции в маршрут заказа (зеркало
--     идемпотентности `completeQc` и нового `isQcPassSettled`);
--   - последнее взятие паспорта на эту операцию (`OPERATION_SCAN` /
--     `ISSUED_TO_EMPLOYEE`) НОВЕЕ последнего `QC_PASSED` — то есть
--     владелец появился именно от повторного скана.
--
-- Последнее условие — граница с фиксом от 10.08: там брали ровно
-- обратный случай (`QC_PASSED` новее взятия). Кто держит паспорт в
-- руках до проверки (`QC_PASSED` ещё нет) — не попадает вовсе.
--
-- Ожидаем 11 строк: 9 по заказу 02-00013 + 2 по O-20260508-0001.

BEGIN;

CREATE TEMP TABLE _release ON COMMIT DROP AS
SELECT p.id,
       p.number,
       p."currentEmployeeId"     AS prev_emp,
       p."currentOperationId"    AS prev_op,
       p."currentRouteStepIndex" AS prev_step
  FROM "Passport" p
  JOIN "Operation" op ON op.id = p."currentOperationId"
 WHERE p.status = 'IN_PROGRESS'
   AND p."currentEmployeeId" IS NOT NULL
   AND op.category = 'QC'
   -- все проходы ОТК закрыты
   AND (
         SELECT count(*) FROM "PassportEvent" ev
          WHERE ev."passportId" = p.id
            AND ev.type = 'QC_PASSED'
            AND ev."createdAt" > COALESCE(
                  (
                    SELECT max(r."createdAt") FROM "PassportEvent" r
                     WHERE r."passportId" = p.id
                       AND r."operationId" = p."currentOperationId"
                       AND r.type = 'OPERATION_REWORK_OPENED'
                  ),
                  '-infinity'::timestamp
                )
       ) >= GREATEST(
         1,
         (
           SELECT count(*) FROM "OrderRouteStep" s
            WHERE s."orderId" = p."orderId"
              AND s."operationId" = p."currentOperationId"
         )
       )
   -- владелец появился от взятия ПОСЛЕ проверки (повторный скан)
   AND (
         SELECT max(ev."createdAt") FROM "PassportEvent" ev
          WHERE ev."passportId" = p.id
            AND ev."operationId" = p."currentOperationId"
            AND ev.type IN ('OPERATION_SCAN', 'ISSUED_TO_EMPLOYEE')
       ) > (
         SELECT max(ev."createdAt") FROM "PassportEvent" ev
          WHERE ev."passportId" = p.id
            AND ev.type = 'QC_PASSED'
       );

DO $$
DECLARE
  v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM _release;
  RAISE NOTICE 'К освобождению: %', v_total;
  IF v_total = 0 THEN
    RAISE EXCEPTION 'Нечего освобождать — выборка пуста, проверьте условие';
  END IF;
  -- Ассерт на порядок величины, а не на точное число: между снятием
  -- слепка и запуском пара паспортов могла уйти дальше сама.
  IF v_total > 20 THEN
    RAISE EXCEPTION 'Выборка % строк — больше ожидаемых 11 (+запас); остановлено', v_total;
  END IF;
END $$;

-- Аудит ДО апдейта: before-снимок, чтобы разбор «кто потерял паспорт»
-- был воспроизводим. Событие то же, что у ручного снятия мастером.
INSERT INTO "AuditLog" (id, event, "entityType", "entityId", payload, "employeeId", "createdAt")
SELECT 'al_' || substring(md5(random()::text || r.id) for 24),
       'MASTER_PASSPORT_UNASSIGNED',
       'PASSPORT',
       r.id,
       jsonb_build_object(
         'reason', 'DATA_FIX',
         'comment', 'Снятие владельца после повторного скана проверенного паспорта (data-fix 19.08.2026)',
         'source', 'scripts/migrations/20260819_release_qc_owners_after_repeat_scan.sql',
         'before', jsonb_build_object(
           'currentEmployeeId', r.prev_emp,
           'currentOperationId', r.prev_op,
           'currentRouteStepIndex', r.prev_step
         ),
         'after', jsonb_build_object(
           'currentEmployeeId', NULL,
           'currentOperationId', r.prev_op,
           'currentRouteStepIndex', r.prev_step
         )
       ),
       NULL,
       now()
  FROM _release r;

UPDATE "Passport" p
   SET "currentEmployeeId" = NULL,
       "updatedAt" = now()
  FROM _release r
 WHERE p.id = r.id;

-- Пост-проверка: владельцев не осталось, кроме владельца ничего не
-- поехало.
DO $$
DECLARE
  v_left int;
  v_moved int;
BEGIN
  SELECT count(*) INTO v_left
    FROM "Passport" p JOIN _release r ON r.id = p.id
   WHERE p."currentEmployeeId" IS NOT NULL;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'Осталось % паспортов с владельцем — откат', v_left;
  END IF;

  SELECT count(*) INTO v_moved
    FROM "Passport" p JOIN _release r ON r.id = p.id
   WHERE p."currentOperationId" IS DISTINCT FROM r.prev_op
      OR p."currentRouteStepIndex" IS DISTINCT FROM r.prev_step
      OR p.status <> 'IN_PROGRESS';
  IF v_moved <> 0 THEN
    RAISE EXCEPTION 'У % паспортов поехали операция/шаг/статус — откат', v_moved;
  END IF;
END $$;

COMMIT;
