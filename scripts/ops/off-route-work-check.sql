-- Детектор «работа мимо маршрута заказа».
--
-- Зачем. Швея выбирает операцию из списка своего СТАНКА — маршрут заказа в этом
-- выборе не участвует. Если операции нет в снимке маршрута заказа, гейт
-- `evaluateRouteOrder` (apps/api/src/modules/passports/passports.service.ts)
-- возвращает пустой результат и НЕ enforce'ит ничего: работа принимается молча,
-- сделка начисляется, партия шьётся до конца — и упирается только в AND-гейт
-- перед ОТК, недели спустя, сразу десятками паспортов.
-- Инцидент 28.07.2026: лаг обнаружения 27 дней, 70 паспортов в 8 заказах.
--
-- Этот запрос ловит то же самое НА СЛЕДУЮЩЕЕ УТРО. Проверен на истории прода:
-- запущенный 02.07.2026 в 08:00 он показал бы окантовку в первый же день
-- (21 паспорт в 3 заказах) и аварию O-20260615-0004 с 29.06.
--
-- Гонять раз в день, пока не появится вкладка «Расхождения» у мастера.
--   docker exec sewing-prod-db-1 psql -U user -d myapp -f - < scripts/ops/off-route-work-check.sql
--
-- ПУСТОЙ ВЫВОД = всё в порядке. Любая строка = разбор в тот же день:
-- либо цех перешёл на другую технологию (тогда технолог правит маршрут заказа
-- или заводит правило замены), либо работают не то (тогда работу останавливаем).
--
-- Три сознательных сужения, чтобы не было шума:
--   1. Только `SEWING`. Крой, ОТК, ВТО и упаковка в снимке маршрута отсутствуют
--      штатно и закрываются на собственных гейтах — без этого фильтра запрос
--      выдаёт сотни строк по «Делению кроя» и читать его никто не станет.
--   2. Исключаются легальные замены (`OperationSubstitution`): закрытие
--      заместителя засчитывает замещаемую операцию, это не нарушение.
--   3. Окно 30 дней. У `OrderRouteStep` нет ни `createdAt`, ни `updatedAt`
--      (prisma/schema.prisma), поэтому отличить «работали мимо маршрута» от
--      «маршрут переписали после работы» нельзя — скользящее окно ограничивает
--      исторический хвост.
--   4. Только живые заказы. По `DONE`/`CANCELLED` разбирать нечего, а висеть в
--      сводке они будут все 30 дней окна и приучат к тому, что «там всегда что-то
--      горит» — ровно тот механизм привыкания, из-за которого не сработало
--      жёлтое предупреждение швее.
--
-- ВНИМАНИЕ, мультитенантность: скрипт видит ровно ОДНУ базу. При нескольких
-- тенантах его нужно гонять по каждой базе отдельно (см. control_plane).

\pset border 2
\echo '=== Работа мимо маршрута заказа за последние 30 дней ==='

WITH offroute AS (
  SELECT e."createdAt",
         o.number      AS order_number,
         op.code       AS op_code,
         op.name       AS op_name,
         e."passportId",
         emp."fullName" AS employee
  FROM "PassportEvent" e
  JOIN "Passport"  p   ON p.id = e."passportId"
  JOIN "Order"     o   ON o.id = p."orderId"
  JOIN "Operation" op  ON op.id = e."operationId"
  LEFT JOIN "Employee" emp ON emp.id = e."employeeId"
  WHERE e.type IN ('ISSUED_TO_EMPLOYEE', 'OPERATION_FINISHED')  -- выдача ловит раньше завершения
    AND e."createdAt" >= now() - interval '30 days'
    AND op.category = 'SEWING'
    AND o.status NOT IN ('DONE', 'CANCELLED')
    AND EXISTS (SELECT 1 FROM "OrderRouteStep" s WHERE s."orderId" = p."orderId")
    AND NOT EXISTS (
      SELECT 1 FROM "OrderRouteStep" s
      WHERE s."orderId" = p."orderId" AND s."operationId" = e."operationId")
    AND NOT EXISTS (
      SELECT 1 FROM "OperationSubstitution" sub
      JOIN "OrderRouteStep" s2
        ON s2."orderId" = p."orderId" AND s2."operationId" = sub."satisfiesOpId"
      WHERE sub."substituteOpId" = e."operationId")
)
SELECT order_number                        AS "Заказ",
       op_code || ' ' || op_name           AS "Закрывают операцию",
       count(DISTINCT "passportId")        AS "Паспортов",
       min("createdAt")::date              AS "С какого дня",
       max("createdAt")::date              AS "Последний раз",
       string_agg(DISTINCT employee, ', ') AS "Кто"
FROM offroute
GROUP BY 1, 2
ORDER BY 4, 1;
