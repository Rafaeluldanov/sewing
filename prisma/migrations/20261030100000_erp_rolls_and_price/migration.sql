-- Лестница остатков, шаг 4: номенклатура/цена ERP на потребности, рулон ERP на настиле и паспорте.
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpNomenclatureId" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpCharacteristicId" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpUnitId" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "erpUnitPriceRub" DECIMAL(14,4);
ALTER TABLE "CuttingTaskRoll" ADD COLUMN "erpSeriesId" TEXT;
ALTER TABLE "CuttingTaskRoll" ADD COLUMN "erpRollLabel" TEXT;
ALTER TABLE "Passport" ADD COLUMN "erpSeriesId" TEXT;
ALTER TABLE "Passport" ADD COLUMN "erpRollLabel" TEXT;
