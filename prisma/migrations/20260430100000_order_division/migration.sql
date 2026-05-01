-- Подразделение заказа (division) — управленческая ось для фильтра
-- большого экрана `/shopfloor/display?division=…`.
-- См. `docs/domain.md §«Подразделения заказа»`, `docs/api.md §11`,
-- `docs/screens.md §9a`.
--
-- Дизайн:
--   - значения enum: MARKETPLACE | OTHER. На MVP только два, чтобы
--     первый требуемый кейс «отдельный экран маркетплейса»
--     заработал минимальной архитектурой. Расширяется добавлением
--     значений в этот enum + лейблов в `ORDER_DIVISION_LABELS`.
--   - поле NOT NULL c дефолтом `OTHER`, чтобы все исторические
--     заказы автоматически попали в backward-compatible бакет
--     «не маркетплейс». При создании новых заказов веб-форма
--     просит явный выбор, но если фронт/интеграция не передаст
--     значение — Prisma подставит `OTHER`.
--   - `@@index([division])` ускоряет выборку
--     `passport.order.division = $1` в `ShopfloorService.getDisplaySummary`.

CREATE TYPE "OrderDivision" AS ENUM ('MARKETPLACE', 'OTHER');

ALTER TABLE "Order"
  ADD COLUMN "division" "OrderDivision" NOT NULL DEFAULT 'OTHER';

CREATE INDEX "Order_division_idx" ON "Order"("division");
