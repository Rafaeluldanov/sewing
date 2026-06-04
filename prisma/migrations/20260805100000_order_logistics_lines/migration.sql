-- Ручные строки логистики/доставки заказа (кнопка «Добавить поле» в
-- конце таблицы «Операции» карточки заказа). См. модель
-- `OrderLogisticsLine` и enum `OrderLogisticsStatus` в schema.prisma.

-- CreateEnum
CREATE TYPE "OrderLogisticsStatus" AS ENUM ('ORDERED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OrderLogisticsLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrderLogisticsStatus",
    "deliveryDeadline" TIMESTAMP(3),
    "costRub" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLogisticsLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderLogisticsLine_orderId_sortOrder_idx" ON "OrderLogisticsLine"("orderId", "sortOrder");

-- AddForeignKey
ALTER TABLE "OrderLogisticsLine" ADD CONSTRAINT "OrderLogisticsLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
