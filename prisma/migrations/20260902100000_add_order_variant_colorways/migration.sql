-- Фича «Расцветки» (colorways, флаг FEATURE_COLORWAYS): в одном заказе
-- могут быть разные цвета для разных размеров, у каждого цвета — своя
-- техкарта материалов и свой поразмерный план.
--
-- Что добавляется (СТРОГО АДДИТИВНО — для обратимого прод-теста):
--   * `OrderVariant`     — расцветка заказа (цвет + своя техкарта);
--   * `OrderVariantSize` — поразмерный план расцветки.
-- `OrderItem` НЕ трогается: он остаётся агрегированным планом заказа и
-- источником истины для текущего производства/раскроя. Новые таблицы
-- читаются только фичей под флагом → откат = выключить флаг.
--
-- Бэкфилл: каждому существующему заказу — одна расцветка (#0) из
-- `Order.color` + `Order.techCardId`; её поразмерный план зеркалит
-- агрегат `OrderItem` по размеру. Детерминированные id
-- ('ovar0_' || orderId, 'ovsz0_' || variantId || '_' || sizeId) —
-- миграция идемпотентна по данным и переживает re-run в dev.

-- CreateTable
CREATE TABLE "OrderVariant" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "techCardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderVariantSize" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "qtyPlan" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrderVariantSize_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderVariant_orderId_idx" ON "OrderVariant"("orderId");

-- CreateIndex
CREATE INDEX "OrderVariant_techCardId_idx" ON "OrderVariant"("techCardId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderVariant_orderId_ordinal_key" ON "OrderVariant"("orderId", "ordinal");

-- CreateIndex
CREATE INDEX "OrderVariantSize_variantId_idx" ON "OrderVariantSize"("variantId");

-- CreateIndex
CREATE INDEX "OrderVariantSize_sizeId_idx" ON "OrderVariantSize"("sizeId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderVariantSize_variantId_sizeId_key" ON "OrderVariantSize"("variantId", "sizeId");

-- AddForeignKey
ALTER TABLE "OrderVariant" ADD CONSTRAINT "OrderVariant_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariant" ADD CONSTRAINT "OrderVariant_techCardId_fkey" FOREIGN KEY ("techCardId") REFERENCES "TechCardTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSize" ADD CONSTRAINT "OrderVariantSize_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "OrderVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderVariantSize" ADD CONSTRAINT "OrderVariantSize_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: одна расцветка (#0) на каждый заказ из Order.color/techCardId.
INSERT INTO "OrderVariant" ("id", "orderId", "ordinal", "color", "techCardId", "createdAt", "updatedAt")
SELECT 'ovar0_' || o."id", o."id", 0, COALESCE(o."color", ''), o."techCardId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Order" o;

-- Backfill: поразмерный план расцветки #0 = агрегат OrderItem по размеру
-- (заказ может иметь несколько продуктов на один размер — суммируем).
INSERT INTO "OrderVariantSize" ("id", "variantId", "sizeId", "qtyPlan")
SELECT 'ovsz0_' || v."id" || '_' || agg."sizeId", v."id", agg."sizeId", agg."qty"
FROM "OrderVariant" v
JOIN (
    SELECT "orderId", "sizeId", SUM("qtyPlan")::int AS "qty"
    FROM "OrderItem"
    GROUP BY "orderId", "sizeId"
) agg ON agg."orderId" = v."orderId"
WHERE v."ordinal" = 0;
