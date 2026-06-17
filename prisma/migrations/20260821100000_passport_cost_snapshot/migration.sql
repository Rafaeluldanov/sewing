-- CreateTable
CREATE TABLE "PassportCostSnapshot" (
    "id" TEXT NOT NULL,
    "passportId" TEXT NOT NULL,
    "qtyGood" INTEGER NOT NULL,
    "materialCostRub" DECIMAL(12,2) NOT NULL,
    "pieceworkCostRub" DECIMAL(12,2) NOT NULL,
    "salaryCostRub" DECIMAL(12,2) NOT NULL,
    "totalCostRub" DECIMAL(12,2) NOT NULL,
    "perUnitCostRub" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PRELIMINARY',
    "packedDate" DATE NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassportCostSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PassportCostSnapshot_passportId_key" ON "PassportCostSnapshot"("passportId");

-- CreateIndex
CREATE INDEX "PassportCostSnapshot_packedDate_status_idx" ON "PassportCostSnapshot"("packedDate", "status");

-- AddForeignKey
ALTER TABLE "PassportCostSnapshot" ADD CONSTRAINT "PassportCostSnapshot_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
