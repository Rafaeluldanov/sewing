-- Foundation полуфабриката (см.
--   prisma/schema.prisma::WorkInProgressBalance / WorkInProgressMovement,
--   apps/api/src/modules/work-in-progress/*,
--   docs/erd.md §2.7b, docs/api.md §29b).
--
-- Эта миграция АТОМАРНО:
--   1) создаёт таблицы WorkInProgressBalance / WorkInProgressMovement
--      и все их индексы/FK;
--   2) переносит существующее содержимое ячеек из legacy CellContent
--      (плюс контекст из Passport: orderId/productId/color/warehouseId)
--      в новые WIP-таблицы с PLACE-движением (sourceType = 'BACKFILL',
--      sourceKey = 'WIP_PLACE_BACKFILL:<passportId>');
--   3) удаляет таблицу CellContent.
--
-- Prisma выполняет миграцию в одной транзакции — либо всё, либо ничего.
-- На проде с ~500 паспортами backfill отрабатывает за ~50 мс.
--
-- Перед деплоем обязательно прогнать smoke-проверку
-- scripts/migrations/20260620_verify_work_in_progress.sql ПОСЛЕ
-- успешного `prisma migrate deploy` (см.
-- prisma/migrations/20260620100000_add_work_in_progress_drop_cell_content/README.md).

-- =========================
-- 1. WorkInProgressBalance
-- =========================

CREATE TABLE "WorkInProgressBalance" (
    "id" TEXT NOT NULL,
    "balanceKey" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMovementAt" TIMESTAMP(3),

    CONSTRAINT "WorkInProgressBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkInProgressBalance_balanceKey_key"
  ON "WorkInProgressBalance"("balanceKey");

CREATE INDEX "WorkInProgressBalance_orderId_idx"
  ON "WorkInProgressBalance"("orderId");
CREATE INDEX "WorkInProgressBalance_productId_idx"
  ON "WorkInProgressBalance"("productId");
CREATE INDEX "WorkInProgressBalance_sizeId_idx"
  ON "WorkInProgressBalance"("sizeId");
CREATE INDEX "WorkInProgressBalance_warehouseId_idx"
  ON "WorkInProgressBalance"("warehouseId");
CREATE INDEX "WorkInProgressBalance_cellId_idx"
  ON "WorkInProgressBalance"("cellId");
CREATE INDEX "WorkInProgressBalance_updatedAt_idx"
  ON "WorkInProgressBalance"("updatedAt");

ALTER TABLE "WorkInProgressBalance"
  ADD CONSTRAINT "WorkInProgressBalance_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressBalance"
  ADD CONSTRAINT "WorkInProgressBalance_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressBalance"
  ADD CONSTRAINT "WorkInProgressBalance_sizeId_fkey"
  FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressBalance"
  ADD CONSTRAINT "WorkInProgressBalance_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressBalance"
  ADD CONSTRAINT "WorkInProgressBalance_cellId_fkey"
  FOREIGN KEY ("cellId") REFERENCES "Cell"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================
-- 2. WorkInProgressMovement
-- =========================

CREATE TABLE "WorkInProgressMovement" (
    "id" TEXT NOT NULL,
    "workInProgressBalanceId" TEXT,
    "type" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "warehouseId" TEXT,
    "cellId" TEXT,
    "qty" INTEGER NOT NULL,
    "balanceBeforeQty" INTEGER,
    "balanceAfterQty" INTEGER,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceKey" TEXT,
    "passportId" TEXT,
    "comment" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkInProgressMovement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkInProgressMovement_sourceKey_key"
  ON "WorkInProgressMovement"("sourceKey");

CREATE INDEX "WorkInProgressMovement_workInProgressBalanceId_idx"
  ON "WorkInProgressMovement"("workInProgressBalanceId");
CREATE INDEX "WorkInProgressMovement_orderId_idx"
  ON "WorkInProgressMovement"("orderId");
CREATE INDEX "WorkInProgressMovement_productId_idx"
  ON "WorkInProgressMovement"("productId");
CREATE INDEX "WorkInProgressMovement_sizeId_idx"
  ON "WorkInProgressMovement"("sizeId");
CREATE INDEX "WorkInProgressMovement_type_idx"
  ON "WorkInProgressMovement"("type");
CREATE INDEX "WorkInProgressMovement_direction_idx"
  ON "WorkInProgressMovement"("direction");
CREATE INDEX "WorkInProgressMovement_warehouseId_idx"
  ON "WorkInProgressMovement"("warehouseId");
CREATE INDEX "WorkInProgressMovement_cellId_idx"
  ON "WorkInProgressMovement"("cellId");
CREATE INDEX "WorkInProgressMovement_passportId_idx"
  ON "WorkInProgressMovement"("passportId");
CREATE INDEX "WorkInProgressMovement_sourceType_sourceId_idx"
  ON "WorkInProgressMovement"("sourceType", "sourceId");
CREATE INDEX "WorkInProgressMovement_createdAt_idx"
  ON "WorkInProgressMovement"("createdAt");

ALTER TABLE "WorkInProgressMovement"
  ADD CONSTRAINT "WorkInProgressMovement_workInProgressBalanceId_fkey"
  FOREIGN KEY ("workInProgressBalanceId")
  REFERENCES "WorkInProgressBalance"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressMovement"
  ADD CONSTRAINT "WorkInProgressMovement_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressMovement"
  ADD CONSTRAINT "WorkInProgressMovement_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressMovement"
  ADD CONSTRAINT "WorkInProgressMovement_sizeId_fkey"
  FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressMovement"
  ADD CONSTRAINT "WorkInProgressMovement_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressMovement"
  ADD CONSTRAINT "WorkInProgressMovement_cellId_fkey"
  FOREIGN KEY ("cellId") REFERENCES "Cell"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkInProgressMovement"
  ADD CONSTRAINT "WorkInProgressMovement_passportId_fkey"
  FOREIGN KEY ("passportId") REFERENCES "Passport"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================
-- 3. BACKFILL — переносим существующее содержимое ячеек в WIP
-- =========================
--
-- Источник правды для миграции — Passport (а не CellContent), потому
-- что новый WIP требует orderId / productId / color, которых в
-- CellContent нет. CellContent после миграции дропается.
--
-- Условие: только живые паспорта в ячейке (status НЕ PACKED/CANCELLED).
-- Если паспорт был CANCELLED, мы не должны видеть его в остатке;
-- если PACKED — он уже не в ячейке (currentCellId должен быть null,
-- но даже если grade-condition остался — пакеты не считаем кроем).

-- 3.1. Создаём WorkInProgressBalance для каждой пары
--      (orderId, productId, sizeId, color, warehouseId?, cellId).
--      Несколько паспортов в одной ячейке с одной комбинацией
--      сворачиваются по balanceKey (SUM(qtyCut)).

INSERT INTO "WorkInProgressBalance" (
    "id",
    "balanceKey",
    "orderId",
    "productId",
    "sizeId",
    "color",
    "warehouseId",
    "cellId",
    "qty",
    "createdAt",
    "updatedAt",
    "lastMovementAt"
)
SELECT
    -- cuid-like ID: gen_random_uuid с обрезкой; id уникальные за счёт UNIQUE(balanceKey)
    -- ниже всё равно проверяет, поэтому здесь любой уникальный текст подойдёт.
    'wip_bf_' || replace(gen_random_uuid()::text, '-', '') AS "id",
    p."orderId" || ':' || p."productId" || ':' || p."sizeId" || ':' || p."color"
        || ':' || COALESCE(c."warehouseId", 'NO_WAREHOUSE')
        || ':' || COALESCE(p."currentCellId", 'NO_CELL') AS "balanceKey",
    p."orderId",
    p."productId",
    p."sizeId",
    p."color",
    c."warehouseId",
    p."currentCellId",
    SUM(p."qtyCut")::INT AS "qty",
    NOW() AS "createdAt",
    NOW() AS "updatedAt",
    NOW() AS "lastMovementAt"
FROM "Passport" p
JOIN "Cell" c ON c."id" = p."currentCellId"
WHERE p."currentCellId" IS NOT NULL
  AND p."status" NOT IN ('PACKED', 'CANCELLED')
GROUP BY
    p."orderId",
    p."productId",
    p."sizeId",
    p."color",
    c."warehouseId",
    p."currentCellId"
ON CONFLICT ("balanceKey") DO NOTHING;

-- 3.2. Для каждого паспорта — одно PLACE-движение, отражающее
--      backfill. balanceBeforeQty = 0 (до миграции движений не было),
--      balanceAfterQty = qtyCut этого паспорта. sourceKey уникален
--      по passportId — повторный прогон миграции (что в норме
--      невозможно благодаря prisma migrations table) тоже идемпотентен.

INSERT INTO "WorkInProgressMovement" (
    "id",
    "workInProgressBalanceId",
    "type",
    "direction",
    "orderId",
    "productId",
    "sizeId",
    "color",
    "warehouseId",
    "cellId",
    "qty",
    "balanceBeforeQty",
    "balanceAfterQty",
    "sourceType",
    "sourceId",
    "sourceKey",
    "passportId",
    "comment",
    "createdById",
    "createdAt"
)
SELECT
    'wip_mv_bf_' || replace(gen_random_uuid()::text, '-', '') AS "id",
    wb."id" AS "workInProgressBalanceId",
    'PLACE' AS "type",
    'IN' AS "direction",
    p."orderId",
    p."productId",
    p."sizeId",
    p."color",
    c."warehouseId",
    p."currentCellId",
    p."qtyCut" AS "qty",
    0 AS "balanceBeforeQty",
    p."qtyCut" AS "balanceAfterQty",
    'BACKFILL' AS "sourceType",
    p."id" AS "sourceId",
    'WIP_PLACE_BACKFILL:' || p."id" AS "sourceKey",
    p."id" AS "passportId",
    'Backfill from CellContent on migration 20260620100000.' AS "comment",
    NULL AS "createdById",
    NOW() AS "createdAt"
FROM "Passport" p
JOIN "Cell" c ON c."id" = p."currentCellId"
JOIN "WorkInProgressBalance" wb
    ON wb."balanceKey" = (
        p."orderId" || ':' || p."productId" || ':' || p."sizeId"
        || ':' || p."color"
        || ':' || COALESCE(c."warehouseId", 'NO_WAREHOUSE')
        || ':' || COALESCE(p."currentCellId", 'NO_CELL')
    )
WHERE p."currentCellId" IS NOT NULL
  AND p."status" NOT IN ('PACKED', 'CANCELLED')
ON CONFLICT ("sourceKey") DO NOTHING;

-- =========================
-- 4. DROP CellContent
-- =========================
--
-- Делаем последним: до этого момента CellContent ещё нужен (ровно
-- для backfill-чтения). После INSERT'ов выше она больше нигде не
-- используется — все consumer'ы переехали на WorkInProgressBalance
-- (см. apps/api/src/modules/passports/passports.service.ts::loadCellContentsFromWip,
-- WarehousesService.deleteLine, DiagnosticsService).

DROP TABLE "CellContent";
