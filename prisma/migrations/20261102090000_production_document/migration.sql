-- ДОКУМЕНТ ВЫПУСКА ПО ЗАКАЗУ (решение владельца 04.09 + 08.09.2026).
--
-- Паспорта заказа собираются в ОДИН документ выпуска: он говорит, что цех сдал и почём.
-- Согласования снаружи нет — ЕРП читает готовые документы, а не подтверждает их.
--
-- ⛔ `orderId` UNIQUE: один заказ — один документ. Это не украшение, а защита от гонки
-- закрытия: авто-закрытие при полной упаковке и ручное `complete()` могут прийти почти
-- одновременно, и без уникальности заказ получил бы два документа выпуска с разными номерами.
--
-- Бэкфилла НЕТ намеренно: документ рождается закрытием заказа, а закрытые до этой миграции
-- заказы закрывались без него. Задним числом их выпуск не реконструировать — себестоимость
-- считается по фактам на момент фиксации, и «восстановленный» документ был бы выдумкой.

CREATE TABLE "ProductionDocument" (
  "id"      TEXT NOT NULL,
  "number"  TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "status"  TEXT NOT NULL DEFAULT 'FORMING',

  "closedAt"     TIMESTAMP(3) NOT NULL,
  "readyAt"      TIMESTAMP(3),
  "lastFactAt"   TIMESTAMP(3),
  "lastFactKind" TEXT,

  "recalculatedAt" TIMESTAMP(3),
  "recalcReason"   TEXT,

  "qtyPlan"   INTEGER NOT NULL DEFAULT 0,
  "qtyGood"   INTEGER NOT NULL DEFAULT 0,
  "qtyCut"    INTEGER NOT NULL DEFAULT 0,
  "qtyDefect" INTEGER NOT NULL DEFAULT 0,

  "materialsOwnRub"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "materialsErpRub"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "pieceworkRub"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  "pieceworkPendingRub" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "recutRub"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  "salaryRub"           DECIMAL(14,2) NOT NULL DEFAULT 0,
  "otherRub"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalRub"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  "perUnitRub"          DECIMAL(14,2) NOT NULL DEFAULT 0,
  "planTotalRub"        DECIMAL(14,2),
  "planPerUnitRub"      DECIMAL(14,2),
  "costWarnings"        TEXT[],

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductionDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductionDocumentLine" (
  "id"                   TEXT NOT NULL,
  "productionDocumentId" TEXT NOT NULL,

  "orderVariantId" TEXT,
  "color"          TEXT,
  "sizeId"         TEXT NOT NULL,

  "qtyGood"   INTEGER NOT NULL DEFAULT 0,
  "qtyCut"    INTEGER NOT NULL DEFAULT 0,
  "qtyDefect" INTEGER NOT NULL DEFAULT 0,
  "isSample"  BOOLEAN NOT NULL DEFAULT false,

  "passportNumbers" TEXT[],

  CONSTRAINT "ProductionDocumentLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductionDocument_number_key"  ON "ProductionDocument"("number");
CREATE UNIQUE INDEX "ProductionDocument_orderId_key" ON "ProductionDocument"("orderId");
CREATE INDEX "ProductionDocument_status_idx"         ON "ProductionDocument"("status");
CREATE INDEX "ProductionDocument_readyAt_idx"        ON "ProductionDocument"("readyAt");
CREATE INDEX "ProductionDocument_closedAt_idx"       ON "ProductionDocument"("closedAt");
CREATE INDEX "ProductionDocument_recalculatedAt_idx" ON "ProductionDocument"("recalculatedAt");

CREATE INDEX "ProductionDocumentLine_productionDocumentId_idx" ON "ProductionDocumentLine"("productionDocumentId");
CREATE INDEX "ProductionDocumentLine_sizeId_idx"               ON "ProductionDocumentLine"("sizeId");

ALTER TABLE "ProductionDocument"
  ADD CONSTRAINT "ProductionDocument_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductionDocumentLine"
  ADD CONSTRAINT "ProductionDocumentLine_productionDocumentId_fkey"
  FOREIGN KEY ("productionDocumentId") REFERENCES "ProductionDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict: размер, по которому уже выпускали, из справочника не вычёркивают.
ALTER TABLE "ProductionDocumentLine"
  ADD CONSTRAINT "ProductionDocumentLine_sizeId_fkey"
  FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
