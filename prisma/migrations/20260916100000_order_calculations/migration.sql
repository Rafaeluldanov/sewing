-- Фича «Варианты просчёта» (FEATURE_ORDER_CALCULATIONS): у заказа N
-- альтернативных расчётов (`OrderCalculation`), клиент выбирает один.
--
-- Дизайн «активный = живые данные» (см. JSDoc модели в schema.prisma):
-- активный вариант не хранит данных в этой таблице — его состояние и
-- есть текущие данные заказа; неактивные хранят JSON-снимок входов.
-- Таблица СТРОГО АДДИТИВНА: читатели системы работают по orderId как
-- раньше → откат = выключить флаг, таблица просто не читается.
--
-- Бэкфилл: каждому существующему заказу — одна активная калькуляция
-- (#0, «Вариант 1») с ярлыком себестоимости из Order.costEstimateTotalRub.
-- Детерминированные id ('ocalc0_' || orderId) — миграция идемпотентна
-- по данным и переживает re-run в dev.

-- CreateTable
CREATE TABLE "OrderCalculation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "costTotalRub" DECIMAL(14,2),
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderCalculation_orderId_idx" ON "OrderCalculation"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCalculation_orderId_ordinal_key" ON "OrderCalculation"("orderId", "ordinal");

-- Ровно один активный вариант на заказ (Prisma partial unique не
-- моделирует — руками; INSERT второго активного упадёт на индексе).
CREATE UNIQUE INDEX "OrderCalculation_one_active_per_order"
    ON "OrderCalculation"("orderId") WHERE "isActive";

-- AddForeignKey
ALTER TABLE "OrderCalculation" ADD CONSTRAINT "OrderCalculation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: одна активная калькуляция (#0) на каждый заказ.
INSERT INTO "OrderCalculation" ("id", "orderId", "ordinal", "title", "isActive", "costTotalRub", "snapshot", "createdAt", "updatedAt")
SELECT 'ocalc0_' || o."id", o."id", 0, 'Вариант 1', true, o."costEstimateTotalRub", NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Order" o;
