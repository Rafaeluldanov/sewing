-- Этап 4А «Потребность цеха» — рабочее место закупщика и расчёт
-- чистой потребности заказа в материалах.
--
-- См. `prisma/schema.prisma::WorkshopNeed`,
-- `apps/api/src/modules/workshop-needs/*`,
-- `docs/recon-soft-integration.md §«Этап 4А»`.
--
-- Дизайн миграции:
--   * Добавляем ОДНУ новую таблицу `WorkshopNeed` + 4 индекса + FK
--     на `Order` (`ON DELETE CASCADE`). Все остальные таблицы остаются
--     нетронутыми — этап 4А чисто additive.
--   * `status` и `calculationMethod` хранятся как `TEXT` (без Postgres
--     enum), чтобы расширять список без миграций — единственный
--     источник истины для допустимых значений живёт в
--     `@sewing/shared/workshop-needs` (валидируется Zod-ом на API).
--   * Никаких изменений `Order`, `OrderItem`, `Passport`,
--     `TechCardMaterialLine`, `OrderMaterialRequirement`,
--     `PatternItem`, `PatternMaterialArea`, `RouteTemplate`,
--     `Product` — этап 4А soft-build поверх уже существующих
--     модулей «Лекала» (этап 1) и «Техкарты» (этап 3).
--   * Никаких новых ролей (`PURCHASER` и т.п.) — RBAC завязан на
--     существующие `ADMIN`/`SHOP_MANAGER` через `@Roles(...)` в
--     контроллере.
--   * `purchaseQty` сознательно nullable — система НЕ копирует
--     `calculatedQty` в `purchaseQty`; закупщик заполняет руками.

CREATE TABLE "WorkshopNeed" (
    "id"                   TEXT NOT NULL,
    "orderId"              TEXT NOT NULL,

    "sourceType"           TEXT,
    "sourceId"             TEXT,

    "materialRole"         TEXT,
    "sourceName"           TEXT,
    "description"          TEXT NOT NULL,

    "fabricType"           TEXT,
    "densityGsm"           INTEGER,
    "plannedWidthCm"       INTEGER,

    "colorRule"            TEXT,
    "fixedColorText"       TEXT,
    "resolvedColorText"    TEXT,

    "totalAreaM2"          DECIMAL(14,4),
    "calculatedQty"        DECIMAL(14,4) NOT NULL,
    "purchaseQty"          DECIMAL(14,4),
    "unit"                 TEXT NOT NULL,

    "calculationMethod"    TEXT NOT NULL DEFAULT 'QTY_PER_UNIT',
    "status"               TEXT NOT NULL DEFAULT 'CALCULATED',

    "supplierNameText"     TEXT,
    "purchaseItemNameText" TEXT,
    "quotedPrice"          DECIMAL(14,2),
    "quotedCurrency"       TEXT,
    "expectedDeliveryDate" TIMESTAMP(3),

    "comment"              TEXT,
    "calculationNote"      TEXT,

    "calculatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkshopNeed_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkshopNeed_orderId_idx"           ON "WorkshopNeed"("orderId");
CREATE INDEX "WorkshopNeed_status_idx"            ON "WorkshopNeed"("status");
CREATE INDEX "WorkshopNeed_materialRole_idx"      ON "WorkshopNeed"("materialRole");
CREATE INDEX "WorkshopNeed_calculationMethod_idx" ON "WorkshopNeed"("calculationMethod");

ALTER TABLE "WorkshopNeed"
  ADD CONSTRAINT "WorkshopNeed_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
