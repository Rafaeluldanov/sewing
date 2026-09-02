-- Зеркало остатка швейного склада, ведомого в ERP upgifts.
--
-- Таблица приезжает ПУСТОЙ и её НЕ ЧИТАЕТ НИ ОДИН запрос приложения: это первый,
-- намеренно тихий шаг перевода склада материалов в ERP. Существующие таблицы не
-- затрагиваются — ни ALTER, ни DML, ни бэкфилла, значит ни блокировок на рабочих
-- таблицах, ни риска для кроя и приёмки.
--
-- IF NOT EXISTS — страховка от окружения, где entrypoint успел сделать
-- `prisma db push` до `migrate deploy`.
CREATE TABLE IF NOT EXISTS "ErpShopStock" (
  "id"                  TEXT NOT NULL,
  "erpProductId"        TEXT NOT NULL,
  "erpProductCode"      TEXT,
  "erpProductName"      TEXT NOT NULL,
  "erpCharacteristicId" TEXT,
  "erpSeriesId"         TEXT,
  "rollNumber"          TEXT,
  "shade"               TEXT,
  "widthCm"             TEXT,
  "densityGsm"          TEXT,
  "qty"                 DECIMAL(15,3) NOT NULL,
  "unit"                TEXT,
  "bins"                JSONB NOT NULL DEFAULT '[]',
  "syncedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ErpShopStock_pkey" PRIMARY KEY ("id")
);

-- NULLS NOT DISTINCT: у материала без рулонного учёта `erpSeriesId` пуст, и без
-- этого ключ его не защищал бы — NULL <> NULL пропустил бы дубли остатка.
CREATE UNIQUE INDEX IF NOT EXISTS "ErpShopStock_key"
  ON "ErpShopStock" NULLS NOT DISTINCT ("erpProductId", "erpCharacteristicId", "erpSeriesId");

CREATE INDEX IF NOT EXISTS "ErpShopStock_erpProductId_idx"
  ON "ErpShopStock"("erpProductId");
