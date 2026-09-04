-- Приход готовой продукции в ERP = ДОКУМЕНТ ПРОИЗВОДСТВА, а не паспорт (владелец, 04.09.2026).
--
-- Паспорт — документ ЦЕХА: он собирается в документ производства при сдаче заказа, и уже этот
-- документ становится документом выпуска ERP и приходует продукцию на склад. Раньше ERP заводила
-- документ на КАЖДЫЙ паспорт — на один заказ выходило три десятка документов.
--
-- Одна строка на заказ: пока её нет, заказ стоит в очереди сдачи; появилась — заказ из очереди
-- исчез навсегда (ответ ERP необратим).

CREATE TABLE IF NOT EXISTS "ErpProductionDocument" (
  "id"                TEXT PRIMARY KEY,
  "orderId"           TEXT NOT NULL,
  "state"             TEXT NOT NULL DEFAULT 'POSTED',
  "erpDocumentId"     TEXT,
  "erpDocumentNumber" TEXT,
  "erpOrganizationId" TEXT,
  "erpWarehouseId"    TEXT,
  "qtyGood"           INTEGER,
  "postedAt"          TIMESTAMP(3),
  "error"             TEXT,
  "payload"           JSONB,
  "syncedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ErpProductionDocument_orderId_key"
  ON "ErpProductionDocument" ("orderId");
CREATE INDEX IF NOT EXISTS "ErpProductionDocument_syncedAt_idx"
  ON "ErpProductionDocument" ("syncedAt");
CREATE INDEX IF NOT EXISTS "ErpProductionDocument_state_idx"
  ON "ErpProductionDocument" ("state");

DO $$
BEGIN
  ALTER TABLE "ErpProductionDocument"
    ADD CONSTRAINT "ErpProductionDocument_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
