-- PHASE 2 «CompanyDivision как master-справочник»: удаление legacy
-- enum `OrderDivision`, колонок `Order.division` /
-- `DisplayScreenConfig.division` и связанных индексов.
--
-- См. `docs/domain.md §«Подразделения заказа»`,
-- `docs/erd.md §«Order»`, `docs/erd.md §«CompanyDivision»`.
--
-- Контекст:
--   - PHASE 1 (`…_link_company_divisions_to_orders`) добавила
--     `Order.companyDivisionId` / `DisplayScreenConfig.companyDivisionId`,
--     backfill-ила их по соответствию `division::text → CompanyDivision.code`
--     и upsert-нула базовые карточки `MARKETPLACE` / `OTHER`.
--   - В PHASE 1 backend начал писать пару `(companyDivisionId, division)`
--     синхронно по `code`, чтобы legacy-код продолжал работать.
--
-- Контракт PHASE 2:
--   1. Удалить индексы `Order_division_idx` и
--      `DisplayScreenConfig_division_idx` (имена соответствуют
--      `…/20260430100000_order_division/migration.sql` и
--      `…/20260501100000_display_screen_config/migration.sql`).
--   2. `ALTER TABLE "Order" DROP COLUMN "division"`.
--   3. `ALTER TABLE "DisplayScreenConfig" DROP COLUMN "division"`.
--   4. `DROP TYPE "OrderDivision"`.
--
-- НЕ трогаем `companyDivisionId` ни на одной таблице — это новый
-- источник истины. Базовые карточки `MARKETPLACE` / `OTHER` остаются
-- в `CompanyDivision`, на них завязаны заказы и display-экраны.

-- DropIndex (Order.division — см. 20260430100000_order_division).
DROP INDEX IF EXISTS "Order_division_idx";

-- DropIndex (DisplayScreenConfig.division — см. 20260501100000_display_screen_config).
DROP INDEX IF EXISTS "DisplayScreenConfig_division_idx";

-- AlterTable: убрать legacy колонку `division` из заказов.
ALTER TABLE "Order" DROP COLUMN "division";

-- AlterTable: убрать legacy колонку `division` из display-экранов.
ALTER TABLE "DisplayScreenConfig" DROP COLUMN "division";

-- DropEnum: legacy enum `OrderDivision` больше нигде не используется.
DROP TYPE "OrderDivision";
