-- Foundation: подключаем PurchaseReceipt → StockBalance.
-- `StockMovement.sourceKey` — внутренний идемпотентный ключ, чтобы
-- повторная обработка приёмки или её отмена при retry не создали
-- дубль движения и не удвоили `StockBalance.qty`.
--   PURCHASE_RECEIPT_LINE:<purchaseReceiptLineId>        — IN при POSTED
--   PURCHASE_RECEIPT_LINE_CANCEL:<purchaseReceiptLineId> — REVERSAL OUT при cancel

ALTER TABLE "StockMovement" ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "StockMovement_sourceKey_key" ON "StockMovement"("sourceKey");
