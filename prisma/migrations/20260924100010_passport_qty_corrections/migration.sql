-- Корректировка фактического количества по паспорту (ОТК → мастер цеха).
--
-- ОТК на `/qc` предлагает новое фактическое количество (`qtyAfter`),
-- мастер цеха (`SHOPFLOOR_MASTER`) на `/master` подтверждает/отклоняет.
-- В момент APPROVED двигаются `Passport.qtyCut`/`qtyGood` на разницу,
-- пересчитывается сдельная ЗП (швеи + раскройщик), пишется
-- `PassportEvent(QTY_CORRECTED)`. Одна открытая (PENDING) заявка на
-- паспорт — частичный уникальный индекс. См.
-- `apps/api/src/modules/passport-qty-corrections/*`.

-- CreateEnum
CREATE TYPE "PassportQtyCorrectionStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);

-- CreateTable
CREATE TABLE "PassportQtyCorrection" (
    "id" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "status" "PassportQtyCorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "qtyBefore" INTEGER NOT NULL,
    "qtyAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "requestedByEmployeeId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByEmployeeId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassportQtyCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PassportQtyCorrection_passportId_requestedAt_idx"
    ON "PassportQtyCorrection"("passportId", "requestedAt");

-- CreateIndex
CREATE INDEX "PassportQtyCorrection_status_requestedAt_idx"
    ON "PassportQtyCorrection"("status", "requestedAt");

-- AddForeignKey
ALTER TABLE "PassportQtyCorrection"
    ADD CONSTRAINT "PassportQtyCorrection_passportId_fkey"
    FOREIGN KEY ("passportId") REFERENCES "Passport"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportQtyCorrection"
    ADD CONSTRAINT "PassportQtyCorrection_requestedByEmployeeId_fkey"
    FOREIGN KEY ("requestedByEmployeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportQtyCorrection"
    ADD CONSTRAINT "PassportQtyCorrection_reviewedByEmployeeId_fkey"
    FOREIGN KEY ("reviewedByEmployeeId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial unique index: одна открытая (PENDING) заявка на паспорт.
CREATE UNIQUE INDEX "passport_qty_correction_pending_uniq"
    ON "PassportQtyCorrection"("passportId")
    WHERE "status" = 'PENDING';
