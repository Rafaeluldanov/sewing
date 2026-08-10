-- 10.08.2026 — снятие висящих владельцев с паспортов, уже прошедших ОТК/ВТО.
--
-- Причина. У швеи владельца снимает явное «Завершить операцию»
-- (`PassportsService.completeOperationByEmployee` → `currentEmployeeId =
-- null`), а у ОТК и ВТО такого шага не было: «Проверка выполнена» /
-- «Завершить ВТО» писали только `PassportEvent(QC_PASSED / WTO_PASSED)`
-- и строку паспорта не трогали вовсе. При этом владельцем контролёр
-- становится ровно так же, как швея — сканом паспорта
-- (`scanOnOperation`) или «Взять крой» (`issueToEmployee`).
--
-- Итог: годный паспорт навсегда оставался «в работе» у контролёра.
-- Следующий исполнитель получал на «Взять крой» 409
-- `PASSPORT_ALREADY_ISSUED` (ветка route-WIP без ячейки в
-- `issueToEmployee`), а сам контролёр не мог переключить операцию смены
-- (`SHIFT_HAS_ACTIVE_PASSPORTS`). Брак паспорт освобождал
-- (`QcService.returnToRework` обнуляет владельца), годный — нет.
-- Инцидент 10.08.2026: `P-20260804-0007` (заказ 02-00003) не отдавался
-- на ПЕТЛЮ после ОТК; тот же класс лечили руками ещё 29.05.2026 —
-- см. `20260529_unblock_5_passports_stuck_at_otk.sql` («снимает
-- зависание у Астры»).
--
-- Код починен в той же ветке: `QcService.completeQc` и
-- `WtoService.completeWto` теперь снимают `currentEmployeeId` в своей
-- транзакции. Этот скрипт разбирает то, что накопилось ДО фикса.
--
-- Что делаем. Только `currentEmployeeId = NULL`. Операцию, шаг
-- маршрута, ячейку и статус НЕ трогаем — это не движение по маршруту,
-- а то же освобождение, что делает мастер
-- (`MasterActionsService.unassign`). Паспорт остаётся `IN_PROGRESS` на
-- своём шаге; на доске цеха он переезжает из «у сотрудника» в «буфер»
-- (`ProductionBoardService.resolveColumnOp` позиционирует буферный
-- паспорт по `currentRouteStepIndex` — то есть ровно туда же).
--
-- Кого берём (жёсткое условие, ниже продублировано ассертами):
--   - `status = IN_PROGRESS`, владелец проставлен;
--   - паспорт физически стоит на операции категории QC или IRONING;
--   - последний `QC_PASSED` / `WTO_PASSED` НОВЕЕ последнего взятия
--     (`OPERATION_SCAN` / `ISSUED_TO_EMPLOYEE`) на этой же операции.
--
-- Последнее условие отсекает тех, кто держит паспорт в руках прямо
-- сейчас. На 10.08.2026 под него не попали и остались нетронутыми:
--   - 5 паспортов на ОТК вообще без `QC_PASSED` (P-20260710-0041,
--     -0038, -0051, -0034, P-20260530-0307) — проверка не завершена;
--   - 3 паспорта, заново отсканированных на ОТК уже ПОСЛЕ своей
--     проверки (P-20260511-0118, -0115, P-20260530-0298) — идёт второй
--     проход.
-- Все 8 закроются штатно: после фикса даже повторное нажатие
-- «Проверка выполнена» снимает владельца (освобождение стоит до
-- идемпотентного выхода в `completeQc`).
--
-- Ожидаем 112 строк: 65 на ОТК + 47 на ВТО.

BEGIN;

CREATE TEMP TABLE _release ON COMMIT DROP AS
SELECT p.id,
       p.number,
       op.category::text AS category,
       p."currentEmployeeId" AS prev_emp,
       p."currentOperationId" AS prev_op,
       p."currentRouteStepIndex" AS prev_step
  FROM "Passport" p
  JOIN "Operation" op ON op.id = p."currentOperationId"
 WHERE p.status = 'IN_PROGRESS'
   AND p."currentEmployeeId" IS NOT NULL
   AND op.category IN ('QC', 'IRONING')
   AND (
         SELECT max(ev."createdAt") FROM "PassportEvent" ev
          WHERE ev."passportId" = p.id
            AND ev.type IN ('QC_PASSED', 'WTO_PASSED')
       ) IS NOT NULL
   AND (
         SELECT max(ev."createdAt") FROM "PassportEvent" ev
          WHERE ev."passportId" = p.id
            AND ev.type IN ('QC_PASSED', 'WTO_PASSED')
       ) > COALESCE(
         (
           SELECT max(ev."createdAt") FROM "PassportEvent" ev
            WHERE ev."passportId" = p.id
              AND ev."operationId" = p."currentOperationId"
              AND ev.type IN ('OPERATION_SCAN', 'ISSUED_TO_EMPLOYEE')
         ),
         '-infinity'::timestamp
       );

DO $$
DECLARE
  v_total int;
  v_qc int;
  v_wto int;
BEGIN
  SELECT count(*) INTO v_total FROM _release;
  SELECT count(*) INTO v_qc  FROM _release WHERE category = 'QC';
  SELECT count(*) INTO v_wto FROM _release WHERE category = 'IRONING';
  RAISE NOTICE 'К освобождению: % (ОТК %, ВТО %)', v_total, v_qc, v_wto;
  -- Ассерт на порядок величины, а не на точное число: скрипт может
  -- запускаться позже снятия слепка, и пара паспортов успеет уйти
  -- дальше сама. Защищаемся от обратного — от выборки, разъехавшейся
  -- настолько, что она задевает живую работу.
  IF v_total = 0 THEN
    RAISE EXCEPTION 'Нечего освобождать — выборка пуста, проверьте условие';
  END IF;
  IF v_total > 130 THEN
    RAISE EXCEPTION 'Выборка % строк — больше ожидаемых 112 (+запас); остановлено', v_total;
  END IF;
END $$;

-- Аудит ДО апдейта: пишем before-снимок, чтобы разбор «кто потерял
-- паспорт» был воспроизводим. Событие то же, что у ручного снятия
-- мастером, с пометкой источника в payload.
INSERT INTO "AuditLog" (id, event, "entityType", "entityId", payload, "employeeId", "createdAt")
SELECT 'al_' || substring(md5(random()::text || r.id) for 24),
       'MASTER_PASSPORT_UNASSIGNED',
       'PASSPORT',
       r.id,
       jsonb_build_object(
         'reason', 'DATA_FIX',
         'comment', 'Снятие висящего владельца после ОТК/ВТО (data-fix 10.08.2026)',
         'source', 'scripts/migrations/20260810_release_stuck_qc_wto_passport_owners.sql',
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

-- Пост-проверка: ни один паспорт из выборки не остался с владельцем,
-- и ничего кроме владельца не поехало.
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
