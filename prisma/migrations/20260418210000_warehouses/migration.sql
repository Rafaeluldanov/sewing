-- Warehouses (см. docs/domain.md §16, docs/erd.md §2.13a, docs/api.md §15).
--
-- Управленческая группировка ячеек физического хранения. Связь
-- one-to-many: Warehouse 1..N Cell. Cell.warehouseId nullable — это
-- сознательное решение MVP, чтобы:
--   1. не ломать существующие данные (старые ячейки остаются без склада);
--   2. flow размещения паспорта в ячейку (`POST /api/passports/:id/place`)
--      работал как раньше — он не зависит от warehouseId;
--   3. менеджер мог постепенно «инвентаризировать» цех, привязывая
--      ячейки по мере появления физических складов.

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_name_key" ON "Warehouse"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_code_key" ON "Warehouse"("code");

-- CreateIndex
CREATE INDEX "Warehouse_isActive_idx" ON "Warehouse"("isActive");

-- AlterTable: добавляем nullable warehouseId. Существующие ячейки
-- остаются с NULL — это допустимо (см. комментарий выше).
ALTER TABLE "Cell"
ADD COLUMN "warehouseId" TEXT;

-- CreateIndex
CREATE INDEX "Cell_warehouseId_idx" ON "Cell"("warehouseId");

-- AddForeignKey: ON DELETE SET NULL — удаление склада не уничтожает
-- ячейку (физически она всё ещё существует), просто отвязывает её,
-- чтобы менеджер мог переподвесить.
ALTER TABLE "Cell"
ADD CONSTRAINT "Cell_warehouseId_fkey"
FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
