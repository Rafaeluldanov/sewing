-- Этап 1 плана «техкарты → номенклатура» (анализ 11.08.2026): карточка
-- номенклатуры получает СОСТАВ МАТЕРИАЛОВ — то, что раньше жило только в
-- строках техкарты. Две новые таблицы:
--   - "PatternItemMaterialLine"  — зеркало "TechCardMaterialLine" c привязкой
--     к изделию (одна спецификация на PatternItem, решение §1 анализа);
--   - "PatternItemSpecParameter" — зеркало "TechCardParameter" (слоты,
--     значения по-прежнему вводятся в заказе на расцветках).
--
-- Аддитивно и обратимо: техкарты продолжают работать без изменений, заказы
-- материализуют снапшот из техкарты до этапа 3. Бэкфилл из техкарт — этап 2,
-- отдельным скриптом. Откат = DROP двух таблиц.

CREATE TABLE "PatternItemMaterialLine" (
  "id"                            TEXT NOT NULL,
  "patternItemId"                 TEXT NOT NULL,
  "sortOrder"                     INTEGER NOT NULL,
  "name"                          TEXT NOT NULL,
  "unit"                          TEXT NOT NULL,
  "normUnit"                      TEXT,
  "qtyPerUnit"                    DECIMAL(12,4) NOT NULL,
  "note"                          TEXT,
  "materialRole"                  TEXT,
  "fabricType"                    TEXT,
  "densityGsm"                    INTEGER,
  "plannedWidthCm"                INTEGER,
  "colorRule"                     TEXT,
  "fixedColorText"                TEXT,
  "hardwareSizeText"              TEXT,
  "hardwareMaterialText"          TEXT,
  "materialImageUrl"              TEXT,
  "materialImageOriginalFileName" TEXT,
  "subtypeKey"                    TEXT,
  "characteristics"               JSONB,
  "parameterBindings"             JSONB,
  "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatternItemMaterialLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PatternItemMaterialLine_patternItemId_sortOrder_idx"
  ON "PatternItemMaterialLine"("patternItemId", "sortOrder");
CREATE INDEX "PatternItemMaterialLine_materialRole_idx"
  ON "PatternItemMaterialLine"("materialRole");

ALTER TABLE "PatternItemMaterialLine"
  ADD CONSTRAINT "PatternItemMaterialLine_patternItemId_fkey"
  FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PatternItemSpecParameter" (
  "id"            TEXT NOT NULL,
  "patternItemId" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "inputType"     TEXT NOT NULL DEFAULT 'TEXT',
  "options"       JSONB,
  "unit"          TEXT,
  "isRequired"    BOOLEAN NOT NULL DEFAULT true,
  "defaultValue"  TEXT,
  "owner"         TEXT NOT NULL DEFAULT 'MANUAL',
  "sortOrder"     INTEGER NOT NULL DEFAULT 100,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatternItemSpecParameter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatternItemSpecParameter_patternItemId_key_key"
  ON "PatternItemSpecParameter"("patternItemId", "key");
CREATE INDEX "PatternItemSpecParameter_patternItemId_sortOrder_idx"
  ON "PatternItemSpecParameter"("patternItemId", "sortOrder");

ALTER TABLE "PatternItemSpecParameter"
  ADD CONSTRAINT "PatternItemSpecParameter_patternItemId_fkey"
  FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
