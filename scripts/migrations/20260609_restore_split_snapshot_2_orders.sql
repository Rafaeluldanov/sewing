-- 2026-06-09: возврат 2 свёрнутых заказов к каноническому сплит-снимку.
--
-- Контекст. Старый необратимый хук `maybeCollapseSplitRoute` (коммит b4693b7)
-- переписывал снапшот маршрута заказа из пары {Подгиб низа 0001, Распошив
-- рукав 16} в один «Распошив» (04), когда весь низ «переезжал» на рукавный
-- станок. От этого отказались в пользу адаптивного режима, вычисляемого на
-- лету (Вариант B, см. apps/api/src/modules/passports/route-mode.ts): снимок
-- всегда остаётся сплитом, а «сплит vs схлоп» — производная от обстановки.
--
-- На момент перехода два заказа уже были СВЁРНУТЫ в БД:
--   O-20260528-0001, O-20260530-0001 — снапшот: …3 КИПЕРКА(g1) → 4 РАСПОШИВ(04,g1)
--   → 6 ОТК… (без шага idx5). Их надо вернуть к канону шаблона 02
--   (cmpr1vfzm0162s3o6r3cng7ao): …3 КИПЕРКА(g1) → 4 Подгиб низа(g1)
--   → 5 Распошив рукав(g1) → 6 ОТК…
--
-- Этот патч:
--   1) DELETE OrderRouteStep этих 2 заказов, INSERT канонический snapshot
--      из RouteTemplateStep шаблона 02 (восстанавливает 0001@4, 16@5).
--   2) Remap не-PACKED паспортов, стоявших на свёрнутом распошиве
--      (currentRouteStepIndex = 4): → 5 (рукав = принимающая операция,
--      максимальный индекс merge-группы, согласовано с substitution-aware
--      индексацией в evaluateRouteOrder). currentOperationId НЕ меняем:
--      паспорт «делал 04» — 04 засчитывает и низ, и рукав через
--      OperationSubstitution; в мониторе он корректно отрисуется (COLLAPSED —
--      слитой колонкой 04; SPLIT — ✔ на колонке рукава по индексу).
--      O-20260528-0001 паспортов на idx4 не имеет — для него это no-op.
--   3) AuditLog ROUTE_SPLIT_SNAPSHOT_RESTORED по каждому заказу.
--   4) PACKED не трогаем — индекс у них исторический.
--
-- Pre-check: оба заказа на шаблоне 02, IN_PRODUCTION, и их снапшот СЕЙЧАС
-- содержит шаг операции '04' внутри parallelGroup (признак свёрнутого сплита).
--
-- ВНИМАНИЕ ПО ПОРЯДКУ ПРИМЕНЕНИЯ: запускать ТОЛЬКО ПОСЛЕ деплоя кода,
-- удалившего `maybeCollapseSplitRoute`. Иначе старый код при следующем
-- complete снова свернёт эти заказы.
--
-- НЕ применено на проде (ждёт деплоя нового кода и решения пользователя).

BEGIN;

CREATE TEMP TABLE _orders (number text, id text);
INSERT INTO _orders (number, id)
SELECT number, id FROM "Order"
WHERE number IN ('O-20260528-0001', 'O-20260530-0001');

DO $$
DECLARE bad int;
BEGIN
  -- Оба заказа существуют, на шаблоне 02 и IN_PRODUCTION.
  SELECT count(*) INTO bad
  FROM "Order" o JOIN _orders s ON s.id = o.id
  WHERE o."routeTemplateId" IS DISTINCT FROM 'cmpr1vfzm0162s3o6r3cng7ao'
     OR o.status <> 'IN_PRODUCTION';
  IF (SELECT count(*) FROM _orders) <> 2 OR bad > 0 THEN
    RAISE EXCEPTION 'Pre-check failed: ожидались 2 заказа на шаблоне 02 IN_PRODUCTION (bad=%)', bad;
  END IF;

  -- Снапшот действительно свёрнут: есть шаг '04' в параллельной группе.
  SELECT count(*) INTO bad
  FROM _orders s
  WHERE NOT EXISTS (
    SELECT 1 FROM "OrderRouteStep" ors
    JOIN "Operation" op ON op.id = ors."operationId"
    WHERE ors."orderId" = s.id AND op.code = '04' AND ors."parallelGroup" IS NOT NULL
  );
  IF bad > 0 THEN
    RAISE EXCEPTION 'Pre-check failed: % заказ(ов) не имеют свёрнутого распошива (04 в parallelGroup)', bad;
  END IF;
END$$;

-- 1) Пересобираем snapshot из канонического шаблона 02 (сплит).
DELETE FROM "OrderRouteStep"
WHERE "orderId" IN (SELECT id FROM _orders);

INSERT INTO "OrderRouteStep" (id, "orderId", index, "operationId", "parallelGroup")
SELECT
  'ors_' || substring(md5(random()::text || o.id || rts.index::text) for 24),
  o.id, rts.index, rts."operationId", rts."parallelGroup"
FROM _orders o
CROSS JOIN "RouteTemplateStep" rts
WHERE rts."templateId" = 'cmpr1vfzm0162s3o6r3cng7ao';

-- 2) Remap паспортов со свёрнутого распошива (idx4) на рукав (idx5).
UPDATE "Passport" p
SET "currentRouteStepIndex" = 5
FROM _orders o
WHERE p."orderId" = o.id
  AND p.status <> 'PACKED'
  AND p."currentRouteStepIndex" = 4;

-- 3) Аудит.
INSERT INTO "AuditLog" (id, event, "entityType", "entityId", "employeeId", payload, "createdAt")
SELECT
  'al_' || substring(md5(random()::text || o.id) for 24),
  'ROUTE_SPLIT_SNAPSHOT_RESTORED',
  'ORDER',
  o.id,
  (SELECT id FROM "Employee" WHERE role = 'ADMIN' AND active ORDER BY "createdAt" LIMIT 1),
  jsonb_build_object(
    'reason','ADAPTIVE_SPLIT_ROUTE_MODE',
    'comment','Снимок маршрута возвращён к каноническому сплиту (Подгиб низа + Распошив рукав в parallelGroup). Необратимое сворачивание удалено; режим теперь вычисляется на лету (route-mode.ts). Паспорта с idx4 (свёрнутый 04) перемещены на idx5 (рукав).'
  ),
  now()
FROM _orders o;

COMMIT;
