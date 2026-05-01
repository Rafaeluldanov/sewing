-- PHASE 1 «CompanyDivision как master-справочник подразделений заказа и
-- display screens». См. `docs/domain.md §«Подразделения заказа»`,
-- `docs/erd.md §«Order»`, `docs/erd.md §«CompanyDivision»`.
--
-- Контракт миграции:
--   1. Добавляем nullable FK `Order.companyDivisionId` и
--      `DisplayScreenConfig.companyDivisionId` (`ON DELETE SET NULL`,
--      `ON UPDATE CASCADE`) + индексы.
--   2. Идемпотентно upsert-им базовые карточки `MARKETPLACE` /
--      `OTHER` (B2B), чтобы соответствовать legacy enum
--      `OrderDivision`. Если у инсталляции уже есть карточка с этим
--      `code` (например, менеджер завёл вручную) — оставляем её
--      имя/sortOrder как есть.
--   3. Backfill: проставляем `companyDivisionId` по совпадению
--      `Order.division::text = CompanyDivision.code` и
--      `DisplayScreenConfig.division::text = CompanyDivision.code`.
--
-- Legacy enum `OrderDivision` и колонки `Order.division`,
-- `DisplayScreenConfig.division` НЕ удаляем — это PHASE 2.

-- AlterTable: nullable FK на Order.
ALTER TABLE "Order" ADD COLUMN "companyDivisionId" TEXT;

-- AlterTable: nullable FK на DisplayScreenConfig.
ALTER TABLE "DisplayScreenConfig" ADD COLUMN "companyDivisionId" TEXT;

-- Backfill базовых карточек справочника. cuid()-генерация на стороне
-- Prisma — здесь используем gen_random_uuid()-style id через md5(),
-- чтобы миграция не зависела от расширений Postgres. Если карточка
-- с таким `code` уже есть — обновлять name/sortOrder не будем,
-- чтобы не перетереть менеджерские правки.
INSERT INTO "CompanyDivision" ("id", "code", "name", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES
  (
    'cmpdiv_marketplace',
    'MARKETPLACE',
    'Маркетплейс',
    NULL,
    TRUE,
    10,
    NOW(),
    NOW()
  ),
  (
    'cmpdiv_other',
    'OTHER',
    'B2B',
    NULL,
    TRUE,
    20,
    NOW(),
    NOW()
  )
ON CONFLICT ("code") DO NOTHING;

-- Backfill заказов по соответствию division::text = code.
UPDATE "Order" o
SET "companyDivisionId" = cd."id"
FROM "CompanyDivision" cd
WHERE o."division"::text = cd."code"
  AND o."companyDivisionId" IS NULL;

-- Backfill display-конфигов по тому же правилу.
UPDATE "DisplayScreenConfig" d
SET "companyDivisionId" = cd."id"
FROM "CompanyDivision" cd
WHERE d."division"::text = cd."code"
  AND d."companyDivisionId" IS NULL;

-- AddForeignKey: Order.companyDivisionId.
ALTER TABLE "Order" ADD CONSTRAINT "Order_companyDivisionId_fkey"
  FOREIGN KEY ("companyDivisionId") REFERENCES "CompanyDivision"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: DisplayScreenConfig.companyDivisionId.
ALTER TABLE "DisplayScreenConfig" ADD CONSTRAINT "DisplayScreenConfig_companyDivisionId_fkey"
  FOREIGN KEY ("companyDivisionId") REFERENCES "CompanyDivision"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex.
CREATE INDEX "Order_companyDivisionId_idx" ON "Order"("companyDivisionId");
CREATE INDEX "DisplayScreenConfig_companyDivisionId_idx" ON "DisplayScreenConfig"("companyDivisionId");
