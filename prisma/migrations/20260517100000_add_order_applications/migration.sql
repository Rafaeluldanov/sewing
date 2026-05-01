-- Этап «Нанесение на заказе покупателя» — additive миграция:
-- появляется новая таблица `OrderApplication` с FK на `Order`. Все
-- остальные таблицы остаются нетронутыми.
--
-- См. `prisma/schema.prisma::OrderApplication`,
-- `apps/api/src/modules/order-applications/*`,
-- `packages/shared/src/order-applications.ts`.
--
-- Дизайн миграции:
--   * Чисто additive: только CREATE TABLE + 4 индекса + FK на
--     `Order` (`ON DELETE CASCADE`). `TechCardOutsourceLine` /
--     `OrderOutsourceRequirement` остаются как legacy — не удаляем
--     и не меняем (см. ТЗ §«Не делать»).
--   * `type`, `stage`, `status` хранятся как `TEXT` (без Postgres
--     enum), список расширяется без миграции. Источник истины —
--     `@sewing/shared/order-applications` (валидируется Zod-ом).
--   * Никаких изменений `Order`, `OrderItem`, `Passport`,
--     `Product`, `PatternItem`, `RouteTemplate`, `TechCardTemplate`,
--     `TechCardOutsourceLine`, `OrderOutsourceRequirement`,
--     `WorkshopNeed`, `PurchaseOrder`, `PurchaseReceipt`. Все
--     старые потребители продолжают работать как раньше.

CREATE TABLE "OrderApplication" (
    "id"          TEXT NOT NULL,
    "orderId"     TEXT NOT NULL,

    "type"        TEXT NOT NULL,
    "stage"       TEXT NOT NULL DEFAULT 'CUT_PARTS',

    "placement"   TEXT,
    "widthMm"     INTEGER,
    "heightMm"    INTEGER,
    "colorsCount" INTEGER,

    "quantity"    DECIMAL(14,4),
    "unit"        TEXT NOT NULL DEFAULT 'шт',

    "colorText"   TEXT,
    "description" TEXT,
    "comment"     TEXT,
    "fileUrl"     TEXT,

    "status"      TEXT NOT NULL DEFAULT 'PLANNED',

    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderApplication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderApplication_orderId_idx" ON "OrderApplication"("orderId");
CREATE INDEX "OrderApplication_type_idx"    ON "OrderApplication"("type");
CREATE INDEX "OrderApplication_stage_idx"   ON "OrderApplication"("stage");
CREATE INDEX "OrderApplication_status_idx"  ON "OrderApplication"("status");

ALTER TABLE "OrderApplication"
  ADD CONSTRAINT "OrderApplication_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
