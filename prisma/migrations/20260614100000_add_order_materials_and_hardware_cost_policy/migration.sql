-- Order: упрощённая политика учёта материалов и фурнитуры в
-- себестоимости заказа (см.
--   prisma/schema.prisma::Order.materialsAndHardwareCostPolicy,
--   apps/api/src/modules/orders/orders.service.ts::create / update,
--   apps/api/src/modules/costs/costs.service.ts,
--   apps/web/components/orders/summary/build-order-summary-rows.ts,
--   docs/current-state.md §«Давальческое сырьё клиента»).
--
-- Значения:
--   - INCLUDE — учитывать материалы и фурнитуру в себестоимости (default);
--   - EXCLUDE — давальческое сырьё / фурнитура клиента: складские движения
--     и расчёт потребности продолжают работать, но MATERIAL / HARDWARE
--     не входят в себестоимость заказа и production cost.
--
-- String (а не enum): в проекте многие статусы хранятся строкой;
-- расширение списка значений не требует миграции схемы.
--
-- Не затрагиваются: StockBalance, StockMovement, StockAdjustment,
-- StockTransfer, MaterialIssue, MaterialIssueReturn, WorkshopNeed,
-- OrderMaterialRequirement.

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "materialsAndHardwareCostPolicy" TEXT NOT NULL DEFAULT 'INCLUDE';

-- CreateIndex
CREATE INDEX "Order_materialsAndHardwareCostPolicy_idx"
  ON "Order"("materialsAndHardwareCostPolicy");
