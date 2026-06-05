-- Цена ниток на /admin/workshop-needs вводится за бобину, но в БД
-- хранится как цена за метр (цена_за_боб ÷ 3657.6). Для дешёвых ниток
-- это 0.0xxx ₽/м — 2 знаков после точки не хватает, значение либо
-- отбраковывалось валидацией, либо молча округлялось NUMERIC(14,2).
-- Расширяем точность quotedPrice до 4 знаков. Расширение точности
-- existing-данные не теряет (ширина 14 не меняется).
ALTER TABLE "WorkshopNeed"
  ALTER COLUMN "quotedPrice" TYPE DECIMAL(14,4);

-- Тот же snapshot копируется в строку расчёта при завершении —
-- иначе цена ниток обрезалась бы обратно до 2 знаков.
ALTER TABLE "OrderCostEstimateLine"
  ALTER COLUMN "quotedPrice" TYPE DECIMAL(14,4);
