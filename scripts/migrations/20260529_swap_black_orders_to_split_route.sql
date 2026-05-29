-- 2026-05-29: переключение 8 чёрных заказов IN_PRODUCTION на сплит-маршрут.
--
-- Контекст. До этой правки все 8 чёрных заказов «Футболка Классика 3
-- Киперная Лента» использовали шаблон 01 (cmorhvkpo0001nwz8axbjf00m):
--   2 ОВР → 3 КИПЕРКА(g1) → 4 РАСПОШИВ(g1) → 5 ОТК → 6 ВТО → 7 УПАКОВКА
-- Чёрные футболки физически делятся на «распошив рукава» + «подгиб низа»,
-- а шаблон требовал generic РАСПОШИВ (см. 20260529_unblock_5_passports*).
-- Создан новый шаблон 02 (cmpr1vfzm0162s3o6r3cng7ao) под чёрные:
--   2 ОВР → 3 КИПЕРКА(g1) → 4 Подгиб низа(g1) → 5 Распошив рукав(g1)
--   → 6 ОТК → 7 ВТО → 8 УПАКОВКА.
-- Все три «параллельные» (КИПЕРКА + Подгиб + Рукав) в одной parallelGroup=1
-- — AND-гейт перед ОТК ждёт все три.
--
-- Этот патч:
--   1) UPDATE Order.routeTemplateId для 8 заказов: 01 → 02.
--   2) DELETE OrderRouteStep этих заказов (64 строки), INSERT новый snapshot
--      из RouteTemplateStep шаблона 02 (72 строки = 9 × 8).
--   3) Remap currentRouteStepIndex на не-PACKED паспортах:
--        (3, Подгиб низа) → 4   (Подгиб в новом idx=4)
--        (3, ОТК)         → 6   (застрявшие после QC; ОТК в новом idx=6)
--        (6, ВТО)         → 7   (включая 5 разблокированных накануне)
--      Остальные позиции совпадают по индексу (КРОЙ/Деление/ОВР/КИПЕРКА).
--   4) PACKED НЕ трогаем — индекс у них уже исторический.
--   5) AuditLog ORDER_ROUTE_REPLACED по каждому заказу.
--
-- Pre-check: все 8 заказов должны быть на шаблоне 01 и IN_PRODUCTION.
--
-- Уже применено на проде 2026-05-29 ~09:12 UTC.

BEGIN;

CREATE TEMP TABLE _orders (number text, id text);
INSERT INTO _orders (number, id)
SELECT number, id FROM "Order"
WHERE number IN (
  'O-20260504-0001','O-20260506-0001','O-20260506-0003','O-20260507-0001',
  'O-20260510-0001','O-20260519-0002','O-20260521-0002','O-20260528-0001'
);

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM "Order" o JOIN _orders s ON s.id = o.id
  WHERE o."routeTemplateId" IS DISTINCT FROM 'cmorhvkpo0001nwz8axbjf00m'
     OR o.status <> 'IN_PRODUCTION';
  IF bad > 0 THEN
    RAISE EXCEPTION 'Pre-check failed: % orders not on template 01 or not IN_PRODUCTION', bad;
  END IF;
END$$;

UPDATE "Order"
SET "routeTemplateId" = 'cmpr1vfzm0162s3o6r3cng7ao'
WHERE id IN (SELECT id FROM _orders);

DELETE FROM "OrderRouteStep"
WHERE "orderId" IN (SELECT id FROM _orders);

INSERT INTO "OrderRouteStep" (id, "orderId", index, "operationId", "parallelGroup")
SELECT
  'ors_' || substring(md5(random()::text || o.id || rts.index::text) for 24),
  o.id, rts.index, rts."operationId", rts."parallelGroup"
FROM _orders o
CROSS JOIN "RouteTemplateStep" rts
WHERE rts."templateId" = 'cmpr1vfzm0162s3o6r3cng7ao';

UPDATE "Passport" p
SET "currentRouteStepIndex" = 4
FROM _orders o
JOIN "Operation" co ON co.name = 'Подгиб низа'
WHERE p."orderId" = o.id
  AND p.status <> 'PACKED'
  AND p."currentRouteStepIndex" = 3
  AND p."currentOperationId" = co.id;

UPDATE "Passport" p
SET "currentRouteStepIndex" = 6
FROM _orders o
WHERE p."orderId" = o.id
  AND p.status <> 'PACKED'
  AND p."currentRouteStepIndex" = 3
  AND p."currentOperationId" IN (SELECT id FROM "Operation" WHERE category = 'QC');

UPDATE "Passport" p
SET "currentRouteStepIndex" = 7
FROM _orders o
WHERE p."orderId" = o.id
  AND p.status <> 'PACKED'
  AND p."currentRouteStepIndex" = 6
  AND p."currentOperationId" IN (SELECT id FROM "Operation" WHERE category = 'IRONING');

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", "employeeId", payload, "createdAt")
SELECT
  'al_' || substring(md5(random()::text || o.id) for 24),
  'ORDER_ROUTE_REPLACED',
  'ORDER',
  o.id,
  'cmoraoxno0007tjnvx91aasrt',
  jsonb_build_object(
    'reason','BLACK_ORDERS_SPLIT_DISTANCE',
    'comment','Чёрные футболки переведены на сплит-маршрут (КИПЕРКА ⇄ Подгиб низа ⇄ Распошив рукав параллельно). PACKED не трогали; не-PACKED перепривязаны на новые индексы.',
    'before', jsonb_build_object('routeTemplateId','cmorhvkpo0001nwz8axbjf00m','routeTemplateCode','01'),
    'after',  jsonb_build_object('routeTemplateId','cmpr1vfzm0162s3o6r3cng7ao','routeTemplateCode','02')
  ),
  now()
FROM _orders o;

COMMIT;
