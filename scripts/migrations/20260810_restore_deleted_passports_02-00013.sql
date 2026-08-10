-- 10.08.2026 — возврат 44 паспортов заказа 02-00013, снесённых открытием расклада.
--
-- Предыстория. 10.08 в 10:32 МСК раскройщик нажал «Открыть расклад», чтобы
-- поправить ошибку в настиле, и вместе с открытием ушли все 90 выпущенных по
-- раскладу паспортов (`PASSPORT_DELETED`, reason `CUTTING_LAY_REOPENED`) —
-- штатное поведение: настил меняется, старая бумага недействительна. Но
-- ошибка оказалась только в рулонах 1–2 (слои 10→7 и 2→8); рулоны 3–15
-- раскройщик перенабрал один в один, и напечатанные листы по ним верны по
-- размеру, рулону и количеству. Печатать их заново незачем.
--
-- Что возвращаем: 44 паспорта — тройки «расклад 1 × размер × рулон», которые
--   1) не выпущены заново (M рулоны 3–15 уже перевыпущены — их листы в мусор);
--   2) сохранили свободным свой номер. Номера P-0001…0025 счётчик выдал
--      повторно (`PassportNumberService` считает от максимума существующих),
--      их заняли новые паспорта — поэтому L рулоны 3–15 и XL рулоны 3–10
--      (21 лист) вернуть нельзя, они уходят в перепечатку;
--   3) совпали по `qtyCut` с расчётом по текущему настилу (слои × «на настиле»).
--
-- Почему бумага снова заработает: возвращаем с ИСХОДНЫМИ `id`, а QR паспорта —
-- это `passport:{id}` (ADR-0008). Значит напечатанный QR сканируется, и старые
-- задания печати (`PrintJob.sourceId`, все PRINTED) снова указывают на живой
-- паспорт.
--
-- Что восстанавливаем: сам паспорт + событие `CREATED`. Больше у свежего
-- паспорта дочерних строк нет: сдельного начисления за выпуск по этому заказу
-- не было вовсе (раскройщик на окладе, `OperationEntry` по заказу = 0), в
-- ячейку эти паспорта не размещались, в работу не уходили.
--
-- Нумерация не поедет: следующий номер = max+1, то есть P-20260810-0091.
--
-- Все допущения проверяются ассертами ниже; при любом расхождении транзакция
-- падает целиком.

BEGIN;

CREATE TEMP TABLE restore_passports ON COMMIT DROP AS
WITH ord AS (
  SELECT o.id FROM "Order" o WHERE o.number = '02-00013'
),
lay AS (
  SELECT l.id
    FROM "CuttingTaskLay" l
    JOIN "CuttingTask" t ON t.id = l."taskId"
    JOIN ord ON ord.id = t."orderId"
   WHERE l.ordinal = 1
),
-- Расчёт по ТЕКУЩЕМУ настилу: слои рулона × «на настиле» размера. С ним
-- сверяем `qtyCut` напечатанного паспорта — это и есть проверка «бумага
-- подходит».
plan AS (
  SELECT ls."sizeId", r.ordinal AS roll, r.layers * ls."perLayerQty" AS qty,
         r."variantId"
    FROM lay
    JOIN "CuttingTaskLaySize" ls ON ls."layId" = lay.id
    JOIN "CuttingTaskRoll" r ON r."layId" = lay.id
),
del AS (
  SELECT a."entityId" AS id,
         a.payload->>'number' AS number,
         a.payload->>'sizeId' AS "sizeId",
         (a.payload->>'rollOrdinal')::int AS roll,
         (a.payload->>'qtyCut')::int AS qty
    FROM "AuditLog" a, ord
   WHERE a.event = 'PASSPORT_DELETED'
     AND a.payload->>'reason' = 'CUTTING_LAY_REOPENED'
     AND a.payload->>'orderId' = ord.id
),
-- Шаблон общих полей берём с живого паспорта того же заказа: он выпущен тем
-- же кодом по тому же раскладу, отличается только размером и рулоном.
tpl AS (
  SELECT p."productId", p."cutDate", p."currentOperationId",
         p."currentRouteStepIndex", p."cutterId", p."creatorId"
    FROM "Passport" p, ord
   WHERE p."orderId" = ord.id
   ORDER BY p."createdAt"
   LIMIT 1
)
SELECT d.id,
       d.number,
       ord.id AS "orderId",
       d."sizeId",
       d.roll,
       d.qty,
       pl."variantId",
       -- Цвет — строкой ровно как его пишет выпуск (в паспорте он в нижнем
       -- регистре, в `OrderVariant` — с заглавной), поэтому берём с живого
       -- паспорта той же расцветки, а не из справочника.
       (SELECT p2.color FROM "Passport" p2
         WHERE p2."orderId" = ord.id AND p2."orderVariantId" = pl."variantId"
         LIMIT 1) AS color,
       -- Момент выпуска восстанавливаем по заданию печати этого паспорта —
       -- оно создавалось секунда в секунду с выпуском.
       COALESCE(
         (SELECT min(j."createdAt") FROM "PrintJob" j WHERE j."sourceId" = d.id),
         now()
       ) AS created_at,
       tpl."productId", tpl."cutDate", tpl."currentOperationId",
       tpl."currentRouteStepIndex", tpl."cutterId", tpl."creatorId"
  FROM del d
  JOIN ord ON true
  JOIN tpl ON true
  JOIN plan pl ON pl."sizeId" = d."sizeId" AND pl.roll = d.roll
 WHERE d.roll >= 3
   AND d.qty = pl.qty
   -- Тройка не выпущена заново.
   AND NOT EXISTS (
     SELECT 1 FROM "Passport" p
      WHERE p."orderId" = ord.id AND p."cuttingLayOrdinal" = 1
        AND p."sizeId" = d."sizeId" AND p."rollOrdinal" = d.roll
   )
   -- Номер с листа свободен (иначе бумага соврёт про чужой паспорт).
   AND NOT EXISTS (SELECT 1 FROM "Passport" p WHERE p.number = d.number);

DO $$
DECLARE
  v_count int;
  v_bad int;
BEGIN
  SELECT count(*) INTO v_count FROM restore_passports;
  IF v_count <> 44 THEN
    RAISE EXCEPTION 'Ожидали 44 паспорта к возврату, отобрано % — возврат отменён', v_count;
  END IF;

  SELECT count(*) INTO v_bad FROM restore_passports WHERE color IS NULL OR "variantId" IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'У % строк не определилась расцветка — возврат отменён', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM restore_passports r
   WHERE EXISTS (SELECT 1 FROM "Passport" p WHERE p.id = r.id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% паспортов уже существуют по id — возврат отменён', v_bad;
  END IF;
END $$;

INSERT INTO "Passport" (
  id, number, "qrCode", "orderId", "productId", "sizeId", color, "rollNumber",
  "cutDate", "qtyPlan", "qtyCut", "qtyDefect", "qtyGood", status,
  "currentOperationId", "currentEmployeeId", "currentCellId",
  "cutterId", "creatorId", "createdAt", "updatedAt",
  "currentRouteStepIndex", "rollOrdinal", "cuttingLayOrdinal", "orderVariantId"
)
SELECT r.id,
       r.number,
       'passport:' || r.id,
       r."orderId",
       r."productId",
       r."sizeId",
       r.color,
       'Расклад 1 · Рулон ' || r.roll,
       r."cutDate",
       r.qty, r.qty, 0, r.qty,
       'CREATED'::"PassportStatus",
       r."currentOperationId",
       r."creatorId",
       NULL,
       r."cutterId",
       r."creatorId",
       r.created_at,
       now(),
       r."currentRouteStepIndex",
       r.roll,
       1,
       r."variantId"
  FROM restore_passports r;

-- Событие выпуска — как его пишет `createOnePassportInTx`.
INSERT INTO "PassportEvent" (
  id, "passportId", type, "operationId", "employeeId", qty, payload, "createdAt"
)
SELECT gen_random_uuid()::text,
       r.id,
       'CREATED'::"PassportEventType",
       r."currentOperationId",
       r."creatorId",
       r.qty,
       jsonb_build_object('rollNumber', 'Расклад 1 · Рулон ' || r.roll, 'color', r.color),
       r.created_at
  FROM restore_passports r;

-- След в аудите: удаление там уже записано, возврат должен быть виден рядом.
INSERT INTO "AuditLog" (id, event, "entityType", "entityId", payload, "employeeId", "createdAt")
SELECT gen_random_uuid()::text,
       'PASSPORT_RESTORED',
       'PASSPORT',
       r.id,
       jsonb_build_object(
         'number', r.number,
         'orderId', r."orderId",
         'sizeId', r."sizeId",
         'qtyCut', r.qty,
         'cuttingLayOrdinal', 1,
         'rollOrdinal', r.roll,
         'reason', 'CUTTING_LAY_REOPENED_ROLLBACK',
         'note', 'Настил рулонов 3-15 не менялся, напечатанная бумага действительна'
       ),
       r."creatorId",
       now()
  FROM restore_passports r;

COMMIT;

-- Проверка после применения: по раскладу 1 должно стать 69 паспортов из 90,
-- невыпущенными остаются L рулоны 3–15 и XL рулоны 3–10 (их перепечатывают).
--
-- SELECT s.code, count(*), min(p."rollOrdinal"), max(p."rollOrdinal")
--   FROM "Passport" p JOIN "Size" s ON s.id = p."sizeId"
--   JOIN "Order" o ON o.id = p."orderId"
--  WHERE o.number = '02-00013' GROUP BY s.code ORDER BY s.code;
