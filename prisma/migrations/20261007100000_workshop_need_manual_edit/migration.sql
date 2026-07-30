-- Фича «Правка потребности на любой стадии».
--
-- 1) WorkshopNeed: отметка ручной правки состава строки.
--    Раньше состав (описание / единица / роль / чистое количество) правился
--    только у ручных строк (isManual = true), а системные строки из техкарты
--    были неизменяемым снимком. Теперь ошибку расчёта чинят там, где её видно —
--    прямо во вкладке «Потребности» карточки заказа, на любой стадии до
--    «Выпущен» включительно.
--
--    Отметка нужна, чтобы пересчёт (WorkshopNeedsService.calculateForOrder)
--    не затирал молча человеческую правку: строка с manualEditAt блокирует
--    пересчёт без force так же, как строка со статусом ≠ CALCULATED.
--
--    calculatedQtyOriginal хранит «как посчитала система» до первой правки
--    количества — UI показывает «было X», чтобы правка не выглядела расчётом.
--
-- 2) Order: отметка «себестоимость устарела» — правка прошла, а автопересчёт
--    сметы не смог (нет курса USD / нет цены / сметы ещё нет). Плашка во
--    вкладке «Потребности» + кнопка «Пересчитать». Симметрично needsStaleAt.
--
-- Все колонки nullable без DEFAULT: NULL = прежнее поведение.

ALTER TABLE "WorkshopNeed" ADD COLUMN "manualEditAt" TIMESTAMP(3);
ALTER TABLE "WorkshopNeed" ADD COLUMN "manualEditById" TEXT;
ALTER TABLE "WorkshopNeed" ADD COLUMN "calculatedQtyOriginal" DECIMAL(14,4);

ALTER TABLE "Order" ADD COLUMN "costEstimateStaleAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "costEstimateStaleReason" TEXT;
