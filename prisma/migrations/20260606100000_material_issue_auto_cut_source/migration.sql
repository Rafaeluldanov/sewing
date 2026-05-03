-- Этап «Автосписание материалов при выдаче кроя» (см.
-- `prisma/schema.prisma::MaterialIssue`,
-- `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
-- `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
-- `docs/current-state.md §«Auto cut issue»`).
--
-- MVP-итерация: к документу фактического расхода материалов добавляем
-- `source` (кто создал — пользователь вручную или автоматика выдачи
-- кроя) и `sourceKey` (технический ключ идемпотентности для
-- авто-документов). Миграция чисто additive: новые колонки + индекс
-- по `source` + UNIQUE-индекс по `sourceKey`.
--
-- Правила заполнения:
--   * `source = 'MANUAL'` по умолчанию — исторические документы и
--     ручные create через `POST /api/material-issues`;
--   * `source = 'AUTO_CUT_ISSUE'` + `sourceKey = 'AUTO_CUT_ISSUE:<passportId>'`
--     — автоматически при `PassportsService.issueToEmployee`;
--   * UNIQUE `sourceKey` защищает от двойного автосписания при retry
--     (conflict по `sourceKey` на вставке = тот же паспорт уже
--     получил авто-документ).
--
-- Фронт / публичный API новых полей НЕ принимает: `source`/`sourceKey`
-- проставляет сервис. Для ручного create `source` остаётся `'MANUAL'`,
-- `sourceKey` — `NULL`.

ALTER TABLE "MaterialIssue"
  ADD COLUMN "source"    TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "sourceKey" TEXT;

CREATE INDEX "MaterialIssue_source_idx" ON "MaterialIssue"("source");

CREATE UNIQUE INDEX "MaterialIssue_sourceKey_key" ON "MaterialIssue"("sourceKey");
