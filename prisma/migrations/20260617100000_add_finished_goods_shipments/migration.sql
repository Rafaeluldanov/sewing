-- Отгрузка готовой продукции из заказа (см.
--   prisma/schema.prisma::FinishedGoodsShipment / FinishedGoodsShipmentLine,
--   apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder,
--   docs/current-state.md §«Отгрузка готовой продукции»,
--   docs/api.md §«Finished goods shipments»).
--
-- Отдельный контур от материалов: StockBalance / StockMovement /
-- MaterialIssue / PurchaseReceipt / StockAdjustment / StockTransfer
-- здесь НЕ участвуют. По каждой строке shipment создаётся ровно один
-- FinishedGoodsMovement type=SHIPMENT direction=OUT (sourceKey
-- FINISHED_GOODS_SHIPMENT_LINE:<lineId>); FinishedGoodsBalance
-- уменьшается. На MVP cancel/reversal shipment не реализован,
-- Order.status автоматически не меняется.

-- =========================
-- FinishedGoodsShipment
-- =========================

CREATE TABLE "FinishedGoodsShipment" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment" TEXT,
    "sourceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "FinishedGoodsShipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinishedGoodsShipment_number_key"
  ON "FinishedGoodsShipment"("number");

CREATE UNIQUE INDEX "FinishedGoodsShipment_sourceKey_key"
  ON "FinishedGoodsShipment"("sourceKey");

CREATE INDEX "FinishedGoodsShipment_orderId_idx"
  ON "FinishedGoodsShipment"("orderId");
CREATE INDEX "FinishedGoodsShipment_status_idx"
  ON "FinishedGoodsShipment"("status");
CREATE INDEX "FinishedGoodsShipment_shippedAt_idx"
  ON "FinishedGoodsShipment"("shippedAt");
CREATE INDEX "FinishedGoodsShipment_createdAt_idx"
  ON "FinishedGoodsShipment"("createdAt");

ALTER TABLE "FinishedGoodsShipment"
  ADD CONSTRAINT "FinishedGoodsShipment_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================
-- FinishedGoodsShipmentLine
-- =========================

CREATE TABLE "FinishedGoodsShipmentLine" (
    "id" TEXT NOT NULL,
    "finishedGoodsShipmentId" TEXT NOT NULL,
    "finishedGoodsBalanceId" TEXT,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "qty" INTEGER NOT NULL,
    "comment" TEXT,

    CONSTRAINT "FinishedGoodsShipmentLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinishedGoodsShipmentLine_finishedGoodsShipmentId_idx"
  ON "FinishedGoodsShipmentLine"("finishedGoodsShipmentId");
CREATE INDEX "FinishedGoodsShipmentLine_finishedGoodsBalanceId_idx"
  ON "FinishedGoodsShipmentLine"("finishedGoodsBalanceId");
CREATE INDEX "FinishedGoodsShipmentLine_orderId_idx"
  ON "FinishedGoodsShipmentLine"("orderId");
CREATE INDEX "FinishedGoodsShipmentLine_productId_idx"
  ON "FinishedGoodsShipmentLine"("productId");
CREATE INDEX "FinishedGoodsShipmentLine_sizeId_idx"
  ON "FinishedGoodsShipmentLine"("sizeId");
CREATE INDEX "FinishedGoodsShipmentLine_warehouseId_idx"
  ON "FinishedGoodsShipmentLine"("warehouseId");
CREATE INDEX "FinishedGoodsShipmentLine_cellId_idx"
  ON "FinishedGoodsShipmentLine"("cellId");

ALTER TABLE "FinishedGoodsShipmentLine"
  ADD CONSTRAINT "FinishedGoodsShipmentLine_finishedGoodsShipmentId_fkey"
  FOREIGN KEY ("finishedGoodsShipmentId") REFERENCES "FinishedGoodsShipment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsShipmentLine"
  ADD CONSTRAINT "FinishedGoodsShipmentLine_finishedGoodsBalanceId_fkey"
  FOREIGN KEY ("finishedGoodsBalanceId") REFERENCES "FinishedGoodsBalance"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsShipmentLine"
  ADD CONSTRAINT "FinishedGoodsShipmentLine_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsShipmentLine"
  ADD CONSTRAINT "FinishedGoodsShipmentLine_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsShipmentLine"
  ADD CONSTRAINT "FinishedGoodsShipmentLine_sizeId_fkey"
  FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsShipmentLine"
  ADD CONSTRAINT "FinishedGoodsShipmentLine_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsShipmentLine"
  ADD CONSTRAINT "FinishedGoodsShipmentLine_cellId_fkey"
  FOREIGN KEY ("cellId") REFERENCES "Cell"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
