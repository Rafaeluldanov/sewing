-- 05.08.2026 — возврат на стеллаж кроя заказа O-20260721-0001.
--
-- Причина: патч `20260731_clear_wip_cells.sql` («обнуление стеллажа») снял с
-- ячеек ВСЕ 139 паспортов одним `UPDATE ... WHERE "currentCellId" IS NOT NULL`.
-- Вместе со старым, физически снятым кроем под нож попал живой: 48 паспортов
-- заказа O-20260721-0001, размещённых 22.07.2026 в C4 / D1 / D4 / D7. Крой
-- лежит в ячейках, а система считает его неразмещённым, и скан паспорта падает
-- гейтом `PASSPORT_NOT_PLACED_IN_CELL` (см. `common/errors.ts`,
-- `PassportsService.assertPlacedBeforeLeavingCut`). Жалоба по
-- P-20260722-0043 (ячейка D1) — частный случай.
--
-- Возвращаем ТОЛЬКО этот заказ. Остальные 91 паспорт (майский крой Z1/Z3/Z18/Z19,
-- готовые заказы O-20260708-0001 / O-20260716-0001) не трогаем: там обнуление
-- было по делу.
--
-- Оба контура правим одной транзакцией — иначе паспорта вернутся в ячейки, а
-- остаток НЗП останется нулевым, и стеллаж разъедется с фактом (ровно та
-- симметрия, ради которой патч 31.07 тоже правил оба).
--
-- Сверка перед применением (сошлась 1:1): 48 паспортов ↔ 32 строки
-- `WorkInProgressBalance`, поразмерная сумма `qtyCut` совпала со списанным
-- 31.07 количеством в каждой строке, итого 811 шт. Ни один из 48 паспортов
-- с 22.07 не двигался: статус `CREATED`, последнее событие — `CELL_PLACED`,
-- поэтому «докатное» состояние восстанавливается однозначно.

BEGIN;

-- Целевые паспорта: последнее событие = CELL_PLACED, с ячейки сняты патчем,
-- в работу не уходили. Ячейку берём из самого события — это единственный
-- уцелевший след размещения (историю событий патч 31.07 не трогал).
CREATE TEMP TABLE restore_passports ON COMMIT DROP AS
WITH last_event AS (
  SELECT DISTINCT ON (e."passportId")
         e."passportId", e.type, e."cellId"
    FROM "PassportEvent" e
   ORDER BY e."passportId", e."createdAt" DESC, e.id DESC
)
SELECT p.id AS passport_id,
       p."orderId",
       p."productId",
       p."sizeId",
       lower(btrim(p.color)) AS color,
       l."cellId"            AS cell_id,
       p."qtyCut"            AS qty
  FROM last_event l
  JOIN "Passport" p ON p.id = l."passportId"
 WHERE l.type = 'CELL_PLACED'
   AND l."cellId" IS NOT NULL
   AND p."currentCellId" IS NULL
   AND p.status = 'CREATED'
   AND p."orderId" = (SELECT id FROM "Order" WHERE number = 'O-20260721-0001');

-- Строки НЗП, которым возвращаем остаток. `b.qty = 0` — защита от повторного
-- прогона по остатку (плюс UNIQUE на sourceKey ниже, который уронит второй
-- прогон на дубле ключа, а не задвоит приход).
CREATE TEMP TABLE restore_balances ON COMMIT DROP AS
SELECT b.id AS balance_id,
       sum(r.qty)::int AS qty
  FROM restore_passports r
  JOIN "WorkInProgressBalance" b
    ON b."orderId"   = r."orderId"
   AND b."productId" = r."productId"
   AND b."sizeId"    = r."sizeId"
   AND lower(btrim(b.color)) = r.color
   AND b."cellId"    = r.cell_id
 WHERE b.qty = 0
 GROUP BY b.id;

-- 1. IN-движение на возвращаемый остаток каждой строки. Зеркало OUT-движения
--    `WIP_ADJUSTMENT:<balanceId>` из патча 31.07; без него `balanceAfterQty`
--    последнего движения перестал бы сходиться с балансом.
--    `type = 'ADJUSTMENT'` хранится строкой (см. `work-in-progress.constants.ts`),
--    UI-бейдж `stock-movement-type-badge.tsx` знает его как «Корректировка».
INSERT INTO "WorkInProgressMovement" (
  id,
  "workInProgressBalanceId",
  type,
  direction,
  "orderId",
  "productId",
  "sizeId",
  color,
  "warehouseId",
  "cellId",
  qty,
  "balanceBeforeQty",
  "balanceAfterQty",
  "sourceKey",
  comment,
  "createdAt"
)
SELECT
  'wipadj_' || replace(gen_random_uuid()::text, '-', ''),
  b.id,
  'ADJUSTMENT',
  'IN',
  b."orderId",
  b."productId",
  b."sizeId",
  b.color,
  b."warehouseId",
  b."cellId",
  rb.qty,
  0,
  rb.qty,
  'WIP_ADJUSTMENT_RESTORE:' || b.id,
  'Возврат стеллажа O-20260721-0001 05.08.2026 (откат обнуления 31.07 по живому заказу)',
  now()
FROM restore_balances rb
JOIN "WorkInProgressBalance" b ON b.id = rb.balance_id;

-- 2. Вернуть остаток НЗП.
UPDATE "WorkInProgressBalance" b
   SET qty = rb.qty,
       "updatedAt" = now(),
       "lastMovementAt" = now()
  FROM restore_balances rb
 WHERE b.id = rb.balance_id;

-- 3. Вернуть паспорта в их ячейки. `currentEmployeeId` не трогаем: он уже null
--    (размещение отвязывает паспорт от раскройщика — см. `PassportsService.place`).
UPDATE "Passport" p
   SET "currentCellId" = r.cell_id,
       "updatedAt" = now()
  FROM restore_passports r
 WHERE p.id = r.passport_id;

COMMIT;
