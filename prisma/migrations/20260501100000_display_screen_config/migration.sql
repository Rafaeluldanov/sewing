-- Display screen config (`DisplayScreenConfig`) — управленческая
-- запись «один экран = одна DISPLAY-учётка + одно подразделение».
-- См. `docs/domain.md §«Подразделения заказа»` (display screen-ы),
-- `docs/api.md §11`, `docs/screens.md §10e`.
--
-- Дизайн:
--   - 1:1 c `Employee` (`employeeId UNIQUE`). Учётка под DISPLAY
--     заводится одной транзакцией с конфигом
--     (`DisplayScreensService.create`); вне этого flow DISPLAY-
--     учётки не создаются.
--   - `division` — `OrderDivision`-enum, тот же, что у `Order.division`.
--     Используется в `ShopfloorService.getDisplaySummary`, чтобы
--     DISPLAY-пользователю автоматически подставился свой `division`
--     без `?division=` в URL.
--   - `isActive` — мягкий выключатель экрана. Если `false`,
--     auto-division для соответствующей DISPLAY-учётки не
--     срабатывает, и `/api/shopfloor/display` отдаёт «общий» агрегат.
--   - `ON DELETE CASCADE` на FK `employee` — конфиг живёт ровно
--     столько же, сколько DISPLAY-учётка. Никаких «висящих» экранов
--     без сотрудника.
--   - `@@index([division])` и `@@index([isActive])` — оба читаются
--     `getDisplaySummary` через relation, точечно ничего не ускоряют
--     на размерах MVP, но дёшевы и удобны для будущего listing-а.

CREATE TABLE "DisplayScreenConfig" (
    "id"         TEXT          NOT NULL,
    "name"       TEXT          NOT NULL,
    "division"   "OrderDivision" NOT NULL,
    "employeeId" TEXT          NOT NULL,
    "isActive"   BOOLEAN       NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "DisplayScreenConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DisplayScreenConfig_employeeId_key"
    ON "DisplayScreenConfig"("employeeId");

CREATE INDEX "DisplayScreenConfig_division_idx"
    ON "DisplayScreenConfig"("division");

CREATE INDEX "DisplayScreenConfig_isActive_idx"
    ON "DisplayScreenConfig"("isActive");

ALTER TABLE "DisplayScreenConfig"
    ADD CONSTRAINT "DisplayScreenConfig_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
