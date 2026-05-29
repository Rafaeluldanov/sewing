-- Backfill `PassportEvent.operationId` для исторических PACKED-событий.
--
-- Контекст. До этой миграции `PackingService.addPassport` создавал
-- `PACKED`-событие БЕЗ `operationId` (см. предыдущее тело метода до
-- правки в коммите, где добавляется `packingOperationId`). Это вело к
-- асимметрии в «Доске движения тиража» (`/master`): колонка УПАКОВКА
-- всегда показывала «—», потому что её счётчик «выпущено» опирается
-- строго на `OPERATION_FINISHED.operationId` (теперь ещё и
-- `QC_PASSED` / `WTO_PASSED` / `PACKED` — см.
-- `apps/api/src/modules/production-board/production-board.service.ts`).
--
-- Этот скрипт проставляет `operationId` существующим PACKED-событиям,
-- беря его из шага маршрута заказа этого паспорта, у которого
-- `Operation.category = 'PACKING'`. У всех живых заказов в маршруте
-- ровно один такой шаг (см. шаблоны маршрутов и проверки
-- `OrdersService`). Если у заказа нет PACKING-шага (унаследованные
-- данные без сборки маршрута) — событие остаётся `operationId = null`.
--
-- Идемпотентно: фильтр `operationId IS NULL` гарантирует, что повторный
-- прогон выберет 0 строк.

UPDATE "PassportEvent" pe
SET "operationId" = ors."operationId"
FROM "Passport" p
JOIN "OrderRouteStep" ors ON ors."orderId" = p."orderId"
JOIN "Operation" o ON o.id = ors."operationId"
WHERE pe."passportId" = p.id
  AND pe.type = 'PACKED'
  AND pe."operationId" IS NULL
  AND o.category = 'PACKING';
