-- Material issue returns / reversals (см.
--   prisma/schema.prisma::MaterialIssueReturn / MaterialIssueReturnLine,
--   apps/api/src/modules/material-issues/material-issues.service.ts,
--   docs/current-state.md §«Material issue return»).
--
-- На MVP-итерации:
--   - один проведённый MaterialIssue может иметь несколько MaterialIssueReturn
--     (UI сценарий MVP — только полное сторно остатка, но архитектурно
--     возможны частичные возвраты);
--   - sourceKey UNIQUE — защита от двойного submit (полное сторно
--     или повторный clientRequestId);
--   - линии возврата ссылаются на конкретную исходную MaterialIssueLine;
--   - удаление MaterialIssue Cascade сносит и сами возвраты — без
--     исходного расхода возврат теряет смысл.

-- CreateTable
CREATE TABLE "MaterialIssueReturn" (
    "id" TEXT NOT NULL,
    "materialIssueId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "passportId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "sourceKey" TEXT,
    "reason" TEXT NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "MaterialIssueReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialIssueReturnLine" (
    "id" TEXT NOT NULL,
    "materialIssueReturnId" TEXT NOT NULL,
    "materialIssueLineId" TEXT NOT NULL,
    "workshopNeedId" TEXT,
    "description" TEXT NOT NULL,
    "materialRole" TEXT,
    "unit" TEXT NOT NULL,
    "returnedQty" DECIMAL(14,4) NOT NULL,
    "unitCost" DECIMAL(14,2) NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "cellId" TEXT,
    "comment" TEXT,

    CONSTRAINT "MaterialIssueReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialIssueReturn_sourceKey_key" ON "MaterialIssueReturn"("sourceKey");

-- CreateIndex
CREATE INDEX "MaterialIssueReturn_materialIssueId_idx" ON "MaterialIssueReturn"("materialIssueId");

-- CreateIndex
CREATE INDEX "MaterialIssueReturn_orderId_idx" ON "MaterialIssueReturn"("orderId");

-- CreateIndex
CREATE INDEX "MaterialIssueReturn_passportId_idx" ON "MaterialIssueReturn"("passportId");

-- CreateIndex
CREATE INDEX "MaterialIssueReturn_status_idx" ON "MaterialIssueReturn"("status");

-- CreateIndex
CREATE INDEX "MaterialIssueReturn_createdAt_idx" ON "MaterialIssueReturn"("createdAt");

-- CreateIndex
CREATE INDEX "MaterialIssueReturnLine_materialIssueReturnId_idx" ON "MaterialIssueReturnLine"("materialIssueReturnId");

-- CreateIndex
CREATE INDEX "MaterialIssueReturnLine_materialIssueLineId_idx" ON "MaterialIssueReturnLine"("materialIssueLineId");

-- CreateIndex
CREATE INDEX "MaterialIssueReturnLine_workshopNeedId_idx" ON "MaterialIssueReturnLine"("workshopNeedId");

-- CreateIndex
CREATE INDEX "MaterialIssueReturnLine_cellId_idx" ON "MaterialIssueReturnLine"("cellId");

-- AddForeignKey
ALTER TABLE "MaterialIssueReturn" ADD CONSTRAINT "MaterialIssueReturn_materialIssueId_fkey" FOREIGN KEY ("materialIssueId") REFERENCES "MaterialIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialIssueReturn" ADD CONSTRAINT "MaterialIssueReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialIssueReturn" ADD CONSTRAINT "MaterialIssueReturn_passportId_fkey" FOREIGN KEY ("passportId") REFERENCES "Passport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialIssueReturnLine" ADD CONSTRAINT "MaterialIssueReturnLine_materialIssueReturnId_fkey" FOREIGN KEY ("materialIssueReturnId") REFERENCES "MaterialIssueReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialIssueReturnLine" ADD CONSTRAINT "MaterialIssueReturnLine_materialIssueLineId_fkey" FOREIGN KEY ("materialIssueLineId") REFERENCES "MaterialIssueLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialIssueReturnLine" ADD CONSTRAINT "MaterialIssueReturnLine_workshopNeedId_fkey" FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialIssueReturnLine" ADD CONSTRAINT "MaterialIssueReturnLine_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "Cell"("id") ON DELETE SET NULL ON UPDATE CASCADE;
