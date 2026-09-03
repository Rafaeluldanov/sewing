-- Обратный шов §0.5: готовая продукция цеха приходуется на склад ERP.
ALTER TABLE "CompanySettings" ADD COLUMN "erpFinishedGoodsSince" TIMESTAMP(3);
ALTER TABLE "CompanySettings" ADD COLUMN "erpOwnsFinishedGoods" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ErpFinishedGoodsReceipt" (
    "id" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'POSTED',
    "erpDocumentId" TEXT,
    "erpDocumentNumber" TEXT,
    "erpOrganizationId" TEXT,
    "erpOrganizationName" TEXT,
    "erpWarehouseId" TEXT,
    "erpWarehouseName" TEXT,
    "erpNomenclatureId" TEXT,
    "erpNomenclatureName" TEXT,
    "erpCharacteristicId" TEXT,
    "erpCharacteristicName" TEXT,
    "qty" INTEGER,
    "postedAt" TIMESTAMP(3),
    "error" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpFinishedGoodsReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ErpFinishedGoodsReceipt_passportId_key" ON "ErpFinishedGoodsReceipt"("passportId");
CREATE INDEX "ErpFinishedGoodsReceipt_orderId_idx" ON "ErpFinishedGoodsReceipt"("orderId");
CREATE INDEX "ErpFinishedGoodsReceipt_syncedAt_idx" ON "ErpFinishedGoodsReceipt"("syncedAt");
CREATE INDEX "ErpFinishedGoodsReceipt_state_idx" ON "ErpFinishedGoodsReceipt"("state");

ALTER TABLE "ErpFinishedGoodsReceipt" ADD CONSTRAINT "ErpFinishedGoodsReceipt_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErpFinishedGoodsReceipt" ADD CONSTRAINT "ErpFinishedGoodsReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
