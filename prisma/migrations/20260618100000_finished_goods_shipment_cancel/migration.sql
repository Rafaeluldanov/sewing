-- Отмена отгрузки готовой продукции (см.
--   prisma/schema.prisma::FinishedGoodsShipment,
--   apps/api/src/modules/finished-goods/finished-goods.service.ts::cancelShipment,
--   docs/current-state.md §«Отгрузка готовой продукции»,
--   docs/api.md §«Finished goods shipments»).
--
-- Решение владельца проекта: НЕ создавать отдельный документ
-- сторно/возврата. Существующий FinishedGoodsShipment получает
-- status=CANCELLED + поля cancelledAt/cancelledById/cancelReason.
-- По каждой строке shipment создаётся обратное FinishedGoodsMovement
-- type=REVERSAL direction=IN (sourceKey
-- FINISHED_GOODS_SHIPMENT_CANCEL_LINE:<lineId>) — FinishedGoodsBalance
-- увеличивается обратно атомарно. Order.status / material stock
-- автоматически НЕ меняются.

ALTER TABLE "FinishedGoodsShipment"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" TEXT,
  ADD COLUMN "cancelReason" TEXT;

CREATE INDEX "FinishedGoodsShipment_cancelledAt_idx"
  ON "FinishedGoodsShipment"("cancelledAt");
