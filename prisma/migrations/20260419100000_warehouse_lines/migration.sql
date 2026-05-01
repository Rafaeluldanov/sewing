-- Линии склада + поле labelTemplate (см. docs/domain.md §16, docs/api.md §15).
--
-- Назначение: массовый инструмент создания ячеек через «линию».
-- Менеджер вводит код линии (например, `A`) и количество (20),
-- система создаёт `WarehouseLine` и в той же транзакции `Cell`
-- A1..A20 (см. POST /api/warehouses/:id/lines).
--
-- Дизайн-решения:
--   1. `WarehouseLine.code` — глобально UNIQUE: оператор использует
--      одно короткое значение для идентификации линии без склада.
--   2. `Cell.lineId` / `Cell.lineIndex` — nullable: исторические
--      ячейки и ячейки, созданные не через линию, продолжают жить
--      без привязки. Flow размещения паспорта (`POST /api/passports/:id/place`)
--      не зависит от lineId — это управленческая группировка
--      (как и warehouseId, см. ADR-0019).
--   3. ON DELETE SET NULL для FK Cell→WarehouseLine: удаление линии
--      не уничтожает ячейки, просто отвязывает (физически они всё ещё
--      существуют и могут быть переподвешены).
--   4. UNIQUE(lineId, lineIndex) — гарантирует, что внутри одной
--      линии не может быть двух ячеек с одинаковым порядковым номером.
--      NULL допускается множественно (исторические ячейки), Postgres
--      по умолчанию трактует NULL в UNIQUE как «не равны».
--   5. `Warehouse.labelTemplate` — TEXT, без рендера на этом шаге:
--      просто хранилище шаблона. Бизнес-логика рендера наклеек
--      появится позже.

-- CreateTable
CREATE TABLE "WarehouseLine" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (глобально уникальный код линии)
CREATE UNIQUE INDEX "WarehouseLine_code_key" ON "WarehouseLine"("code");

-- CreateIndex
CREATE INDEX "WarehouseLine_warehouseId_idx" ON "WarehouseLine"("warehouseId");

-- AddForeignKey
ALTER TABLE "WarehouseLine"
ADD CONSTRAINT "WarehouseLine_warehouseId_fkey"
FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: добавляем lineId / lineIndex и labelTemplate.
ALTER TABLE "Cell"
ADD COLUMN "lineId" TEXT,
ADD COLUMN "lineIndex" INTEGER;

ALTER TABLE "Warehouse"
ADD COLUMN "labelTemplate" TEXT;

-- CreateIndex
CREATE INDEX "Cell_lineId_idx" ON "Cell"("lineId");

-- CreateIndex (внутри линии порядковый номер уникален)
CREATE UNIQUE INDEX "Cell_lineId_lineIndex_key" ON "Cell"("lineId", "lineIndex");

-- AddForeignKey: ON DELETE SET NULL — удаление линии не уничтожает ячейки.
ALTER TABLE "Cell"
ADD CONSTRAINT "Cell_lineId_fkey"
FOREIGN KEY ("lineId") REFERENCES "WarehouseLine"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
