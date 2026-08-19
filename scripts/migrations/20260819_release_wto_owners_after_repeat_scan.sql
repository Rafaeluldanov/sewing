-- 19.08.2026 — то же, что `20260819_release_qc_owners_after_repeat_scan.sql`,
-- но для ВТО: снятие владельца с паспортов, зависших на ВТО после
-- ПОВТОРНОГО скана уже отпаренного паспорта.
--
-- УЖЕ ПРИМЕНЕНО НА ПРОДЕ 2026-08-19 ~15:20 UTC (5 строк, ассерты
-- прошли). Файл — журнал для истории и воспроизведения.
--
-- Причина — ровно та же, разбор см. в QC-скрипте рядом:
-- `WtoService.completeWto` пишет `WTO_PASSED`, снимает владельца, но не
-- двигает шаг маршрута; паспорт остаётся стоять на ВТО и лежит у
-- отпарщика. Повторный скан из стопки после фикса 10.08.2026 (владельца
-- больше нет → `sameEmployee = false` в
-- `PassportsService.scanOnOperation`) снова забирает паспорт ему на
-- руки, а `WtoService.loadDetail::removedFromWto` считает этот же скан
-- уходом на следующую операцию — карточка не открывается, отпустить
-- паспорт может только мастер.
--
-- Инцидент: заказ O-20260530-0001, отпарщик Токтогулов Жениш, 5
-- паспортов. Отпарены 30.07, повторно отсканированы 11.08 09:35:31–
-- 09:35:40 (пять штук за девять секунд — прогон стопки) — то есть
-- через четыре часа после деплоя eb981e9 (11.08 05:39 UTC), который
-- этот класс и открыл.
--
-- Код починен в той же ветке (общая с ОТК ветка no-op в
-- `scanOnOperation` через `isRoleCheckSettled` + фильтр по категории в
-- `removedFromWto`).
--
-- Что делаем и кого берём — см. шапку QC-скрипта; здесь всё зеркально,
-- с `category = 'IRONING'` и событием `WTO_PASSED`.
--
-- Ожидаем 5 строк.

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
   AND op.category = 'IRONING'
   -- все проходы ВТО закрыты
   AND (
         SELECT count(*) FROM "PassportEvent" ev
          WHERE ev."passportId" = p.id
            AND ev.type = 'WTO_PASSED'
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
            AND ev.type = 'WTO_PASSED'
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
  IF v_total > 15 THEN
    RAISE EXCEPTION 'Выборка % строк — больше ожидаемых 5 (+запас); остановлено', v_total;
  END IF;
END $$;

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", payload, "employeeId", "createdAt")
SELECT 'al_' || substring(md5(random()::text || r.id) for 24),
       'MASTER_PASSPORT_UNASSIGNED',
       'PASSPORT',
       r.id,
       jsonb_build_object(
         'reason', 'DATA_FIX',
         'comment', 'Снятие владельца после повторного скана отпаренного паспорта (data-fix 19.08.2026)',
         'source', 'scripts/migrations/20260819_release_wto_owners_after_repeat_scan.sql',
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
