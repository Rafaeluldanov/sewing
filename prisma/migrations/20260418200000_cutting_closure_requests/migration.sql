-- Cutting closure requests (ADR-0018).
--
-- Управленческое закрытие раскроя по размеру через заявку.
-- Помощник раскройщика подаёт заявку, мастер цеха подтверждает/отклоняет.
-- APPROVED-заявка запрещает выпуск новых паспортов по строке
-- (orderId × productId × sizeId) — backend enforcement в
-- `PassportsService.create`. См. docs/domain.md §15, docs/api.md §14.

-- CreateEnum
CREATE TYPE "CuttingClosureRequestStatus" AS ENUM (
    'REQUESTED',
    'APPROVED',
    'REJECTED'
);

-- CreateTable
CREATE TABLE "CuttingClosureRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "status" "CuttingClosureRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "requestedByEmployeeId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByEmployeeId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuttingClosureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CuttingClosureRequest_orderId_productId_sizeId_idx"
    ON "CuttingClosureRequest"("orderId", "productId", "sizeId");

-- CreateIndex
CREATE INDEX "CuttingClosureRequest_status_requestedAt_idx"
    ON "CuttingClosureRequest"("status", "requestedAt");

-- AddForeignKey
ALTER TABLE "CuttingClosureRequest"
    ADD CONSTRAINT "CuttingClosureRequest_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingClosureRequest"
    ADD CONSTRAINT "CuttingClosureRequest_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingClosureRequest"
    ADD CONSTRAINT "CuttingClosureRequest_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingClosureRequest"
    ADD CONSTRAINT "CuttingClosureRequest_requestedByEmployeeId_fkey"
    FOREIGN KEY ("requestedByEmployeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuttingClosureRequest"
    ADD CONSTRAINT "CuttingClosureRequest_reviewedByEmployeeId_fkey"
    FOREIGN KEY ("reviewedByEmployeeId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial unique indexes: одна REQUESTED и одна APPROVED заявка
-- на конкретную строку (orderId × productId × sizeId).
CREATE UNIQUE INDEX "cutting_closure_request_active_uniq"
    ON "CuttingClosureRequest"("orderId", "productId", "sizeId")
    WHERE "status" = 'REQUESTED';

CREATE UNIQUE INDEX "cutting_closure_request_approved_uniq"
    ON "CuttingClosureRequest"("orderId", "productId", "sizeId")
    WHERE "status" = 'APPROVED';
