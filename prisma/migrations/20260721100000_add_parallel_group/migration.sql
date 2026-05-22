-- Параллельные (взаимозаменяемые) группы шагов маршрута.
-- Соседние шаги с одинаковым ненулевым parallelGroup образуют один этап:
-- внутри порядок любой, выход на следующий этап — когда все завершены.
-- Аддитивно, nullable, без дефолта — существующие маршруты не меняются.
-- IF NOT EXISTS — идемпотентно (на dev колонка могла быть добавлена
-- напрямую при разработке); на prod добавит, т.к. её ещё нет.
ALTER TABLE "RouteTemplateStep" ADD COLUMN IF NOT EXISTS "parallelGroup" INTEGER;
ALTER TABLE "OrderRouteStep" ADD COLUMN IF NOT EXISTS "parallelGroup" INTEGER;
