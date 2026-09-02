-- Закупочный шов ERP: потребность цеха, взятая под заказ поставщику ERP, и факт прихода по её приёмке.
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpManagedAt" TIMESTAMP(3);
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpPurchaseOrderId" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpPurchaseOrderRef" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpReceivedQty" DECIMAL(14,4);
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpReceivedAt" TIMESTAMP(3);
