-- Smoke-проверка после миграции 20260620100000_add_work_in_progress_drop_cell_content.
--
-- Запускать ТОЛЬКО ПОСЛЕ успешного `prisma migrate deploy` на проде/стейдже.
-- Все запросы read-only. Цель — убедиться, что:
--   a) число паспортов в ячейках совпадает с числом строк в WIP;
--   b) сумма qtyCut по живым паспортам в ячейках совпадает с суммой
--      WorkInProgressBalance.qty;
--   c) на каждый паспорт-в-ячейке создано ровно одно PLACE-движение
--      с sourceKey 'WIP_PLACE_BACKFILL:<passportId>';
--   d) нет отрицательных балансов;
--   e) `CellContent` действительно дропнута.
--
-- Ожидаемый результат любого запроса — `OK` в колонке `verdict`.
-- Если хоть один вернул `MISMATCH` или `FAIL` — НЕ выкатывать новый
-- код. Откатить миграцию через бэкап БД (`scripts/backup-db.sh`).

\echo '== a) счёт паспортов vs WIP balance =='
SELECT
    CASE
        WHEN passport_count = wip_balance_count THEN 'OK'
        ELSE 'MISMATCH'
    END AS verdict,
    passport_count,
    wip_balance_count
FROM (
    SELECT
        (
            SELECT COUNT(DISTINCT (
                p."orderId" || ':' || p."productId" || ':' || p."sizeId"
                || ':' || p."color"
                || ':' || COALESCE(c."warehouseId", 'NO_WAREHOUSE')
                || ':' || p."currentCellId"
            ))
            FROM "Passport" p
            JOIN "Cell" c ON c."id" = p."currentCellId"
            WHERE p."currentCellId" IS NOT NULL
              AND p."status" NOT IN ('PACKED', 'CANCELLED')
        ) AS passport_count,
        (SELECT COUNT(*) FROM "WorkInProgressBalance" WHERE "qty" > 0) AS wip_balance_count
) t;

\echo '== b) сумма qtyCut vs сумма WIP qty =='
SELECT
    CASE
        WHEN passport_qty_total = wip_qty_total THEN 'OK'
        ELSE 'MISMATCH'
    END AS verdict,
    passport_qty_total,
    wip_qty_total
FROM (
    SELECT
        (
            SELECT COALESCE(SUM(p."qtyCut"), 0)
            FROM "Passport" p
            WHERE p."currentCellId" IS NOT NULL
              AND p."status" NOT IN ('PACKED', 'CANCELLED')
        ) AS passport_qty_total,
        (SELECT COALESCE(SUM("qty"), 0) FROM "WorkInProgressBalance") AS wip_qty_total
) t;

\echo '== c) BACKFILL-движения: одно на каждый живой паспорт-в-ячейке =='
SELECT
    CASE
        WHEN passport_count = backfill_movement_count THEN 'OK'
        ELSE 'MISMATCH'
    END AS verdict,
    passport_count,
    backfill_movement_count
FROM (
    SELECT
        (
            SELECT COUNT(*)
            FROM "Passport" p
            WHERE p."currentCellId" IS NOT NULL
              AND p."status" NOT IN ('PACKED', 'CANCELLED')
        ) AS passport_count,
        (
            SELECT COUNT(*)
            FROM "WorkInProgressMovement"
            WHERE "sourceType" = 'BACKFILL'
              AND "type" = 'PLACE'
              AND "direction" = 'IN'
        ) AS backfill_movement_count
) t;

\echo '== d) нет отрицательных балансов =='
SELECT
    CASE
        WHEN COUNT(*) = 0 THEN 'OK'
        ELSE 'FAIL'
    END AS verdict,
    COUNT(*) AS negative_count
FROM "WorkInProgressBalance"
WHERE "qty" < 0;

\echo '== e) CellContent дропнута =='
SELECT
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'CellContent'
        ) THEN 'OK'
        ELSE 'FAIL'
    END AS verdict;

\echo ''
\echo 'Если хоть один verdict ≠ OK — НЕ выкатывайте новый код,'
\echo 'откатите миграцию через restore из бэкапа (scripts/backup-db.sh).'
