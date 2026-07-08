-- «Подкрой» (`model RecutSession`): отдельная хронометрируемая
-- активность раскройщика по заказу (докрой деталей), возможная даже
-- по завершённому заказу (`Order.status = DONE`). Не выпускает
-- паспортов, не трогает статус заказа, не связана с `CuttingTask`/
-- `Passport` — просто таймер start→stop, привязанный к заказу и
-- сотруднику. Оплата — почасовая доплата сверх смены
-- (`SalaryService.syncDailyRecut`, строка `SalaryEntry(source=RECUT)`).

-- CreateTable
CREATE TABLE "RecutSession" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "shiftSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "ratePerHour" DECIMAL(12,2),
    "workedSeconds" INTEGER,
    "amount" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecutSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecutSession_employeeId_status_idx" ON "RecutSession"("employeeId", "status");

-- CreateIndex
CREATE INDEX "RecutSession_orderId_idx" ON "RecutSession"("orderId");

-- CreateIndex
CREATE INDEX "RecutSession_employeeId_startedAt_idx" ON "RecutSession"("employeeId", "startedAt");

-- Один активный подкрой на сотрудника (partial unique index; в schema.prisma
-- не выражается, живёт только в миграции — тот же приём, что и
-- `shift_session_active_employee_uniq`). Backend делает явную проверку
-- перед вставкой, индекс — гонко-безопасный backstop.
CREATE UNIQUE INDEX "recut_session_active_employee_uniq" ON "RecutSession"("employeeId") WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "RecutSession" ADD CONSTRAINT "RecutSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecutSession" ADD CONSTRAINT "RecutSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecutSession" ADD CONSTRAINT "RecutSession_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecutSession" ADD CONSTRAINT "RecutSession_shiftSessionId_fkey" FOREIGN KEY ("shiftSessionId") REFERENCES "ShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
