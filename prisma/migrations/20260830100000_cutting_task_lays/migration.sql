-- Многораскладный раскрой: в одном заказе раскройщик делает несколько
-- раскладов (`CuttingTaskLay`), у каждого свой набор размеров с «на
-- настиле» (`CuttingTaskLaySize`) и свои рулоны (`CuttingTaskRoll`).
--
-- Что меняется:
--   * новые таблицы `CuttingTaskLay`, `CuttingTaskLaySize`;
--   * `CuttingTaskRoll.taskId` → `layId` (рулоны переезжают под расклад);
--   * `CuttingTaskSizeRow.perLayerQty` удаляется (переезжает в laySize);
--   * `Passport.cuttingLayOrdinal` — из какого расклада выпущен рулон.
--
-- Бэкфилл существующих данных: каждая задача оборачивается в один
-- «Расклад 1» (ordinal=1), её строки-размеры и рулоны переносятся туда,
-- выпущенным паспортам проставляется cuttingLayOrdinal=1 (старый
-- единственный расклад).

-- 1. Таблица раскладов -------------------------------------------------------
CREATE TABLE "CuttingTaskLay" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CuttingTaskLay_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CuttingTaskLay_taskId_ordinal_key" ON "CuttingTaskLay"("taskId", "ordinal");
CREATE INDEX "CuttingTaskLay_taskId_ordinal_idx" ON "CuttingTaskLay"("taskId", "ordinal");
ALTER TABLE "CuttingTaskLay" ADD CONSTRAINT "CuttingTaskLay_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "CuttingTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Бэкфилл: «Расклад 1» на каждую существующую задачу. Детерминированный
-- id ('lay1_' || taskId) — уникален, т.к. на задачу один расклад.
INSERT INTO "CuttingTaskLay" ("id", "taskId", "ordinal", "createdAt")
SELECT 'lay1_' || "id", "id", 1, CURRENT_TIMESTAMP
FROM "CuttingTask";

-- 2. Размеры расклада --------------------------------------------------------
CREATE TABLE "CuttingTaskLaySize" (
    "id" TEXT NOT NULL,
    "layId" TEXT NOT NULL,
    "sizeId" TEXT,
    "sizeCodeSnapshot" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "perLayerQty" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CuttingTaskLaySize_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CuttingTaskLaySize_layId_sizeId_key" ON "CuttingTaskLaySize"("layId", "sizeId");
CREATE INDEX "CuttingTaskLaySize_layId_sortOrder_idx" ON "CuttingTaskLaySize"("layId", "sortOrder");
ALTER TABLE "CuttingTaskLaySize" ADD CONSTRAINT "CuttingTaskLaySize_layId_fkey"
    FOREIGN KEY ("layId") REFERENCES "CuttingTaskLay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CuttingTaskLaySize" ADD CONSTRAINT "CuttingTaskLaySize_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Бэкфилл: строки-размеры существующих задач (включая perLayerQty=0)
-- переносятся в «Расклад 1». Размеры с perLayerQty=0 ведут себя как
-- раньше (вклад в итог 0).
INSERT INTO "CuttingTaskLaySize" ("id", "layId", "sizeId", "sizeCodeSnapshot", "sortOrder", "perLayerQty")
SELECT 'lsz_' || "id", 'lay1_' || "taskId", "sizeId", "sizeCodeSnapshot", "sortOrder", "perLayerQty"
FROM "CuttingTaskSizeRow";

-- 3. Рулоны переезжают под расклад -------------------------------------------
ALTER TABLE "CuttingTaskRoll" ADD COLUMN "layId" TEXT;
UPDATE "CuttingTaskRoll" SET "layId" = 'lay1_' || "taskId";

ALTER TABLE "CuttingTaskRoll" DROP CONSTRAINT "CuttingTaskRoll_taskId_fkey";
DROP INDEX "CuttingTaskRoll_taskId_ordinal_key";
DROP INDEX "CuttingTaskRoll_taskId_ordinal_idx";
ALTER TABLE "CuttingTaskRoll" DROP COLUMN "taskId";

ALTER TABLE "CuttingTaskRoll" ALTER COLUMN "layId" SET NOT NULL;
CREATE UNIQUE INDEX "CuttingTaskRoll_layId_ordinal_key" ON "CuttingTaskRoll"("layId", "ordinal");
CREATE INDEX "CuttingTaskRoll_layId_ordinal_idx" ON "CuttingTaskRoll"("layId", "ordinal");
ALTER TABLE "CuttingTaskRoll" ADD CONSTRAINT "CuttingTaskRoll_layId_fkey"
    FOREIGN KEY ("layId") REFERENCES "CuttingTaskLay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. perLayerQty уходит со строки-размера задачи (теперь это laySize) --------
ALTER TABLE "CuttingTaskSizeRow" DROP COLUMN "perLayerQty";

-- 5. Расклад на паспорте + бэкфилл выпущенных --------------------------------
ALTER TABLE "Passport" ADD COLUMN "cuttingLayOrdinal" INTEGER;
UPDATE "Passport" SET "cuttingLayOrdinal" = 1 WHERE "rollOrdinal" IS NOT NULL;

DROP INDEX IF EXISTS "Passport_orderId_sizeId_rollOrdinal_idx";
CREATE INDEX "Passport_orderId_sizeId_cuttingLayOrdinal_rollOrdinal_idx"
    ON "Passport"("orderId", "sizeId", "cuttingLayOrdinal", "rollOrdinal");
