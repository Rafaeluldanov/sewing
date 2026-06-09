-- Этап «Нанесение по размерам / части тиража».
--
-- Добавляет адресацию нанесения (`OrderApplication`) на конкретные
-- размеры заказа с поразмерным количеством. Семантика:
--   - нет строк `OrderApplicationSize` у нанесения → нанесение на
--     весь тираж (количество = order-level `quantity` или Σ qtyPlan);
--   - есть строки → нанесение только на перечисленные размеры,
--     на размер количество = `OrderApplicationSize.quantity` или
--     `OrderItem.qtyPlan` этого размера.
--
-- Обратная совместимость: существующие нанесения остаются «на весь
-- тираж» (у них просто нет строк `OrderApplicationSize`).

-- CreateTable
CREATE TABLE "OrderApplicationSize" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "quantity" DECIMAL(14,4),

    CONSTRAINT "OrderApplicationSize_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderApplicationSize_applicationId_sizeId_key" ON "OrderApplicationSize"("applicationId", "sizeId");

-- CreateIndex
CREATE INDEX "OrderApplicationSize_applicationId_idx" ON "OrderApplicationSize"("applicationId");

-- CreateIndex
CREATE INDEX "OrderApplicationSize_sizeId_idx" ON "OrderApplicationSize"("sizeId");

-- AddForeignKey
ALTER TABLE "OrderApplicationSize" ADD CONSTRAINT "OrderApplicationSize_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "OrderApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderApplicationSize" ADD CONSTRAINT "OrderApplicationSize_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "Size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
