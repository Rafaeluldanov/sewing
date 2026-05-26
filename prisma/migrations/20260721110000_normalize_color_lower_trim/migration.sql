-- Нормализация поля "color" во всех таблицах, где оно хранится как
-- свободный текст: `trim` + схлопывание внутренних пробелов + lower-case.
--
-- Причина: до этой миграции пользователи вводили цвет в разных регистрах
-- («Белый» / «белый» / « Белый »), и однородность коробки в
-- `PackingService.addPassport` ломалась на точном сравнении строк
-- (ADR-0011 §3). Дополнительно ломались фильтры WIP/FG-балансов и
-- сравнение `CutReleasePolicy.color` против `Passport.color`.
--
-- Канонический вид совпадает с `normalizeColor()` из
-- `packages/shared/src/colors.ts`, который теперь применяется во всех
-- color-DTO (CreateOrderSchema, UpdateOrderSchema, …) и в сервисах
-- (PassportsService.create, OrdersService.create/update).
--
-- Безопасность бэкфилла:
--   • В prod-БД в balance-таблицах нет коллизий по составному ключу
--     (orderId, productId, sizeId, lower(trim(color))), поэтому
--     простой UPDATE не создаёт дубли (проверено 26.05.2026).
--   • Ни одного `@@unique`-ключа с участием `color` нет — UPDATE не
--     может упасть на нарушении constraint.
--   • Для balance/movement-таблиц мы НЕ сливаем строки: даже после
--     нормализации каждая строка продолжает корректно отражать те
--     движения, которые в неё писались. Lookup-функции
--     (`getOrCreateBalanceInTx`) с этого момента находят строки по
--     нормализованному ключу — будущие движения консолидируются.
--
-- Идемпотентно: повторный запуск ничего не меняет, т.к. `lower(trim())`
-- от нормализованной строки даёт ту же строку.

-- 1. Заказ — первичный ввод цвета.
UPDATE "Order"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" IS NOT NULL
  AND "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

-- 2. Legacy product — fallback в OrdersService/PassportsService.
UPDATE "Product"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

-- 3. Паспорт — копия из Order/Product (см. PassportsService.create).
UPDATE "Passport"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

-- 4. Политика выдачи кроя — фильтр против Passport.color.
UPDATE "CutReleasePolicy"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" IS NOT NULL
  AND "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

-- 5. Цвет в строке материального требования заказа.
UPDATE "OrderMaterialRequirement"
SET "selectedColorText" = lower(regexp_replace(trim("selectedColorText"), '\s+', ' ', 'g'))
WHERE "selectedColorText" IS NOT NULL
  AND "selectedColorText" <> lower(regexp_replace(trim("selectedColorText"), '\s+', ' ', 'g'));

UPDATE "OrderMaterialRequirement"
SET "resolvedColorText" = lower(regexp_replace(trim("resolvedColorText"), '\s+', ' ', 'g'))
WHERE "resolvedColorText" IS NOT NULL
  AND "resolvedColorText" <> lower(regexp_replace(trim("resolvedColorText"), '\s+', ' ', 'g'));

-- 6. Foundation готовой продукции — копируется из паспорта при упаковке.
UPDATE "FinishedGoodsBalance"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

UPDATE "FinishedGoodsMovement"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

UPDATE "FinishedGoodsShipmentLine"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

-- 7. Foundation полуфабриката — копируется из паспорта при движениях.
UPDATE "WorkInProgressBalance"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));

UPDATE "WorkInProgressMovement"
SET "color" = lower(regexp_replace(trim("color"), '\s+', ' ', 'g'))
WHERE "color" <> lower(regexp_replace(trim("color"), '\s+', ' ', 'g'));
