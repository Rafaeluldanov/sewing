-- 2026-05-29 (поздний прогон): разблокировка ещё 6 паспортов того же класса,
-- но другого подтипа.
--
-- Контекст. После замены маршрута чёрных заказов на сплит-шаблон 02
-- (20260529_swap_black_orders_to_split_route.sql) часть паспортов уже на
-- новом маршруте дошла до КИПЕРКА → Распошив-этапа, но швеи закрыли
-- generic РАСПОШИВ (04, ставка 20) вместо сплита Подгиб(0001) + Рукав(16).
-- issueToEmployee на operationId, не входящем в маршрут (04 теперь не в
-- route 02), evaluateRouteOrder возвращает `none` (targetStep undefined) и
-- не enforce'ит — система пропустила. ОТК тоже пропустил (QcService не
-- дёргает AND-гейт). ВТО блокирует AND-гейтом параллельной группы {03, 0001, 16}.
--
-- Затронутые 6 паспортов:
--   O-20260504-0001: P-20260506-0194/-0198/-0205/-0206/-0221 (Эсенгелдиева Динара)
--   O-20260521-0002: P-20260523-0019                          (Кисембаева Перизат)
--
-- Этот патч:
--   1) Для каждого паспорта дозаписать OPERATION_FINISHED на Подгиб низа (0001)
--      и Распошив рукав (16) от ТОГО ЖЕ финишёра, что закрыл РАСПОШИВ (04) —
--      физически он сделал и низ, и рукав в одной операции.
--      Прямой SQL → OperationEntry не триггерится, сдельная швеи не меняется
--      (она уже получила свои 20 за РАСПОШИВ — это полная плата за полную работу).
--   2) currentRouteStepIndex = 6 (ОТК на новом маршруте), currentEmployeeId=NULL.
--   3) AuditLog MASTER_PASSPORT_ROUTE_STEP_SET с before/after.
--
-- Уже применено на проде 2026-05-30 ~06:50 UTC.

BEGIN;

CREATE TEMP TABLE _stuck AS
SELECT p.id, p.number, p."qtyGood",
       p."currentEmployeeId" AS prev_emp,
       p."currentOperationId" AS prev_op,
       p."currentRouteStepIndex" AS prev_step,
       p.status::text AS prev_status,
       (SELECT e."employeeId" FROM "PassportEvent" e
        WHERE e."passportId"=p.id AND e.type='OPERATION_FINISHED'
          AND e."operationId"='cmorgh5oh000310sv7nyr7fve'  -- РАСПОШИВ (04)
        ORDER BY e."createdAt" DESC LIMIT 1) AS rasposhiv_finisher
FROM "Passport" p
WHERE p.number IN ('P-20260506-0194','P-20260506-0198','P-20260506-0205','P-20260506-0206','P-20260506-0221','P-20260523-0019');

INSERT INTO "PassportEvent" (id, "passportId", type, "operationId", "employeeId", qty, payload, "createdAt")
SELECT
  'pe_' || substring(md5(random()::text || s.id || 'podgib') for 24),
  s.id,
  'OPERATION_FINISHED',
  'cmpp74prl00pka82gw3fxq3wb',  -- Подгиб низа (0001)
  s.rasposhiv_finisher,
  s."qtyGood",
  jsonb_build_object(
    'backfill','split-equivalent-of-rasposhiv',
    'reason','seamstress closed generic РАСПОШИВ (04) which includes both Подгиб низа + Распошив рукав; route 02 requires the split; backfilled to satisfy parallel-group AND-gate without affecting payroll',
    'sourceRasposhivEvent','OPERATION_FINISHED on op=cmorgh5oh000310sv7nyr7fve',
    'by','master:Urmanova'
  ),
  now()
FROM _stuck s;

INSERT INTO "PassportEvent" (id, "passportId", type, "operationId", "employeeId", qty, payload, "createdAt")
SELECT
  'pe_' || substring(md5(random()::text || s.id || 'rukav') for 24),
  s.id,
  'OPERATION_FINISHED',
  'cmppcv3sz01vra82gmurd3fe3',  -- Распошив рукав (16, post-merge canonical)
  s.rasposhiv_finisher,
  s."qtyGood",
  jsonb_build_object(
    'backfill','split-equivalent-of-rasposhiv',
    'reason','seamstress closed generic РАСПОШИВ (04) which includes both Подгиб низа + Распошив рукав; route 02 requires the split; backfilled to satisfy parallel-group AND-gate without affecting payroll',
    'sourceRasposhivEvent','OPERATION_FINISHED on op=cmorgh5oh000310sv7nyr7fve',
    'by','master:Urmanova'
  ),
  now()
FROM _stuck s;

UPDATE "Passport" p
SET "currentRouteStepIndex" = 6,
    "currentEmployeeId" = NULL
WHERE p.id IN (SELECT id FROM _stuck);

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", "employeeId", payload, "createdAt")
SELECT
  'al_' || substring(md5(random()::text || s.id) for 24),
  'MASTER_PASSPORT_ROUTE_STEP_SET',
  'PASSPORT',
  s.id,
  'cmoraoxno0007tjnvx91aasrt',
  jsonb_build_object(
    'reason','MANUAL_UNBLOCK_PARALLEL_GROUP_SPLIT_BACKFILL',
    'comment','Швея закрыла generic РАСПОШИВ (04) вместо сплита Подгиб+Рукав маршрута 02. Дозаписаны OPERATION_FINISHED на 0001 и 16 от того же финишёра (не триггерит OperationEntry → ставка не изменилась). currentRouteStepIndex переведён на ОТК (idx=6).',
    'before', jsonb_build_object(
      'status', s.prev_status,
      'currentEmployeeId', s.prev_emp,
      'currentOperationId', s.prev_op,
      'currentRouteStepIndex', s.prev_step
    ),
    'after', jsonb_build_object(
      'status','IN_PROGRESS',
      'currentEmployeeId', NULL,
      'currentOperationId', s.prev_op,
      'currentRouteStepIndex', 6
    ),
    'direction','FORWARD',
    'manualBackfill', jsonb_build_array(
      jsonb_build_object('event','OPERATION_FINISHED','operationId','cmpp74prl00pka82gw3fxq3wb','operationName','Подгиб низа','employeeId', s.rasposhiv_finisher),
      jsonb_build_object('event','OPERATION_FINISHED','operationId','cmppcv3sz01vra82gmurd3fe3','operationName','Распошив рукав','employeeId', s.rasposhiv_finisher)
    )
  ),
  now()
FROM _stuck s;

COMMIT;
