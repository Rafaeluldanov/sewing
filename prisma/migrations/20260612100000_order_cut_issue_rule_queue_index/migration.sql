-- Множественные очереди выдачи кроя: добавляем `queueIndex` в
-- `OrderCutIssueRule` и переносим уникальность на тройку
-- `(orderId, queueIndex, sizeId)`. Это позволяет менеджеру
-- последовательно создавать «партии выдачи» внутри одного заказа
-- (например, план 1000: очередь №1 — 150, очередь №2 — 850).
--
-- Подробности модели и инвариантов — в
-- `prisma/schema.prisma::OrderCutIssueRule`,
-- `apps/api/src/modules/order-cut-issue-rules/*`.
--
-- Backfill: все существующие строки получают `queueIndex = 1`.
-- Никаких удалений данных — старые очереди продолжают работать
-- как «очередь №1». Дефолт колонки 1 закрывает и историю, и
-- новые insert-ы без явного `queueIndex`.

ALTER TABLE "OrderCutIssueRule"
    ADD COLUMN "queueIndex" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "OrderCutIssueRule_orderId_sizeId_key";

CREATE UNIQUE INDEX "OrderCutIssueRule_orderId_queueIndex_sizeId_key"
    ON "OrderCutIssueRule"("orderId", "queueIndex", "sizeId");

CREATE INDEX "OrderCutIssueRule_orderId_queueIndex_isActive_idx"
    ON "OrderCutIssueRule"("orderId", "queueIndex", "isActive");
