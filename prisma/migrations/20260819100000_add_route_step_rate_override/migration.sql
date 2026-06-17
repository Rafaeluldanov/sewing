-- Переопределение сдельной расценки операции «для изделия»
-- (ТЗ «цена операции зависит от изделия»). Поля nullable: NULL =
-- расценка по дефолту операции (Operation.fixedRate). На шаблоне
-- маршрута менеджер задаёт цену при сборке изделия; снимок едет в
-- OrderRouteStep при старте заказа.
ALTER TABLE "RouteTemplateStep" ADD COLUMN "rateOverride" DECIMAL(12,2);
ALTER TABLE "OrderRouteStep" ADD COLUMN "rateOverride" DECIMAL(12,2);
