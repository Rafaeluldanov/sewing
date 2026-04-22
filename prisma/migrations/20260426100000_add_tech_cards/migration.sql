-- Tech cards (MVP, ADR-0022) — см. docs/domain.md §«Техкарты», docs/erd.md
-- §«Tech cards», docs/api.md §«tech-cards».
--
-- Изменение чисто additive: ни одна существующая колонка не меняет
-- семантику, ни один новый NOT NULL без DEFAULT не появляется на
-- существующих таблицах.
--
--   - `TechCardTemplate`         — шаблон техкарты (управленческий справочник).
--   - `TechCardMaterialLine`     — упорядоченные строки материалов.
--   - `TechCardOutsourceLine`    — упорядоченные строки внешних
--                                  подрядных размещений (OUTSOURCED_SERVICE).
--   - `Order.techCardId`         — опциональная привязка к шаблону до
--                                  запуска (nullable, FK ON DELETE SET NULL).
--   - `OrderMaterialRequirement` — snapshot материалов на конкретном
--                                  заказе, создаётся в `OrdersService.start()`.
--   - `OrderOutsourceRequirement` — snapshot внешних подрядных размещений
--                                  на конкретном заказе.
--
-- `sourceTechCardLineId` в snapshot-ах хранит nullable FK с `ON DELETE
-- SET NULL`: snapshot не удаляется вместе с источником и продолжает жить
-- независимо от того, что менеджер делает с шаблоном после старта заказа
-- (см. ADR-0022 §«snapshot independence»).

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "techCardId" TEXT;

-- CreateTable
CREATE TABLE "TechCardTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechCardTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechCardMaterialLine" (
    "id" TEXT NOT NULL,
    "techCardId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyPerUnit" DECIMAL(12,4) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechCardMaterialLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechCardOutsourceLine" (
    "id" TEXT NOT NULL,
    "techCardId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "qtyPerUnit" DECIMAL(12,4),
    "vendorName" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechCardOutsourceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMaterialRequirement" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sourceTechCardLineId" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyPerUnit" DECIMAL(12,4) NOT NULL,
    "totalQty" DECIMAL(12,4) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderMaterialRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderOutsourceRequirement" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sourceTechCardLineId" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "qtyPerUnit" DECIMAL(12,4),
    "totalQty" DECIMAL(12,4),
    "vendorName" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderOutsourceRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TechCardTemplate_code_key" ON "TechCardTemplate"("code");

-- CreateIndex
CREATE INDEX "TechCardTemplate_isActive_idx" ON "TechCardTemplate"("isActive");

-- CreateIndex
CREATE INDEX "TechCardMaterialLine_techCardId_sortOrder_idx" ON "TechCardMaterialLine"("techCardId", "sortOrder");

-- CreateIndex
CREATE INDEX "TechCardOutsourceLine_techCardId_sortOrder_idx" ON "TechCardOutsourceLine"("techCardId", "sortOrder");

-- CreateIndex
CREATE INDEX "OrderMaterialRequirement_orderId_sortOrder_idx" ON "OrderMaterialRequirement"("orderId", "sortOrder");

-- CreateIndex
CREATE INDEX "OrderMaterialRequirement_sourceTechCardLineId_idx" ON "OrderMaterialRequirement"("sourceTechCardLineId");

-- CreateIndex
CREATE INDEX "OrderOutsourceRequirement_orderId_sortOrder_idx" ON "OrderOutsourceRequirement"("orderId", "sortOrder");

-- CreateIndex
CREATE INDEX "OrderOutsourceRequirement_sourceTechCardLineId_idx" ON "OrderOutsourceRequirement"("sourceTechCardLineId");

-- CreateIndex
CREATE INDEX "Order_techCardId_idx" ON "Order"("techCardId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_techCardId_fkey" FOREIGN KEY ("techCardId") REFERENCES "TechCardTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechCardMaterialLine" ADD CONSTRAINT "TechCardMaterialLine_techCardId_fkey" FOREIGN KEY ("techCardId") REFERENCES "TechCardTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechCardOutsourceLine" ADD CONSTRAINT "TechCardOutsourceLine_techCardId_fkey" FOREIGN KEY ("techCardId") REFERENCES "TechCardTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMaterialRequirement" ADD CONSTRAINT "OrderMaterialRequirement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMaterialRequirement" ADD CONSTRAINT "OrderMaterialRequirement_sourceTechCardLineId_fkey" FOREIGN KEY ("sourceTechCardLineId") REFERENCES "TechCardMaterialLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderOutsourceRequirement" ADD CONSTRAINT "OrderOutsourceRequirement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderOutsourceRequirement" ADD CONSTRAINT "OrderOutsourceRequirement_sourceTechCardLineId_fkey" FOREIGN KEY ("sourceTechCardLineId") REFERENCES "TechCardOutsourceLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
