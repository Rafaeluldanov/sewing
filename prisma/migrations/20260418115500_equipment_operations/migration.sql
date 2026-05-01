-- Equipment-Operation many-to-many configuration (ADR-0017).
--
-- До этой миграции связь «оборудование → разрешённые операции»
-- хранилась только во фронтовом mapping по префиксу `Equipment.code`.
-- Теперь это явная таблица: backend = source of truth, /work читает
-- набор из неё, админ управляет через `/admin/equipment`.

-- CreateTable
CREATE TABLE "EquipmentOperation" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentOperation_equipmentId_operationId_key" ON "EquipmentOperation"("equipmentId", "operationId");

-- CreateIndex
CREATE INDEX "EquipmentOperation_equipmentId_sortOrder_idx" ON "EquipmentOperation"("equipmentId", "sortOrder");

-- CreateIndex
CREATE INDEX "EquipmentOperation_operationId_idx" ON "EquipmentOperation"("operationId");

-- AddForeignKey
ALTER TABLE "EquipmentOperation" ADD CONSTRAINT "EquipmentOperation_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentOperation" ADD CONSTRAINT "EquipmentOperation_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
