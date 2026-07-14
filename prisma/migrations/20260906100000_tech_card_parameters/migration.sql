-- Фича «Параметры техкарт»: именованные слоты в ячейках строк материала.
-- Значение слота вводится в ЗАКАЗЕ, на каждой расцветке отдельно, — один
-- шаблон с параметром «плотность» заменяет четыре близнеца ТК-*-160/190/220.
--
-- Обобщение уже работающего `colorRule = ORDER_SELECTED_COLOR`. Цвет из-под
-- параметров сознательно выведен (за него по-прежнему отвечает colorRule).
--
-- Аддитивно и обратимо: у существующих шаблонов ноль параметров → биндингов
-- нет → подстановка no-op, гейт вакуумный. Поведение бит-в-бит сегодняшнее,
-- бэкфилл не нужен. Откат = DROP двух таблиц + двух колонок.

-- Слоты в справочнике техкарт.
CREATE TABLE "TechCardParameter" (
  "id"           TEXT NOT NULL,
  "techCardId"   TEXT NOT NULL,
  "key"          TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "inputType"    TEXT NOT NULL DEFAULT 'TEXT',
  "options"      JSONB,
  "unit"         TEXT,
  "isRequired"   BOOLEAN NOT NULL DEFAULT true,
  "defaultValue" TEXT,
  "owner"        TEXT NOT NULL DEFAULT 'MANUAL',
  "sortOrder"    INTEGER NOT NULL DEFAULT 100,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TechCardParameter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TechCardParameter_techCardId_key_key"
  ON "TechCardParameter"("techCardId", "key");
CREATE INDEX "TechCardParameter_techCardId_sortOrder_idx"
  ON "TechCardParameter"("techCardId", "sortOrder");

ALTER TABLE "TechCardParameter" ADD CONSTRAINT "TechCardParameter_techCardId_fkey"
  FOREIGN KEY ("techCardId") REFERENCES "TechCardTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Слоты + ЗНАЧЕНИЯ внутри заказа. Значение принадлежит расцветке;
-- `orderVariantId` nullable — та же семантика order-level группы, что у
-- `OrderMaterialRequirement` (плюс заказы из inline-формы вообще без расцветок).
-- Пересборка снапшота эту таблицу не трогает: значения переживают пересчёт тиража.
CREATE TABLE "OrderTechCardParameter" (
  "id"                TEXT NOT NULL,
  "orderId"           TEXT NOT NULL,
  "orderVariantId"    TEXT,
  "key"               TEXT NOT NULL,
  "label"             TEXT NOT NULL,
  "inputType"         TEXT NOT NULL DEFAULT 'TEXT',
  "options"           JSONB,
  "unit"              TEXT,
  "isRequired"        BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"         INTEGER NOT NULL DEFAULT 100,
  "owner"             TEXT NOT NULL DEFAULT 'MANUAL',
  "sourceTechCardId"  TEXT,
  "sourceParameterId" TEXT,
  "value"             TEXT,
  "valueSource"       TEXT NOT NULL DEFAULT 'MANUAL',
  "valueUpdatedAt"    TIMESTAMP(3),
  "valueUpdatedById"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderTechCardParameter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderTechCardParameter_orderId_idx"
  ON "OrderTechCardParameter"("orderId");
CREATE INDEX "OrderTechCardParameter_orderId_orderVariantId_idx"
  ON "OrderTechCardParameter"("orderId", "orderVariantId");

ALTER TABLE "OrderTechCardParameter" ADD CONSTRAINT "OrderTechCardParameter_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderTechCardParameter" ADD CONSTRAINT "OrderTechCardParameter_orderVariantId_fkey"
  FOREIGN KEY ("orderVariantId") REFERENCES "OrderVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Привязка «ячейка строки → ключ параметра»: { "char:density": "main_density" }.
-- JSON, а не FK: сейв шаблона пересоздаёт строки (deleteMany+createMany), id
-- меняются, и внешний ключ отваливался бы при каждом сохранении справочника.
ALTER TABLE "TechCardMaterialLine"     ADD COLUMN "parameterBindings" JSONB;
ALTER TABLE "OrderMaterialRequirement" ADD COLUMN "parameterBindings" JSONB;
