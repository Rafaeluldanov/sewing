-- Лестница остатков, шаг 5: факт списания материала в ERP по выпуску паспорта.
CREATE TABLE "ErpMaterialConsumption" (
    "id" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'POSTED',
    "erpDocumentId" TEXT,
    "erpDocumentRef" TEXT,
    "writtenOffAt" TIMESTAMP(3),
    "amountRub" DECIMAL(14,2),
    "uncoveredQty" DECIMAL(14,4),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpMaterialConsumption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ErpMaterialConsumptionLine" (
    "id" TEXT NOT NULL,
    "consumptionId" TEXT NOT NULL,
    "workshopNeedId" TEXT,
    "description" TEXT NOT NULL,
    "unit" TEXT,
    "qty" DECIMAL(14,4) NOT NULL,
    "amountRub" DECIMAL(14,2) NOT NULL,
    "erpSeriesId" TEXT,
    "rollLabel" TEXT,
    "uncoveredQty" DECIMAL(14,4),

    CONSTRAINT "ErpMaterialConsumptionLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ErpMaterialConsumption_passportId_key" ON "ErpMaterialConsumption"("passportId");
CREATE INDEX "ErpMaterialConsumption_orderId_idx" ON "ErpMaterialConsumption"("orderId");
CREATE INDEX "ErpMaterialConsumption_syncedAt_idx" ON "ErpMaterialConsumption"("syncedAt");
CREATE INDEX "ErpMaterialConsumptionLine_consumptionId_idx" ON "ErpMaterialConsumptionLine"("consumptionId");
CREATE INDEX "ErpMaterialConsumptionLine_workshopNeedId_idx" ON "ErpMaterialConsumptionLine"("workshopNeedId");

ALTER TABLE "ErpMaterialConsumption" ADD CONSTRAINT "ErpMaterialConsumption_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErpMaterialConsumption" ADD CONSTRAINT "ErpMaterialConsumption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErpMaterialConsumptionLine" ADD CONSTRAINT "ErpMaterialConsumptionLine_consumptionId_fkey" FOREIGN KEY ("consumptionId") REFERENCES "ErpMaterialConsumption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErpMaterialConsumptionLine" ADD CONSTRAINT "ErpMaterialConsumptionLine_workshopNeedId_fkey" FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;
