-- Backfill `balanceKey` для `WorkInProgressBalance` / `FinishedGoodsBalance`
-- после миграции 20260721110000_normalize_color_lower_trim.
--
-- Контекст. Предыдущая миграция нормализовала колонки `color` (lower+trim),
-- но НЕ пересобрала `balanceKey` (UNIQUE композитный ключ, включающий
-- исходное значение color). После её прогона:
--   - `WorkInProgressBalance.color = 'белый'`, но
--   - `balanceKey = '…:Белый:…'` (старый регистр).
-- `getOrCreateBalanceInTx` ищет балансы ТОЛЬКО по `balanceKey`, поэтому
-- старые строки становятся «невидимы»: код создаёт новые балансы с
-- lowercase-ключом, qty=0, и последующий OUT падает с
-- `WIP_INSUFFICIENT_BALANCE` (инцидент 27.05.2026 на P-20260513-0112,
-- оверлок), либо тихо двоит остатки готовой продукции.
--
-- Эта миграция чинит данные:
--   - Если по нормализованному ключу строки нет — простое UPDATE
--     `balanceKey` на нормализованный вид (раздел A).
--   - Если строка по нормализованному ключу уже существует (была
--     создана кодом после `normalize_color_lower_trim`) — мерж:
--     1) переводим FK-движения и shipment-lines со старой строки на
--        новую;
--     2) суммируем qty;
--     3) удаляем старую строку (раздел B).
--
-- Идемпотентно: повторный запуск выбирает 0 строк, т.к. после фикса
-- `position(':' || color || ':' in "balanceKey") > 0`.

-- ==============================================================
-- A. WorkInProgressBalance
-- ==============================================================

-- A.1. Мерж коллизий (если есть строка с lowercase-ключом)
WITH bad AS (
  SELECT id, color, "orderId", "productId", "sizeId",
         COALESCE("warehouseId",'NO_WAREHOUSE') AS wh,
         COALESCE("cellId",'NO_CELL') AS cl
  FROM "WorkInProgressBalance"
  WHERE position(':' || color || ':' in "balanceKey") = 0
),
collision AS (
  SELECT b.id AS stale_id, wb.id AS target_id, wb.qty AS target_qty
  FROM bad b
  JOIN "WorkInProgressBalance" wb
    ON wb."balanceKey" = b."orderId"||':'||b."productId"||':'||b."sizeId"||':'||b.color||':'||b.wh||':'||b.cl
),
relink AS (
  UPDATE "WorkInProgressMovement" m
  SET "workInProgressBalanceId" = c.target_id
  FROM collision c
  WHERE m."workInProgressBalanceId" = c.stale_id
  RETURNING 1
),
sum_qty AS (
  UPDATE "WorkInProgressBalance" wb
  SET qty = wb.qty + s.stale_qty,
      "lastMovementAt" = now()
  FROM (
    SELECT c.target_id, wb_stale.qty AS stale_qty
    FROM collision c
    JOIN "WorkInProgressBalance" wb_stale ON wb_stale.id = c.stale_id
  ) s
  WHERE wb.id = s.target_id
  RETURNING 1
)
DELETE FROM "WorkInProgressBalance"
WHERE id IN (SELECT stale_id FROM collision);

-- A.2. Не-конфликтующие — простой UPDATE balanceKey
UPDATE "WorkInProgressBalance"
SET "balanceKey" = "orderId"||':'||"productId"||':'||"sizeId"||':'||color||':'||COALESCE("warehouseId",'NO_WAREHOUSE')||':'||COALESCE("cellId",'NO_CELL')
WHERE position(':' || color || ':' in "balanceKey") = 0;

-- ==============================================================
-- B. FinishedGoodsBalance
-- ==============================================================

-- B.1. Мерж коллизий
WITH bad AS (
  SELECT id, color, "orderId", "productId", "sizeId",
         COALESCE("warehouseId",'NO_WAREHOUSE') AS wh,
         COALESCE("cellId",'NO_CELL') AS cl
  FROM "FinishedGoodsBalance"
  WHERE position(':' || color || ':' in "balanceKey") = 0
),
collision AS (
  SELECT b.id AS stale_id, fb.id AS target_id
  FROM bad b
  JOIN "FinishedGoodsBalance" fb
    ON fb."balanceKey" = b."orderId"||':'||b."productId"||':'||b."sizeId"||':'||b.color||':'||b.wh||':'||b.cl
),
relink_mov AS (
  UPDATE "FinishedGoodsMovement" m
  SET "finishedGoodsBalanceId" = c.target_id
  FROM collision c
  WHERE m."finishedGoodsBalanceId" = c.stale_id
  RETURNING 1
),
relink_ship AS (
  UPDATE "FinishedGoodsShipmentLine" sl
  SET "finishedGoodsBalanceId" = c.target_id
  FROM collision c
  WHERE sl."finishedGoodsBalanceId" = c.stale_id
  RETURNING 1
),
sum_qty AS (
  UPDATE "FinishedGoodsBalance" fb
  SET qty = fb.qty + s.stale_qty,
      "lastMovementAt" = now()
  FROM (
    SELECT c.target_id, fb_stale.qty AS stale_qty
    FROM collision c
    JOIN "FinishedGoodsBalance" fb_stale ON fb_stale.id = c.stale_id
  ) s
  WHERE fb.id = s.target_id
  RETURNING 1
)
DELETE FROM "FinishedGoodsBalance"
WHERE id IN (SELECT stale_id FROM collision);

-- B.2. Не-конфликтующие — простой UPDATE balanceKey
UPDATE "FinishedGoodsBalance"
SET "balanceKey" = "orderId"||':'||"productId"||':'||"sizeId"||':'||color||':'||COALESCE("warehouseId",'NO_WAREHOUSE')||':'||COALESCE("cellId",'NO_CELL')
WHERE position(':' || color || ':' in "balanceKey") = 0;
