-- Foundation готовой продукции (см.
--   prisma/schema.prisma::FinishedGoodsBalance / FinishedGoodsMovement,
--   apps/api/src/modules/finished-goods/*,
--   docs/current-state.md §«Готовая продукция»).
--
-- Отдельный контур от материалов: StockBalance / StockMovement /
-- MaterialIssue / PurchaseReceipt / StockAdjustment / StockTransfer
-- здесь НЕ участвуют. На MVP реализован только PRODUCTION_RECEIPT IN —
-- автоматический приход готовой продукции в момент Passport.status = PACKED.

-- =========================
-- FinishedGoodsBalance
-- =========================

CREATE TABLE "FinishedGoodsBalance" (
    "id" TEXT NOT NULL,
    "balanceKey" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMovementAt" TIMESTAMP(3),

    CONSTRAINT "FinishedGoodsBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinishedGoodsBalance_balanceKey_key"
  ON "FinishedGoodsBalance"("balanceKey");

CREATE INDEX "FinishedGoodsBalance_orderId_idx"
  ON "FinishedGoodsBalance"("orderId");
CREATE INDEX "FinishedGoodsBalance_productId_idx"
  ON "FinishedGoodsBalance"("productId");
CREATE INDEX "FinishedGoodsBalance_sizeId_idx"
  ON "FinishedGoodsBalance"("sizeId");
CREATE INDEX "FinishedGoodsBalance_warehouseId_idx"
  ON "FinishedGoodsBalance"("warehouseId");
CREATE INDEX "FinishedGoodsBalance_cellId_idx"
  ON "FinishedGoodsBalance"("cellId");
CREATE INDEX "FinishedGoodsBalance_updatedAt_idx"
  ON "FinishedGoodsBalance"("updatedAt");

ALTER TABLE "FinishedGoodsBalance"
  ADD CONSTRAINT "FinishedGoodsBalance_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsBalance"
  ADD CONSTRAINT "FinishedGoodsBalance_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsBalance"
  ADD CONSTRAINT "FinishedGoodsBalance_sizeId_fkey"
  FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsBalance"
  ADD CONSTRAINT "FinishedGoodsBalance_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsBalance"
  ADD CONSTRAINT "FinishedGoodsBalance_cellId_fkey"
  FOREIGN KEY ("cellId") REFERENCES "Cell"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================
-- FinishedGoodsMovement
-- =========================

CREATE TABLE "FinishedGoodsMovement" (
    "id" TEXT NOT NULL,
    "finishedGoodsBalanceId" TEXT,
    "type" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "qty" INTEGER NOT NULL,
    "balanceBeforeQty" INTEGER,
    "balanceAfterQty" INTEGER,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceKey" TEXT,
    "passportId" TEXT,
    "boxId" TEXT,
    "comment" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinishedGoodsMovement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinishedGoodsMovement_sourceKey_key"
  ON "FinishedGoodsMovement"("sourceKey");

CREATE INDEX "FinishedGoodsMovement_finishedGoodsBalanceId_idx"
  ON "FinishedGoodsMovement"("finishedGoodsBalanceId");
CREATE INDEX "FinishedGoodsMovement_orderId_idx"
  ON "FinishedGoodsMovement"("orderId");
CREATE INDEX "FinishedGoodsMovement_productId_idx"
  ON "FinishedGoodsMovement"("productId");
CREATE INDEX "FinishedGoodsMovement_sizeId_idx"
  ON "FinishedGoodsMovement"("sizeId");
CREATE INDEX "FinishedGoodsMovement_type_idx"
  ON "FinishedGoodsMovement"("type");
CREATE INDEX "FinishedGoodsMovement_direction_idx"
  ON "FinishedGoodsMovement"("direction");
CREATE INDEX "FinishedGoodsMovement_warehouseId_idx"
  ON "FinishedGoodsMovement"("warehouseId");
CREATE INDEX "FinishedGoodsMovement_cellId_idx"
  ON "FinishedGoodsMovement"("cellId");
CREATE INDEX "FinishedGoodsMovement_passportId_idx"
  ON "FinishedGoodsMovement"("passportId");
CREATE INDEX "FinishedGoodsMovement_boxId_idx"
  ON "FinishedGoodsMovement"("boxId");
CREATE INDEX "FinishedGoodsMovement_sourceType_sourceId_idx"
  ON "FinishedGoodsMovement"("sourceType", "sourceId");
CREATE INDEX "FinishedGoodsMovement_createdAt_idx"
  ON "FinishedGoodsMovement"("createdAt");

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_finishedGoodsBalanceId_fkey"
  FOREIGN KEY ("finishedGoodsBalanceId") REFERENCES "FinishedGoodsBalance"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_sizeId_fkey"
  FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_cellId_fkey"
  FOREIGN KEY ("cellId") REFERENCES "Cell"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_passportId_fkey"
  FOREIGN KEY ("passportId") REFERENCES "Passport"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FinishedGoodsMovement"
  ADD CONSTRAINT "FinishedGoodsMovement_boxId_fkey"
  FOREIGN KEY ("boxId") REFERENCES "Box"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
