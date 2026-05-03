-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "balanceKey" TEXT NOT NULL,
    "workshopNeedId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "description" TEXT NOT NULL,
    "materialRole" TEXT,
    "unit" TEXT NOT NULL,
    "qty" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMovementAt" TIMESTAMP(3),

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "stockBalanceId" TEXT,
    "workshopNeedId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "qty" DECIMAL(14,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balanceBeforeQty" DECIMAL(14,4),
    "balanceAfterQty" DECIMAL(14,4),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "purchaseReceiptId" TEXT,
    "purchaseReceiptLineId" TEXT,
    "materialIssueId" TEXT,
    "materialIssueLineId" TEXT,
    "comment" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockBalance_balanceKey_key" ON "StockBalance"("balanceKey");
CREATE INDEX "StockBalance_workshopNeedId_idx" ON "StockBalance"("workshopNeedId");
CREATE INDEX "StockBalance_warehouseId_idx" ON "StockBalance"("warehouseId");
CREATE INDEX "StockBalance_cellId_idx" ON "StockBalance"("cellId");
CREATE INDEX "StockBalance_updatedAt_idx" ON "StockBalance"("updatedAt");

CREATE INDEX "StockMovement_stockBalanceId_idx" ON "StockMovement"("stockBalanceId");
CREATE INDEX "StockMovement_workshopNeedId_idx" ON "StockMovement"("workshopNeedId");
CREATE INDEX "StockMovement_type_idx" ON "StockMovement"("type");
CREATE INDEX "StockMovement_direction_idx" ON "StockMovement"("direction");
CREATE INDEX "StockMovement_sourceType_sourceId_idx" ON "StockMovement"("sourceType", "sourceId");
CREATE INDEX "StockMovement_purchaseReceiptId_idx" ON "StockMovement"("purchaseReceiptId");
CREATE INDEX "StockMovement_purchaseReceiptLineId_idx" ON "StockMovement"("purchaseReceiptLineId");
CREATE INDEX "StockMovement_materialIssueId_idx" ON "StockMovement"("materialIssueId");
CREATE INDEX "StockMovement_materialIssueLineId_idx" ON "StockMovement"("materialIssueLineId");
CREATE INDEX "StockMovement_createdAt_idx" ON "StockMovement"("createdAt");

ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_workshopNeedId_fkey" FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "Cell"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockBalanceId_fkey" FOREIGN KEY ("stockBalanceId") REFERENCES "StockBalance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_workshopNeedId_fkey" FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "Cell"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_purchaseReceiptId_fkey" FOREIGN KEY ("purchaseReceiptId") REFERENCES "PurchaseReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_purchaseReceiptLineId_fkey" FOREIGN KEY ("purchaseReceiptLineId") REFERENCES "PurchaseReceiptLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_materialIssueId_fkey" FOREIGN KEY ("materialIssueId") REFERENCES "MaterialIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_materialIssueLineId_fkey" FOREIGN KEY ("materialIssueLineId") REFERENCES "MaterialIssueLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
