-- 2026-05-29: мерж дубля ОТК-операций (code='QC' → code='05').
--
-- Контекст. В справочнике Operation было две «ОТК»-операции:
--   05 (cmorgjz8p0001vo5izylz9nbk, category=QC) — «истинная», в 15
--       OrderRouteStep и 2 RouteTemplateStep, на станке otk.
--   QC (cmosgtt1q000bf3icjeakbafs, category=QC) — операционный дубль:
--       0 routes/templates, но 107 PassportEvent.operationId + 76
--       fromOperationId + 4 ShiftSession + 12 Passport.currentOperationId,
--       на станке otk-2. Сотрудник ОТК исторически сканит на QC, а
--       маршрут ждёт 05 — расхождение убирается тем, что QC_PASSED —
--       role-terminal маркер (не OPERATION_FINISHED), но дубль создаёт
--       класс будущих ошибок.
--
-- Этот патч сводит QC в 05:
--   1) EquipmentOperation: (otk-2, QC) → (otk-2, 05). После — 05 на
--      двух станках (otk + otk-2).
--   2) PassportEvent.operationId, PassportEvent.fromOperationId,
--      ShiftSession.operationId, Passport.currentOperationId → 05.
--      Включая открытую смену — переключение прозрачное (UI не
--      сломается, фронт продолжит работать).
--   3) DELETE Operation QC.
--   4) AuditLog OPERATION_MERGED.
--
-- Pre-check: QC не должна быть в OrderRouteStep / RouteTemplateStep
-- (мерж бы сломал маршруты). Открытые смены допускаются — они
-- переключаются с уведомлением.
--
-- Уже применено на проде 2026-05-29 ~14:20 UTC.

BEGIN;

DO $$
DECLARE bad_routes int; bad_tpls int; bad_open_shifts int;
BEGIN
  SELECT count(*) INTO bad_routes FROM "OrderRouteStep" WHERE "operationId" = 'cmosgtt1q000bf3icjeakbafs';
  SELECT count(*) INTO bad_tpls   FROM "RouteTemplateStep" WHERE "operationId" = 'cmosgtt1q000bf3icjeakbafs';
  SELECT count(*) INTO bad_open_shifts FROM "ShiftSession" WHERE "operationId" = 'cmosgtt1q000bf3icjeakbafs' AND "endedAt" IS NULL;
  IF bad_routes > 0 OR bad_tpls > 0 THEN
    RAISE EXCEPTION 'Pre-check failed: QC merge has routes=% tpls=%', bad_routes, bad_tpls;
  END IF;
  IF bad_open_shifts > 0 THEN
    RAISE NOTICE 'Open shifts on QC будут переключены на 05 (% sessions)', bad_open_shifts;
  END IF;
END$$;

UPDATE "EquipmentOperation"
SET "operationId" = 'cmorgjz8p0001vo5izylz9nbk', "updatedAt" = now()
WHERE "operationId" = 'cmosgtt1q000bf3icjeakbafs';

UPDATE "PassportEvent"
SET "operationId" = 'cmorgjz8p0001vo5izylz9nbk'
WHERE "operationId" = 'cmosgtt1q000bf3icjeakbafs';

UPDATE "PassportEvent"
SET "fromOperationId" = 'cmorgjz8p0001vo5izylz9nbk'
WHERE "fromOperationId" = 'cmosgtt1q000bf3icjeakbafs';

UPDATE "ShiftSession"
SET "operationId" = 'cmorgjz8p0001vo5izylz9nbk'
WHERE "operationId" = 'cmosgtt1q000bf3icjeakbafs';

UPDATE "Passport"
SET "currentOperationId" = 'cmorgjz8p0001vo5izylz9nbk'
WHERE "currentOperationId" = 'cmosgtt1q000bf3icjeakbafs';

DELETE FROM "Operation" WHERE id = 'cmosgtt1q000bf3icjeakbafs';

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", "employeeId", payload, "createdAt")
VALUES (
  'al_' || substring(md5(random()::text || 'qc-merge') for 24),
  'OPERATION_MERGED','OPERATION','cmorgjz8p0001vo5izylz9nbk','cmoraoxno0007tjnvx91aasrt',
  jsonb_build_object(
    'reason','dedupe-otk-multi-machine',
    'comment','Свели две Operation «ОТК» (codes 05 и QC) в одну (code=05, та что в маршрутах). EquipmentOperation сохранён: 05 теперь на двух станках (otk + otk-2). 107 PassportEvent + 76 fromOp + 4 ShiftSession + 12 Passport.currentOperationId переключены на 05.',
    'merged', jsonb_build_array(jsonb_build_object('id','cmosgtt1q000bf3icjeakbafs','code','QC')),
    'into',   jsonb_build_object('id','cmorgjz8p0001vo5izylz9nbk','code','05')
  ),
  now()
);

COMMIT;
