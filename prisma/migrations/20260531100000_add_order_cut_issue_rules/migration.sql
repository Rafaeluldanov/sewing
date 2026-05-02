-- Этап «Очередь выдачи кроя по размерам» — таблица
-- `OrderCutIssueRule`. Менеджер заказа задаёт «первую очередь
-- выдачи кроя» по размерам (S — 70 шт, M — 50 шт, …); пока хотя
-- бы одна активная строка не выполнена (`issuedQty < requiredQty`),
-- `PassportsService.issueToEmployee` режет выдачу паспортов
-- размеров, отсутствующих в очереди.
--
-- Подробное описание модели и инвариантов — в
-- `prisma/schema.prisma::OrderCutIssueRule`,
-- `docs/domain.md §«Очередь выдачи кроя»`,
-- `docs/order-flow.md §«Очередь выдачи кроя»`,
-- `docs/production-flow.md §«Issue: очередь выдачи кроя»`.
--
-- Дизайн:
--   * `id` — `cuid()`-строка, как и во всех остальных таблицах;
--   * `(orderId, sizeId)` — UNIQUE: одна строка на «заказ × размер»,
--     это упрощает атомарный consume через conditional `updateMany`
--     (см. `OrderCutIssueRulesService.consumeInTx`);
--   * FK `orderId → Order` с `ON DELETE CASCADE` — без заказа
--     очередь смысла не имеет;
--   * FK `sizeId → Size` с `ON DELETE RESTRICT` — защита от
--     случайного удаления размера, на который завязана активная
--     очередь (на MVP такие удаления не делают, но инвариант
--     должен держаться на уровне БД);
--   * `requiredQty INTEGER NOT NULL` — валидация `> 0` и
--     `<= qtyPlan` происходит на сервисе;
--   * `issuedQty INTEGER NOT NULL DEFAULT 0` — атомарный инкремент
--     в той же транзакции, что и issue паспорта, через conditional
--     `updateMany({ where: { id, isActive: true,
--     issuedQty: { lte: requiredQty - qty } } })`;
--   * `sortOrder INTEGER NOT NULL DEFAULT 0` — управляемый менеджером
--     порядок строк в UI и сообщении блокировки;
--   * `isActive BOOLEAN NOT NULL DEFAULT true` — отключение очереди
--     не сбрасывает счётчики (история остаётся в БД, см. ТЗ);
--   * `createdById TEXT NULL` — кто завёл/обновил, без FK (учётка
--     может быть деактивирована, строка очереди должна жить);
--   * `updatedAt` — без `DEFAULT now()`, обновляется prisma на
--     каждом `update` (поведение `@updatedAt`).
--
-- Индексы:
--   * `(orderId, isActive)` — горячий запрос «найти активные строки
--     очереди заказа» (используется в `evaluateForIssue` /
--     `listForOrder`);
--   * `(sizeId)` — поиск всех очередей по размеру (для аналитики).

CREATE TABLE "OrderCutIssueRule" (
    "id"          TEXT         NOT NULL,
    "orderId"     TEXT         NOT NULL,
    "sizeId"      TEXT         NOT NULL,
    "requiredQty" INTEGER      NOT NULL,
    "issuedQty"   INTEGER      NOT NULL DEFAULT 0,
    "sortOrder"   INTEGER      NOT NULL DEFAULT 0,
    "isActive"    BOOLEAN      NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCutIssueRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderCutIssueRule_orderId_sizeId_key"
    ON "OrderCutIssueRule"("orderId", "sizeId");

CREATE INDEX "OrderCutIssueRule_orderId_isActive_idx"
    ON "OrderCutIssueRule"("orderId", "isActive");

CREATE INDEX "OrderCutIssueRule_sizeId_idx"
    ON "OrderCutIssueRule"("sizeId");

ALTER TABLE "OrderCutIssueRule"
    ADD CONSTRAINT "OrderCutIssueRule_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderCutIssueRule"
    ADD CONSTRAINT "OrderCutIssueRule_sizeId_fkey"
    FOREIGN KEY ("sizeId") REFERENCES "Size"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
