-- Per-order overrides расценки и нормы времени операций маршрута.
-- Действуют ТОЛЬКО внутри заказа: справочники Operation /
-- OperationRateBySize / OperationTimeNormBySize / RouteTemplateStep не
-- меняются. Аддитивная миграция, все поля nullable.

-- FIXED-режимы: единичная норма времени per-order (расценка rateOverride
-- уже добавлена миграцией 20260819100000).
ALTER TABLE "OrderRouteStep"
  ADD COLUMN IF NOT EXISTS "timeNormSecOverride" INTEGER;

-- BY_SIZE-режимы: поразмерные переопределения расценки/нормы в рамках заказа.
CREATE TABLE IF NOT EXISTS "OrderRouteStepSizeOverride" (
    "id" TEXT NOT NULL,
    "orderRouteStepId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "rate" DECIMAL(12,2),
    "seconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderRouteStepSizeOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderRouteStepSizeOverride_step_size_uniq"
  ON "OrderRouteStepSizeOverride"("orderRouteStepId", "sizeId");
CREATE INDEX IF NOT EXISTS "OrderRouteStepSizeOverride_orderRouteStepId_idx"
  ON "OrderRouteStepSizeOverride"("orderRouteStepId");
CREATE INDEX IF NOT EXISTS "OrderRouteStepSizeOverride_sizeId_idx"
  ON "OrderRouteStepSizeOverride"("sizeId");

DO $$ BEGIN
  ALTER TABLE "OrderRouteStepSizeOverride"
    ADD CONSTRAINT "OrderRouteStepSizeOverride_orderRouteStepId_fkey"
    FOREIGN KEY ("orderRouteStepId") REFERENCES "OrderRouteStep"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "OrderRouteStepSizeOverride"
    ADD CONSTRAINT "OrderRouteStepSizeOverride_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
