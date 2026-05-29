-- 2026-05-29: мерж трёх Operation «Распошив рукав» (16/17/40) в одну (16).
--
-- Контекст. В справочнике Operation по ошибке заведены три «Распошив рукав»:
--   16 (cmppcv3sz01vra82gmurd3fe3, ставка 10) → станок rasposhiv
--   17 (cmppcwval01wra82gtrbuw9ui, ставка 10) → станок rasposhiv-2
--   40 (cmppb9pjl01j1a82glk7djn4n, ставка 10) → станок rasposhiv-3
-- Это анти-паттерн: для аналогичной КИПЕРКА (03) сделана одна Operation,
-- привязанная к трём ПРЯМОСТРОЧКА-станкам через EquipmentOperation (many-to-many).
-- Из-за дубля менеджер видел три «Распошив рукав» в редакторе маршрута,
-- маршрутный гейт сравнивал operationId строго — и одна и та же по смыслу
-- работа на разных станках не считалась одной операцией.
--
-- Этот патч сводит 17/40 в 16:
--   1) EquipmentOperation: переключаем rasposhiv-2 и rasposhiv-3 на op=16.
--   2) Исторические ссылки PassportEvent (operationId / fromOperationId),
--      ShiftSession (только закрытые на момент применения) → op=16.
--   3) DELETE Operation 17 и 40.
-- AuditLog OPERATION_MERGED для истории.
--
-- Pre-check защитил от мержа, если бы на 17/40 что-то живое ссылалось:
-- OrderRouteStep, RouteTemplateStep, открытые ShiftSession,
-- Passport.currentOperationId. На момент применения таких ссылок не было.
--
-- Уже применено на проде 2026-05-29 ~06:10 UTC.

BEGIN;

DO $$
DECLARE
  bad_routes int;
  bad_tpls   int;
  bad_open_shifts int;
  bad_current int;
BEGIN
  SELECT count(*) INTO bad_routes FROM "OrderRouteStep" WHERE "operationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');
  SELECT count(*) INTO bad_tpls   FROM "RouteTemplateStep" WHERE "operationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');
  SELECT count(*) INTO bad_open_shifts FROM "ShiftSession" WHERE "operationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n') AND "endedAt" IS NULL;
  SELECT count(*) INTO bad_current FROM "Passport" WHERE "currentOperationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');
  IF bad_routes > 0 OR bad_tpls > 0 OR bad_open_shifts > 0 OR bad_current > 0 THEN
    RAISE EXCEPTION 'Pre-check failed: routes=% tpls=% openShifts=% currentOp=%', bad_routes, bad_tpls, bad_open_shifts, bad_current;
  END IF;
END$$;

UPDATE "EquipmentOperation"
SET "operationId" = 'cmppcv3sz01vra82gmurd3fe3', "updatedAt" = now()
WHERE "operationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');

UPDATE "PassportEvent"
SET "operationId" = 'cmppcv3sz01vra82gmurd3fe3'
WHERE "operationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');

UPDATE "PassportEvent"
SET "fromOperationId" = 'cmppcv3sz01vra82gmurd3fe3'
WHERE "fromOperationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');

UPDATE "ShiftSession"
SET "operationId" = 'cmppcv3sz01vra82gmurd3fe3'
WHERE "operationId" IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');

DELETE FROM "Operation" WHERE id IN ('cmppcwval01wra82gtrbuw9ui','cmppb9pjl01j1a82glk7djn4n');

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", "employeeId", payload, "createdAt")
VALUES (
  'al_' || substring(md5(random()::text || now()::text) for 24),
  'OPERATION_MERGED',
  'OPERATION',
  'cmppcv3sz01vra82gmurd3fe3',
  'cmoraoxno0007tjnvx91aasrt',
  jsonb_build_object(
    'reason','dedupe-rasposhiv-rukav-multi-machine',
    'comment','Свели три Operation «Распошив рукав» (codes 16/17/40) в одну (code=16). Привязки к станкам сохранены через EquipmentOperation.',
    'merged', jsonb_build_array(
      jsonb_build_object('id','cmppcwval01wra82gtrbuw9ui','code','17'),
      jsonb_build_object('id','cmppb9pjl01j1a82glk7djn4n','code','40')
    ),
    'into', jsonb_build_object('id','cmppcv3sz01vra82gmurd3fe3','code','16','fixedRate',10.00)
  ),
  now()
);

COMMIT;
