-- План операций на заказе (Этап 2 из `docs/operation-time-norms-recon.md`).
--
-- Что добавляем (additive):
--   1. `Order.operationCostPlanRub Decimal(14,2)` — суммарная плановая
--      стоимость операций по заказу (snapshot, не live look-up).
--   2. `Order.operationTimePlanSec Int` — суммарное плановое время
--      выполнения заказа в секундах.
--   3. `Order.operationPlanCalculatedAt TIMESTAMP(3)` — когда план был
--      посчитан в последний раз.
--   4. `Order.operationPlanWarnings JSONB` — массив строковых warnings
--      («нет ставки операции X для размера Y», «нет нормы времени
--      операции X для размера Y», «маршрут не выбран» и т.п.). UI
--      рисует «План операций неполный» с этим списком.
--
-- Все четыре колонки nullable:
--   - старые заказы остаются валидными (snapshot не считался — null);
--   - заказ без `routeTemplateId` или без items валиден — мы пишем
--     null + warning в `operationPlanWarnings`;
--   - после `start()` snapshot замораживается и больше не пересчитывается.
--
-- Что НЕ трогаем (см. recon §15):
--   - `OperationEntry` / `SalaryEntry` / `Passport` — payroll и факт
--     не затрагиваются;
--   - `OperationRateBySize` / `OperationTimeNormBySize` — это
--     read-source плана, в этой миграции их структуру не меняем;
--   - `WorkshopNeed` / `OrderCostEstimate` / `OrderCostEstimateLine` —
--     LABOR-строка в себестоимости появится только на этапе 3;
--   - `PurchaseOrder` / `PurchaseReceipt` / `OrderApplication` /
--     `PatternItem` / `TechCardTemplate` — никак не задействованы.
--
-- Backfill-стратегия: ничего не делаем. Все четыре колонки остаются
-- `NULL` до первого вызова `OrderOperationPlanService.recalculateAndWrite`
-- (на `OrdersService.create` / `update` / `startCalculation`). Старые
-- заказы получают snapshot только при следующем PATCH в DRAFT либо
-- при `startCalculation`. Если заказ уже не в DRAFT — поля остаются
-- `NULL`, и UI рисует «План операций не рассчитан».

ALTER TABLE "Order"
    ADD COLUMN "operationCostPlanRub"      DECIMAL(14, 2),
    ADD COLUMN "operationTimePlanSec"      INTEGER,
    ADD COLUMN "operationPlanCalculatedAt" TIMESTAMP(3),
    ADD COLUMN "operationPlanWarnings"     JSONB;
