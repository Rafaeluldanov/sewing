-- Фаза 1 «Характеристики номенклатуры»: structured-хранение подтипа
-- материала и значений характеристик. Аддитивно, все колонки nullable —
-- существующее поведение не меняется (downstream продолжает читать
-- legacy-колонки densityGsm/plannedWidthCm/hardwareSizeText/...).

ALTER TABLE "TechCardMaterialLine" ADD COLUMN "subtypeKey" TEXT;
ALTER TABLE "TechCardMaterialLine" ADD COLUMN "characteristics" JSONB;

ALTER TABLE "OrderMaterialRequirement" ADD COLUMN "subtypeKey" TEXT;
ALTER TABLE "OrderMaterialRequirement" ADD COLUMN "characteristics" JSONB;

ALTER TABLE "WorkshopNeed" ADD COLUMN "subtypeKey" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "characteristics" JSONB;
