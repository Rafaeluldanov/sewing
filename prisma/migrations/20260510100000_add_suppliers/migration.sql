-- Этап 5 «Справочник поставщиков» — мягкая интеграция с «Потребностью
-- цеха» (см. `prisma/schema.prisma::Supplier`,
-- `apps/api/src/modules/suppliers/*`,
-- `docs/recon-soft-integration.md §«Этап 5»`).
--
-- Дизайн миграции:
--   * Добавляем три новые таблицы `Supplier`, `SupplierContact`,
--     `SupplierCatalogItem` (плюс индексы и FK с CASCADE на supplierId).
--   * Расширяем `WorkshopNeed` двумя nullable-колонками
--     (`selectedSupplierId`, `selectedSupplierCatalogItemId`) с FK
--     `ON DELETE SET NULL`. Все старые `WorkshopNeed` остаются валидны:
--     поля по умолчанию `NULL`, текстовые `supplierNameText` /
--     `purchaseItemNameText` НЕ удаляем.
--   * Никаких изменений `Order`, `OrderItem`, `Passport`,
--     `TechCardMaterialLine`, `OrderMaterialRequirement`,
--     `PatternItem`, `PatternMaterialArea`, `RouteTemplate`,
--     `Product`, `Client`, `AuditLog` — этап 5 чисто additive.
--   * Никаких новых ролей (`PURCHASER`/`TECHNOLOGIST`/...) —
--     RBAC завязан на существующие `ADMIN`/`SHOP_MANAGER`
--     (см. `@Roles(...)` в контроллере поставщиков).
--   * `status` хранится как `TEXT` (без Postgres enum), список
--     валидируется Zod-ом на API (см. `@sewing/shared/suppliers`).

-- ---------------------------------------------------------------------------
-- Supplier
-- ---------------------------------------------------------------------------

CREATE TABLE "Supplier" (
    "id"        TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "phone"     TEXT,
    "website"   TEXT,
    "address"   TEXT,
    "comment"   TEXT,
    "status"    TEXT         NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Supplier_status_idx" ON "Supplier"("status");
CREATE INDEX "Supplier_name_idx"   ON "Supplier"("name");

-- ---------------------------------------------------------------------------
-- SupplierContact (контакты менеджеров поставщика)
-- ---------------------------------------------------------------------------

CREATE TABLE "SupplierContact" (
    "id"         TEXT         NOT NULL,
    "supplierId" TEXT         NOT NULL,
    "name"       TEXT         NOT NULL,
    "position"   TEXT,
    "phone"      TEXT,
    "email"      TEXT,
    "messenger"  TEXT,
    "isPrimary"  BOOLEAN      NOT NULL DEFAULT false,
    "comment"    TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierContact_supplierId_idx" ON "SupplierContact"("supplierId");

ALTER TABLE "SupplierContact"
  ADD CONSTRAINT "SupplierContact_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SupplierCatalogItem (номенклатура, которую продаёт поставщик)
-- ---------------------------------------------------------------------------

CREATE TABLE "SupplierCatalogItem" (
    "id"              TEXT         NOT NULL,
    "supplierId"      TEXT         NOT NULL,
    "name"            TEXT         NOT NULL,
    "supplierArticle" TEXT,
    "category"        TEXT,
    "fabricType"      TEXT,
    "densityGsm"      INTEGER,
    "colorText"       TEXT,
    "unit"            TEXT         NOT NULL,
    "lastPrice"       DECIMAL(14,2),
    "currency"        TEXT,
    "minOrderQty"     DECIMAL(14,4),
    "deliveryDays"    INTEGER,
    "comment"         TEXT,
    "status"          TEXT         NOT NULL DEFAULT 'ACTIVE',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierCatalogItem_supplierId_idx"  ON "SupplierCatalogItem"("supplierId");
CREATE INDEX "SupplierCatalogItem_status_idx"     ON "SupplierCatalogItem"("status");
CREATE INDEX "SupplierCatalogItem_fabricType_idx" ON "SupplierCatalogItem"("fabricType");
CREATE INDEX "SupplierCatalogItem_densityGsm_idx" ON "SupplierCatalogItem"("densityGsm");

ALTER TABLE "SupplierCatalogItem"
  ADD CONSTRAINT "SupplierCatalogItem_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WorkshopNeed: мягкая связь с поставщиком и его номенклатурой
-- ---------------------------------------------------------------------------

ALTER TABLE "WorkshopNeed"
  ADD COLUMN "selectedSupplierId"            TEXT,
  ADD COLUMN "selectedSupplierCatalogItemId" TEXT;

ALTER TABLE "WorkshopNeed"
  ADD CONSTRAINT "WorkshopNeed_selectedSupplierId_fkey"
    FOREIGN KEY ("selectedSupplierId") REFERENCES "Supplier"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkshopNeed"
  ADD CONSTRAINT "WorkshopNeed_selectedSupplierCatalogItemId_fkey"
    FOREIGN KEY ("selectedSupplierCatalogItemId") REFERENCES "SupplierCatalogItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "WorkshopNeed_selectedSupplierId_idx"
  ON "WorkshopNeed"("selectedSupplierId");
CREATE INDEX "WorkshopNeed_selectedSupplierCatalogItemId_idx"
  ON "WorkshopNeed"("selectedSupplierCatalogItemId");
