-- Ф3 «Расцветки в раскрое» (флаг FEATURE_COLORWAYS): цвет на рулоне.
-- Настил многоцветный — на один стол кладут разноцветные рулоны и режут
-- одним маркером; каждый рулон = один цвет (`CuttingTaskRoll.variantId`).
-- Паспорта, выпущенные из рулона, красятся в цвет его расцветки. Маркер
-- (`CuttingTaskLaySize.perLayerQty`) остаётся общим на настил.
--
-- Аддитивно и обратимо: колонка nullable, `onDelete: SetNull`. Бэкфилл
-- проставляет существующим рулонам расцветку #0 их заказа (зеркало
-- `Order.color`), чтобы выпуск по цвету рулона совпал с прежним поведением.

-- AlterTable
ALTER TABLE "CuttingTaskRoll" ADD COLUMN     "variantId" TEXT;

-- CreateIndex
CREATE INDEX "CuttingTaskRoll_variantId_idx" ON "CuttingTaskRoll"("variantId");

-- AddForeignKey
ALTER TABLE "CuttingTaskRoll" ADD CONSTRAINT "CuttingTaskRoll_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "OrderVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Бэкфилл: рулон → расцветка #0 своего заказа
-- (CuttingTaskRoll → CuttingTaskLay → CuttingTask → Order → OrderVariant#0).
UPDATE "CuttingTaskRoll" r
SET "variantId" = v."id"
FROM "CuttingTaskLay" lay
JOIN "CuttingTask" t ON t."id" = lay."taskId"
JOIN "OrderVariant" v ON v."orderId" = t."orderId" AND v."ordinal" = 0
WHERE r."layId" = lay."id" AND r."variantId" IS NULL;
