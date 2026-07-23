-- Фича «Архив расчётов цеха» (вкладка «Потребность цеха»).
--
-- Мягкая архивация заказа ЦЕЛИКОМ из списка потребностей закупщика:
-- заказ скрывается из активного списка (needsArchivedAt != null), уезжает
-- во вкладку «Архив», откуда возможно восстановление (обнулить поле) или
-- безвозвратное удаление просчёта (снести OrderCalculation + WorkshopNeed;
-- сам заказ остаётся). При архивации данные не трогаются.
--
-- needsArchivedById / needsArchivedByName — снимок сотрудника, который
-- архивировал (для отображения в карточке архива). Снимок, а не FK —
-- read-путь остаётся простым select-ом без JOIN.
ALTER TABLE "Order"
  ADD COLUMN "needsArchivedAt" TIMESTAMP(3),
  ADD COLUMN "needsArchivedById" TEXT,
  ADD COLUMN "needsArchivedByName" TEXT;

-- Индекс под фильтр «активные / архив» в списке потребностей.
CREATE INDEX "Order_needsArchivedAt_idx" ON "Order"("needsArchivedAt");
