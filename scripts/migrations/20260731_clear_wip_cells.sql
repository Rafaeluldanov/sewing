-- 31.07.2026 — обнуление стеллажа: остатки НЗП по ячейкам + снятие паспортов с ячеек.
--
-- Причина: на «Складе кроя» скопился крой, физически с ячеек уже снятый /
-- неактуальный. 139 паспортов висели в 12 ячейках (B4, C4, C7, D1, D4, D7,
-- D8, D9, Z1, Z3, Z18, Z19) со статусом CREATED — от 13.05.2026 до 22.07.2026,
-- ни одна операция по ним не бралась. Остаток НЗП (`WorkInProgressBalance`)
-- совпадал с паспортами один в один (1 570 шт в 42 ненулевых строках),
-- поэтому обнуляем оба контура одной транзакцией — иначе они разъедутся.
--
-- Почему SQL, а не API: `work-in-progress.controller.ts` работает только на
-- чтение (`GET /balances`, `GET /movements`) — ручной корректировки остатка
-- полуфабриката в API нет (в отличие от материалов `POST /api/stock/adjustments`
-- и готовой продукции `POST /api/finished-goods/adjustments`).
--
-- Движения-корректировки пишем сознательно: журнал `WorkInProgressMovement`
-- (PLACE / ISSUE / RETURN) — источник истины по остатку, и без OUT-движения
-- `balanceAfterQty` последнего движения перестал бы сходиться с балансом.
-- `type = 'ADJUSTMENT'` в enum контура НЗП отсутствует, но тип хранится
-- строкой (см. `work-in-progress.constants.ts` — «расширение без миграции»),
-- а UI-бейдж `stock-movement-type-badge.tsx` знает `ADJUSTMENT` → «Корректировка».
--
-- Бэкап перед применением: pg_dump WorkInProgressBalance + WorkInProgressMovement
-- (data-only) и выгрузка пар (passportId, currentCellId) — вне репозитория.

BEGIN;

-- 1. OUT-движение на весь остаток каждой ненулевой строки НЗП.
--    `sourceKey = WIP_ADJUSTMENT:<balanceId>` — UNIQUE защищает от повторного
--    применения патча (второй прогон упадёт на дубле ключа, а не задвоит списание).
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
  'OUT',
  b."orderId",
  b."productId",
  b."sizeId",
  b.color,
  b."warehouseId",
  b."cellId",
  b.qty,
  b.qty,
  0,
  'WIP_ADJUSTMENT:' || b.id,
  'Обнуление остатков стеллажа 31.07.2026 (ручная корректировка данных)',
  now()
FROM "WorkInProgressBalance" b
WHERE b.qty <> 0;

-- 2. Обнулить остатки НЗП. Строки НЕ удаляем: нулевой баланс — штатное
--    состояние контура (после ISSUE строка остаётся с qty = 0), а
--    `listBalances` с фильтром `nonZero` отдаёт только `qty > 0`.
UPDATE "WorkInProgressBalance"
   SET qty = 0,
       "updatedAt" = now(),
       "lastMovementAt" = now()
 WHERE qty <> 0;

-- 3. Снять паспорта с ячеек. `PassportEvent` с историей размещений НЕ трогаем —
--    это исторический журнал. Последствие: чтобы выдать такой паспорт швее,
--    помощник раскройщика должен разместить его в ячейку заново, иначе
--    сработает гейт `PASSPORT_NOT_PLACED_IN_CELL` (см. `common/errors.ts`).
UPDATE "Passport"
   SET "currentCellId" = NULL,
       "updatedAt" = now()
 WHERE "currentCellId" IS NOT NULL;

COMMIT;
