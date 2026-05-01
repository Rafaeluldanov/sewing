-- Production routes (MVP, soft-route) — см. docs/domain.md §«Маршруты
-- производства» и docs/api.md §«routes».
--
-- Изменение чисто additive: ни одна существующая колонка не меняет
-- семантику, ни один новый NOT NULL без DEFAULT не появляется на
-- существующих таблицах.
--
--   - `RouteTemplate`         — шаблон маршрута (управленческая сущность).
--   - `RouteTemplateStep`     — упорядоченные шаги шаблона; уникальность
--                               по (templateId, index) и (templateId,
--                               operationId) — операция в шаблоне ровно
--                               один раз, индексы не дублируются.
--   - `OrderRouteStep`        — snapshot маршрута на конкретном заказе,
--                               создаётся в `OrdersService.start()`.
--   - `Order.routeTemplateId` — опциональная привязка к шаблону до
--                               запуска (nullable, FK ON DELETE SET NULL).
--   - `Passport.currentRouteStepIndex` — UI-подсказка, обновляется при
--                               сканировании; null для всех старых
--                               паспортов (backward-compatible).

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "routeTemplateId" TEXT;

-- AlterTable
ALTER TABLE "Passport" ADD COLUMN     "currentRouteStepIndex" INTEGER;

-- CreateTable
CREATE TABLE "RouteTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteTemplateStep" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "operationId" TEXT NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RouteTemplateStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRouteStep" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "operationId" TEXT NOT NULL,

    CONSTRAINT "OrderRouteStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RouteTemplate_code_key" ON "RouteTemplate"("code");

-- CreateIndex
CREATE INDEX "RouteTemplate_isActive_idx" ON "RouteTemplate"("isActive");

-- CreateIndex
CREATE INDEX "RouteTemplateStep_operationId_idx" ON "RouteTemplateStep"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteTemplateStep_templateId_index_key" ON "RouteTemplateStep"("templateId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "RouteTemplateStep_templateId_operationId_key" ON "RouteTemplateStep"("templateId", "operationId");

-- CreateIndex
CREATE INDEX "OrderRouteStep_orderId_idx" ON "OrderRouteStep"("orderId");

-- CreateIndex
CREATE INDEX "OrderRouteStep_operationId_idx" ON "OrderRouteStep"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRouteStep_orderId_index_key" ON "OrderRouteStep"("orderId", "index");

-- CreateIndex
CREATE INDEX "Order_routeTemplateId_idx" ON "Order"("routeTemplateId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_routeTemplateId_fkey" FOREIGN KEY ("routeTemplateId") REFERENCES "RouteTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteTemplateStep" ADD CONSTRAINT "RouteTemplateStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RouteTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteTemplateStep" ADD CONSTRAINT "RouteTemplateStep_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRouteStep" ADD CONSTRAINT "OrderRouteStep_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRouteStep" ADD CONSTRAINT "OrderRouteStep_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
