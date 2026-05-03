-- Hardening-итерация «Автосписание материалов при выдаче кроя»
-- (см. `prisma/schema.prisma::CompanySettings`,
-- `apps/api/src/modules/company-settings/company-settings.service.ts::getAutoIssueMaterialsOnCutRelease`,
-- `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
-- `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
-- `docs/current-state.md §«Auto cut issue»`).
--
-- Цель: добавить boolean-настройку, которая включает/выключает
-- автоматическое создание `MaterialIssue` при выдаче кроя
-- сотруднику. Default `false` сознательно — после миграции
-- поведение production НЕ меняется самостоятельно, переключение
-- на автосписание остаётся явным действием владельца проекта.
--
-- Контракт:
--   * `false` → `PassportsService.issueToEmployee` НЕ вызывает
--     `createAutoCutIssueForPassport`; остальная логика выдачи
--     (события паспорта, currentEmployee, `CutReleasePolicy` /
--     `OrderCutIssueRule`-учёт) работает штатно;
--   * `true`  → `issueToEmployee` вызывает auto-helper в той же
--     транзакции (POSTED MaterialIssue с
--     `source = AUTO_CUT_ISSUE`, идемпотентность по UNIQUE
--     `MaterialIssue.sourceKey`).
--
-- Публичный API настройки на этой итерации НЕ добавляется —
-- DTO `/api/company-settings` поле не принимает (UI ещё не
-- утверждён). Backend читает значение через
-- `CompanySettingsService.getAutoIssueMaterialsOnCutRelease()`.

ALTER TABLE "CompanySettings"
  ADD COLUMN "autoIssueMaterialsOnCutRelease" BOOLEAN NOT NULL DEFAULT false;
