-- MVP «Печать по рабочему месту через агент» (см. docs/domain.md §17,
-- docs/api.md §16). Полностью additive: ничего не ломаем, существующие
-- печатные endpoint-ы (`/api/passports/:id/print`,
-- `/api/passports/:id/qr`, `/api/packing/boxes/:id/label`,
-- `/api/cells/:id/qr`) остаются и используются как `payloadUrl`.
--
-- Что добавляем:
--   1. Enum-ы PrinterType, PrintJobStatus, PrintJobSource.
--   2. Таблица "Printer" (имя, тип, привязка к Equipment, pairingCode,
--      agentToken, isOnline, lastSeenAt).
--   3. Таблица "PrintJob" (printerId, sourceType, sourceId, payloadUrl,
--      status, errorMessage, completedAt).
--   4. Индексы для быстрого поиска агентом и UI.

-- =============================================================
-- 1. Enums
-- =============================================================

CREATE TYPE "PrinterType" AS ENUM ('PASSPORT', 'QR', 'LABEL', 'DEFAULT');
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'PRINTED', 'FAILED');
CREATE TYPE "PrintJobSource" AS ENUM (
    'PASSPORT_QR',
    'PASSPORT_PRINT',
    'BOX_LABEL',
    'CELL_QR',
    'TEST'
);

-- =============================================================
-- 2. CREATE TABLE Printer
-- =============================================================

CREATE TABLE "Printer" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "type"        "PrinterType" NOT NULL DEFAULT 'DEFAULT',
    "equipmentId" TEXT,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "pairingCode" TEXT,
    "agentToken"  TEXT,
    "isOnline"    BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Printer_equipmentId_isActive_idx"
    ON "Printer"("equipmentId", "isActive");
CREATE INDEX "Printer_isOnline_idx" ON "Printer"("isOnline");
CREATE INDEX "Printer_pairingCode_idx" ON "Printer"("pairingCode");
CREATE INDEX "Printer_agentToken_idx" ON "Printer"("agentToken");

ALTER TABLE "Printer"
    ADD CONSTRAINT "Printer_equipmentId_fkey"
    FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================
-- 3. CREATE TABLE PrintJob
-- =============================================================

CREATE TABLE "PrintJob" (
    "id"           TEXT NOT NULL,
    "printerId"    TEXT NOT NULL,
    "sourceType"   "PrintJobSource" NOT NULL,
    "sourceId"     TEXT,
    "payloadUrl"   TEXT NOT NULL,
    "status"       "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"  TIMESTAMP(3),

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrintJob_printerId_status_createdAt_idx"
    ON "PrintJob"("printerId", "status", "createdAt");
CREATE INDEX "PrintJob_status_createdAt_idx"
    ON "PrintJob"("status", "createdAt");

ALTER TABLE "PrintJob"
    ADD CONSTRAINT "PrintJob_printerId_fkey"
    FOREIGN KEY ("printerId") REFERENCES "Printer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
