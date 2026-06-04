-- Фундамент автосворачивания сплит-маршрута распошива.
--
-- 1) PassportEvent.equipmentId — станок, на котором фактически шла операция
--    (берётся из активной ShiftSession в момент события). Nullable, без
--    бэкфилла: старые/системные события остаются без станка.
-- 2) OperationSubstitution.isReceivingStation — помечает «принимающую»
--    операцию параллельной группы (рукав, code=16): её станок продолжает
--    работать, когда сломан выделенный станок другой операции (низ, 0001).

-- AlterTable
ALTER TABLE "PassportEvent" ADD COLUMN "equipmentId" TEXT;

-- AlterTable
ALTER TABLE "OperationSubstitution" ADD COLUMN "isReceivingStation" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "PassportEvent_operationId_equipmentId_idx" ON "PassportEvent"("operationId", "equipmentId");

-- AddForeignKey
ALTER TABLE "PassportEvent" ADD CONSTRAINT "PassportEvent_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Пометить рукав (code='16') как принимающую станцию в существующей паре
-- substitution (16 ← 04). Лук-ап по code — id-шники на проде и dev разные;
-- если операции 16 нет, UPDATE просто ничего не затронет.
UPDATE "OperationSubstitution" os
SET "isReceivingStation" = true
FROM "Operation" sat
WHERE os."satisfiesOpId" = sat.id
  AND sat.code = '16';
