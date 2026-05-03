-- Этап «Фактический расход материалов по заказу» (см.
-- `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
-- `apps/api/src/modules/material-issues/*`,
-- `docs/api.md §«Material issues»`).
--
-- MVP-итерация: документы ручного расхода материалов с заголовком и
-- строками. Фиксируем количество, цену, ячейку и комментарий — БЕЗ
-- складских остатков, БЕЗ движений (`StockMovement`), БЕЗ FIFO/LIFO,
-- БЕЗ автосписания при выдаче кроя.
--
-- Дизайн миграции:
--   * Добавляем две новые таблицы — `MaterialIssue` и
--     `MaterialIssueLine` (плюс индексы и FK).
--   * НЕ трогаем `Order` / `Passport` / `WorkshopNeed` / `Cell` /
--     `Employee` / `PurchaseReceipt*` / `CellContent` / прочие
--     существующие таблицы — миграция чисто additive.
--   * `status` хранится как TEXT (без Postgres enum), список
--     валидируется Zod-ом на API
--     (см. `@sewing/shared/material-issues::MATERIAL_ISSUE_STATUSES`).
--   * Decimal-точность согласована с соседними модулями:
--       - `issuedQty`        DECIMAL(14,4) (как у
--         `WorkshopNeed.calculatedQty` / `purchaseQty` /
--         `PurchaseReceiptLine.receivedQty`);
--       - `unitCost`/`totalCost` DECIMAL(14,2) (как у
--         `WorkshopNeed.quotedPrice` / `OrderCostEstimateLine.unitPriceRub`).
--   * FK-стратегия:
--       - MaterialIssue.orderId        → Order.id            ON DELETE CASCADE
--       - MaterialIssue.passportId     → Passport.id         ON DELETE SET NULL
--       - MaterialIssueLine.materialIssueId → MaterialIssue.id ON DELETE CASCADE
--       - MaterialIssueLine.workshopNeedId  → WorkshopNeed.id  ON DELETE SET NULL
--       - MaterialIssueLine.cellId          → Cell.id          ON DELETE SET NULL

CREATE TABLE "MaterialIssue" (
    "id"            TEXT          NOT NULL,
    "orderId"       TEXT          NOT NULL,
    "passportId"    TEXT,
    "status"        TEXT          NOT NULL DEFAULT 'DRAFT',
    "totalCost"     DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt"      TIMESTAMP(3),
    "cancelledAt"   TIMESTAMP(3),
    "createdById"   TEXT,
    "postedById"    TEXT,
    "cancelledById" TEXT,
    "cancelReason"  TEXT,

    CONSTRAINT "MaterialIssue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaterialIssue_orderId_idx"    ON "MaterialIssue"("orderId");
CREATE INDEX "MaterialIssue_passportId_idx" ON "MaterialIssue"("passportId");
CREATE INDEX "MaterialIssue_status_idx"     ON "MaterialIssue"("status");
CREATE INDEX "MaterialIssue_createdAt_idx"  ON "MaterialIssue"("createdAt");

ALTER TABLE "MaterialIssue"
  ADD CONSTRAINT "MaterialIssue_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaterialIssue"
  ADD CONSTRAINT "MaterialIssue_passportId_fkey"
    FOREIGN KEY ("passportId") REFERENCES "Passport"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MaterialIssueLine" (
    "id"              TEXT          NOT NULL,
    "materialIssueId" TEXT          NOT NULL,
    "workshopNeedId"  TEXT,
    "description"     TEXT          NOT NULL,
    "materialRole"    TEXT,
    "unit"            TEXT          NOT NULL,
    "issuedQty"       DECIMAL(14,4) NOT NULL,
    "unitCost"        DECIMAL(14,2) NOT NULL,
    "totalCost"       DECIMAL(14,2) NOT NULL,
    "cellId"          TEXT,
    "comment"         TEXT,

    CONSTRAINT "MaterialIssueLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaterialIssueLine_materialIssueId_idx" ON "MaterialIssueLine"("materialIssueId");
CREATE INDEX "MaterialIssueLine_workshopNeedId_idx"  ON "MaterialIssueLine"("workshopNeedId");
CREATE INDEX "MaterialIssueLine_cellId_idx"          ON "MaterialIssueLine"("cellId");

ALTER TABLE "MaterialIssueLine"
  ADD CONSTRAINT "MaterialIssueLine_materialIssueId_fkey"
    FOREIGN KEY ("materialIssueId") REFERENCES "MaterialIssue"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaterialIssueLine"
  ADD CONSTRAINT "MaterialIssueLine_workshopNeedId_fkey"
    FOREIGN KEY ("workshopNeedId") REFERENCES "WorkshopNeed"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MaterialIssueLine"
  ADD CONSTRAINT "MaterialIssueLine_cellId_fkey"
    FOREIGN KEY ("cellId") REFERENCES "Cell"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
