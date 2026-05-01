-- Operation pricing model (управленческий блок «Операции»).
--
-- См. `docs/domain.md §16a`, `docs/api.md §15a`, `docs/screens.md §10c`.
--
-- Что добавляем (additive):
--   1. Enum `PricingMode` (FIXED | BY_SIZE | SALARY_ONLY).
--   2. Колонки `Operation.pricingMode`, `Operation.fixedRate`,
--      `Operation.updatedAt`.
--   3. Таблица `OperationRateBySize` с уникальным
--      `(operationId, sizeId)`.
--
-- Что НЕ трогаем:
--   - `PieceRate` — продолжает существовать как историческая таблица
--     (см. ADR-0005). Backfill ниже копирует «свежие» базовые ставки
--     `(operationId, sizeId, productId=null, validTo=null)` в новый
--     источник истины. Этого достаточно для существующего seed
--     `prisma/seed.ts` (там все рабочие ставки задаются именно так).
--   - PassportEvent / OperationEntry — на ставки больше не смотрят
--     ретроспективно: уже посчитанные начисления хранят свой
--     `ratePerUnit` в строке.
--
-- Backfill-стратегия (см. `OperationsService.resolveRate`):
--   - Если у операции есть >=2 различных активных ставок по размерам —
--     ставим `pricingMode = BY_SIZE`, `fixedRate = NULL`, копируем
--     все ставки в `OperationRateBySize`.
--   - Если у операции все активные ставки одинаковы — ставим
--     `pricingMode = FIXED`, `fixedRate = <общая ставка>`,
--     `OperationRateBySize` НЕ заполняем.
--   - Если у операции вообще нет активных ставок — оставляем
--     дефолт `pricingMode = SALARY_ONLY`, `fixedRate = NULL`.
--
-- Это бережно сохраняет текущее поведение: `EarningsService`
-- начислял зарплату только тем операциям, у которых были `PieceRate`
-- (через `isPieceworkOperationCode` в коде); все «окладные»
-- (CUT_PATTERN_PRINT, CUT_SPREADING, CUT_DIVISION, CUT_BASE_PREP,
-- CUT_RIBANA_PREP, CUT_ISSUE, QC, WTO, PACKING) и без ставок
-- автоматически получают `SALARY_ONLY`.

-- =============================================================
-- 1. Enum PricingMode
-- =============================================================

CREATE TYPE "PricingMode" AS ENUM ('FIXED', 'BY_SIZE', 'SALARY_ONLY');

-- =============================================================
-- 2. ALTER Operation: pricingMode, fixedRate, updatedAt
-- =============================================================

ALTER TABLE "Operation"
    ADD COLUMN "pricingMode" "PricingMode" NOT NULL DEFAULT 'SALARY_ONLY',
    ADD COLUMN "fixedRate" DECIMAL(12,2),
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill `updatedAt` на момент создания, чтобы UI «когда настраивалось
-- последний раз» не показывал свежий timestamp у операций, к которым
-- никто не прикасался.
UPDATE "Operation" SET "updatedAt" = "createdAt";

CREATE INDEX "Operation_pricingMode_idx" ON "Operation"("pricingMode");

-- =============================================================
-- 3. CREATE TABLE OperationRateBySize
-- =============================================================

CREATE TABLE "OperationRateBySize" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationRateBySize_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationRateBySize_operationId_sizeId_key"
    ON "OperationRateBySize"("operationId", "sizeId");

CREATE INDEX "OperationRateBySize_operationId_idx"
    ON "OperationRateBySize"("operationId");

CREATE INDEX "OperationRateBySize_sizeId_idx"
    ON "OperationRateBySize"("sizeId");

ALTER TABLE "OperationRateBySize"
    ADD CONSTRAINT "OperationRateBySize_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "Operation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OperationRateBySize"
    ADD CONSTRAINT "OperationRateBySize_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- 4. Backfill из PieceRate
-- =============================================================
--
-- Берём «свежую» базовую ставку: `productId IS NULL`, `validTo IS NULL`,
-- максимальный `validFrom` <= now() для каждого `(operationId, sizeId)`.
-- Это соответствует тому, как `EarningsService.findRate` искал ставку
-- до этой миграции.
--
-- Шаг 4.1. Заполняем `OperationRateBySize` копией активных ставок.

INSERT INTO "OperationRateBySize" ("id", "operationId", "sizeId", "rate", "createdAt", "updatedAt")
SELECT
    -- Простой стабильный id: `op:<operationId>:<sizeId>`. Никаких CUID
    -- здесь не нужно — backfill идёт ровно один раз.
    'orbs_' || pr."operationId" || '_' || pr."sizeId" AS "id",
    pr."operationId",
    pr."sizeId",
    pr."ratePerUnit" AS "rate",
    NOW() AS "createdAt",
    NOW() AS "updatedAt"
FROM "PieceRate" pr
INNER JOIN (
    -- Самый свежий validFrom на пару (operationId, sizeId) среди
    -- активных (validTo IS NULL) и без привязки к продукту.
    SELECT
        "operationId",
        "sizeId",
        MAX("validFrom") AS "max_valid_from"
    FROM "PieceRate"
    WHERE "productId" IS NULL
      AND "sizeId" IS NOT NULL
      AND "validTo" IS NULL
      AND "validFrom" <= NOW()
    GROUP BY "operationId", "sizeId"
) latest
    ON latest."operationId" = pr."operationId"
   AND latest."sizeId"      = pr."sizeId"
   AND latest."max_valid_from" = pr."validFrom"
WHERE pr."productId" IS NULL
  AND pr."sizeId" IS NOT NULL
  AND pr."validTo" IS NULL
ON CONFLICT ("operationId", "sizeId") DO NOTHING;

-- Шаг 4.2. Определяем pricingMode на основе разнообразия ставок:
--
--   - >=2 различных ставок → BY_SIZE,
--   - все ставки одинаковы → FIXED + fixedRate = эта ставка,
--   - нет ставок                → SALARY_ONLY (дефолт, ничего не делаем).
--
-- Делаем одним UPDATE через CTE с агрегатом по `OperationRateBySize`.

WITH op_stats AS (
    SELECT
        "operationId",
        COUNT(DISTINCT "rate") AS "distinct_rates",
        MIN("rate")            AS "any_rate",
        COUNT(*)               AS "total_rows"
    FROM "OperationRateBySize"
    GROUP BY "operationId"
)
UPDATE "Operation" o
SET
    "pricingMode" = CASE
        WHEN s."distinct_rates" >= 2 THEN 'BY_SIZE'::"PricingMode"
        WHEN s."distinct_rates" = 1 THEN 'FIXED'::"PricingMode"
        ELSE o."pricingMode"
    END,
    "fixedRate" = CASE
        WHEN s."distinct_rates" = 1 THEN s."any_rate"
        ELSE NULL
    END,
    "updatedAt" = NOW()
FROM op_stats s
WHERE s."operationId" = o."id";

-- Шаг 4.3. Для FIXED-операций нет смысла держать BY_SIZE-строки —
-- они только запутают `/admin/operations`. Удаляем их в рамках
-- backfill, чтобы инвариант UI «BY_SIZE => есть ставки по размерам,
-- FIXED => нет ставок по размерам» держался с первого дня.

DELETE FROM "OperationRateBySize" rs
USING "Operation" o
WHERE rs."operationId" = o."id"
  AND o."pricingMode" = 'FIXED';
