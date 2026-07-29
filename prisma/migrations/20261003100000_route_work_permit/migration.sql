-- Наряд-допуск мастера (`RouteWorkPermit`): разрешение делать по
-- конкретному заказу операцию, которой нет в его маршруте.
--
-- Зачем. Гейт `offRouteWorkPolicy = BLOCK` отказывает в работе мимо
-- маршрута. Без легального обхода первая же нештатная ситуация
-- (сломался станок, срочный перекрой, цех перешёл на другую технологию
-- посреди партии) означает простой рабочего места. Простой = требование
-- выключить гейт, а выключенный гейт второй раз никто не включит.
-- Допуск закрывает вопрос за 30 секунд у станка, оставляя след, вместо
-- тикета разработчику на неделю.
--
-- ⚠️ `satisfiesStepOperationId` NOT NULL — это главное поле модели.
-- Допуск без указания «какой шаг маршрута закрывает эта работа» — ровно
-- инцидент 28.07.2026, только с бумажкой: швея дошьёт, а паспорт всё
-- равно не закроет шаг «03 КИПЕРКА», и AND-гейт перед ОТК всё равно
-- упадёт, просто неделей позже и с формальным разрешением на руках.
-- Поэтому допуск читается ВЕЗДЕ, где читается `OperationSubstitution`:
-- в маршрутном гейте, в гейте ОТК и в расчёте расхождений.
--
-- Почему отдельная таблица, а не `orderId` в `OperationSubstitution`:
-- та — справочник, её строки структурно читают адаптивный режим
-- сплит-распошива (`route-mode.ts`) и `findCollapsibleGroup`; временные
-- строки с областью действия сломали бы им логику. Допуск по природе —
-- разовый документ со сроком, автором и отзывом.
--
-- `onDelete`: заказ — Cascade (удалили заказ, допуск не нужен);
-- операции — Restrict (нельзя удалить операцию, на которую есть допуск);
-- автор — Restrict, отозвавший — SetNull (сотрудника могут удалить,
-- сам факт отзыва при этом теряться не должен).

-- CreateTable
CREATE TABLE "RouteWorkPermit" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "satisfiesStepOperationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "qtyLimit" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "RouteWorkPermit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RouteWorkPermit_orderId_operationId_idx" ON "RouteWorkPermit"("orderId", "operationId");

-- CreateIndex
CREATE INDEX "RouteWorkPermit_expiresAt_idx" ON "RouteWorkPermit"("expiresAt");

-- AddForeignKey
ALTER TABLE "RouteWorkPermit" ADD CONSTRAINT "RouteWorkPermit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteWorkPermit" ADD CONSTRAINT "RouteWorkPermit_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteWorkPermit" ADD CONSTRAINT "RouteWorkPermit_satisfiesStepOperationId_fkey" FOREIGN KEY ("satisfiesStepOperationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteWorkPermit" ADD CONSTRAINT "RouteWorkPermit_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteWorkPermit" ADD CONSTRAINT "RouteWorkPermit_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
