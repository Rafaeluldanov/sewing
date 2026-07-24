-- Фича «Расцветки» (аудит P5): паспорт хранит расцветку рулона, из
-- которого выпущен (`CuttingTaskRoll.variantId`). Нужна, чтобы
-- авто-списание кроя (`MaterialIssuesService.createAutoCutIssueForPassport`)
-- брало потребности цеха и знаменатель ИМЕННО этой расцветки, а не
-- размазывало материал каждой расцветки по каждому паспорту (числитель по
-- расцветке ÷ знаменатель по всему заказу). `null` = одноцветный / ручной /
-- исторический выпуск — списание по заказу целиком, как до фичи.

-- AlterTable
ALTER TABLE "Passport" ADD COLUMN "orderVariantId" TEXT;

-- CreateIndex
CREATE INDEX "Passport_orderVariantId_idx" ON "Passport"("orderVariantId");

-- AddForeignKey
ALTER TABLE "Passport" ADD CONSTRAINT "Passport_orderVariantId_fkey" FOREIGN KEY ("orderVariantId") REFERENCES "OrderVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (best-effort): привязать существующие паспорта к расцветке по
-- цвету. `Passport.color` = normalizeColor(variant.color) (trim + схлопывание
-- пробелов + lower), поэтому сравниваем нормализованно. Проставляем только
-- когда цвет ОДНОЗНАЧНО указывает на одну расцветку заказа; неоднозначные /
-- несовпавшие остаются NULL → авто-списание для них работает по заказу
-- целиком (прежнее поведение, без регрессии). Уже раскроенные/списанные
-- паспорта это задним числом не пересписывает — влияет только на будущие
-- авто-списания ещё не ушедших с кроя паспортов.
UPDATE "Passport" p
SET "orderVariantId" = v."id"
FROM "OrderVariant" v
WHERE v."orderId" = p."orderId"
  AND lower(btrim(regexp_replace(v."color", '\s+', ' ', 'g'))) = p."color"
  AND (
    SELECT count(*)
    FROM "OrderVariant" v2
    WHERE v2."orderId" = p."orderId"
      AND lower(btrim(regexp_replace(v2."color", '\s+', ' ', 'g'))) = p."color"
  ) = 1;
