-- Итерация «Division overrides для флагов блока „Материалы и склад“»
-- (см. `prisma/schema.prisma::CompanyDivision`,
-- `apps/api/src/modules/company-settings/company-settings.service.ts::getEffectiveMaterialStockSettingsForOrderInTx`,
-- `docs/current-state.md §«Материалы и склад — division overrides»`).
--
-- Цель: дать разным подразделениям работать по разным правилам для
-- двух hardening-флагов `CompanySettings`:
--   * `autoIssueMaterialsOnCutRelease` — автосписание материалов при
--     выдаче кроя;
--   * `allowNegativeMaterialStock`     — разрешение отрицательных
--     остатков при OUT-списании.
--
-- Добавляются две nullable-колонки в `CompanyDivision`:
--   * `autoIssueMaterialsOnCutReleaseOverride BOOLEAN`
--   * `allowNegativeMaterialStockOverride     BOOLEAN`
--
-- Сознательно БЕЗ `@default`:
--   * NULL      → наследовать глобальный `CompanySettings.<флаг>`;
--   * TRUE      → принудительно включить для подразделения;
--   * FALSE     → принудительно выключить для подразделения.
--
-- Effective policy применяется к `PassportsService.issueToEmployee`,
-- `MaterialIssuesService.post` / `createAutoCutIssueForPassport`,
-- `StockService.createAdjustment` (OUT). `PurchaseReceipt` cancel /
-- REVERSAL OUT сознательно остаётся permissive и от division
-- overrides не зависит. Существующие карточки `MARKETPLACE` / `OTHER`
-- после миграции имеют `NULL` и продолжают наследовать глобальные
-- значения — production поведение не меняется само.

ALTER TABLE "CompanyDivision"
  ADD COLUMN "autoIssueMaterialsOnCutReleaseOverride" BOOLEAN,
  ADD COLUMN "allowNegativeMaterialStockOverride"     BOOLEAN;
