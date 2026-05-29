-- 2026-05-29: разблокировка 5 паспортов O-20260504-0001, застрявших между ОТК и ВТО.
--
-- Контекст. Маршрут заказа (шаблон 01) содержал шаг РАСПОШИВ (op id=04,
-- generic, ставка 20). Швеи же реально закрывали «Распошив рукав»
-- (op id=16, machine-specific, ставка 10) — потому что их станки rasposhiv-N
-- привязаны к отдельным операциям 16/17/40. AND-гейт параллельной группы
-- {КИПЕРКА(03), РАСПОШИВ(04)} ждал OPERATION_FINISHED именно на 04,
-- а на нём ничего не было. ОТК пускал (QcService.markPassed гейт не дёргает),
-- но ВТО блокировал по PASSPORT_PARALLEL_GROUP_INCOMPLETE.
--
-- Затронутые: P-20260506-0044, -0046, -0058, -0072, -0076 (21 шт каждый,
-- все из O-20260504-0001 «Футболка Классика 3 Киперная Лента»).
--
-- Этот патч:
--   1) пишет фейк OPERATION_FINISHED на РАСПОШИВ(04) от мастера Урмановой,
--      payload.backfill='parallel-group-gate-unblock' — снимает AND-гейт;
--   2) forward route: currentRouteStepIndex=6 (ВТО старого 01), currentOp=ВТО,
--      currentEmployeeId=NULL (снимает «зависание» у Астры);
--   3) AuditLog MASTER_PASSPORT_ROUTE_STEP_SET с before/after.
--
-- Уже было применено на проде 2026-05-29 ~05:11 UTC.
-- Файл — для истории / репродукции, при необходимости повторять только в
-- идентичной БД-ситуации.

BEGIN;

CREATE TEMP TABLE _stuck AS
SELECT id, "qtyGood", "currentEmployeeId" AS prev_emp,
       "currentOperationId" AS prev_op, "currentRouteStepIndex" AS prev_step,
       status::text AS prev_status, number
FROM "Passport"
WHERE number IN ('P-20260506-0072','P-20260506-0046','P-20260506-0076','P-20260506-0058','P-20260506-0044');

INSERT INTO "PassportEvent" (id, "passportId", type, "operationId", "employeeId", qty, payload, "createdAt")
SELECT
  'pe_' || substring(md5(random()::text || s.id) for 24),
  s.id,
  'OPERATION_FINISHED',
  'cmorgh5oh000310sv7nyr7fve',  -- РАСПОШИВ (04)
  'cmoraoxno0007tjnvx91aasrt',  -- Урманова Гульзафира (SHOPFLOOR_MASTER)
  s."qtyGood",
  jsonb_build_object(
    'backfill','parallel-group-gate-unblock',
    'reason','seamstresses scanned Распошив рукав (op=cmppcv3sz01vra82gmurd3fe3) instead of РАСПОШИВ in route (op=cmorgh5oh000310sv7nyr7fve)',
    'by','master:Urmanova'
  ),
  now()
FROM _stuck s;

UPDATE "Passport"
SET "currentOperationId" = 'cmorglx310005vo5i6z7pnuyc',  -- ВТО
    "currentRouteStepIndex" = 6,
    "currentEmployeeId" = NULL,
    "currentCellId" = NULL,
    status = 'IN_PROGRESS'
WHERE id IN (SELECT id FROM _stuck);

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", "employeeId", payload, "createdAt")
SELECT
  'al_' || substring(md5(random()::text || s.id) for 24),
  'MASTER_PASSPORT_ROUTE_STEP_SET',
  'PASSPORT',
  s.id,
  'cmoraoxno0007tjnvx91aasrt',
  jsonb_build_object(
    'reason','MANUAL_UNBLOCK_PARALLEL_GROUP',
    'comment','ВТО не пускал по AND-гейту: швеи закрывали Распошив рукав (op=cmppcv3sz01vra82gmurd3fe3) вместо РАСПОШИВ маршрута (op=cmorgh5oh000310sv7nyr7fve). Бэкфилл OPERATION_FINISHED + forward на ВТО.',
    'before', jsonb_build_object(
      'status', s.prev_status,
      'currentCellId', NULL,
      'currentEmployeeId', s.prev_emp,
      'currentOperationId', s.prev_op,
      'currentRouteStepIndex', s.prev_step
    ),
    'after', jsonb_build_object(
      'status','IN_PROGRESS',
      'currentCellId', NULL,
      'currentEmployeeId', NULL,
      'currentOperationId','cmorglx310005vo5i6z7pnuyc',
      'currentRouteStepIndex', 6
    ),
    'direction','FORWARD',
    'operationId','cmorglx310005vo5i6z7pnuyc',
    'routeStepIndex', 6,
    'manualBackfill', jsonb_build_array(jsonb_build_object(
      'event','OPERATION_FINISHED',
      'operationId','cmorgh5oh000310sv7nyr7fve',
      'reason','satisfy parallel-group AND-gate'
    ))
  ),
  now()
FROM _stuck s;

COMMIT;
