-- Stage «Clients & Order due date» — справочник клиентов и срок сдачи
-- заказа. См. `docs/domain.md §«Клиенты»` и `prisma/schema.prisma`
-- (`model Client`, `model Order`).
--
-- Дизайн:
--   * `Client` — простой soft-delete справочник: `isActive=false` вместо
--     `DELETE`. Уникальность `name` сознательно не накладываем (см.
--     комментарий в `schema.prisma`).
--   * `Order.clientId` — NULLable FK с `ON DELETE SET NULL`, чтобы
--     удаление карточки клиента (если когда-нибудь будет) не сносило
--     заказы и не ломало истории. Существующие заказы остаются без
--     явной связи (`NULL`) — управленческое поле `customer` не трогаем.
--   * `Order.dueDate` уже существовало в Prisma-схеме; добавляем
--     отдельный индекс под фильтры/сортировки по сроку.
--   * Индексы: `(isActive)` и `(name)` на `Client` под список
--     `/admin/clients` (фильтр + поиск/сортировка по имени);
--     `(clientId)` и `(dueDate)` на `Order` под фильтры по клиенту
--     и по сроку.

CREATE TABLE "Client" (
    "id"        TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "phone"     TEXT,
    "email"     TEXT,
    "comment"   TEXT,
    "isActive"  BOOLEAN      NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Client_isActive_idx" ON "Client"("isActive");
CREATE INDEX "Client_name_idx" ON "Client"("name");

ALTER TABLE "Order"
  ADD COLUMN "clientId" TEXT;

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Order_clientId_idx" ON "Order"("clientId");
CREATE INDEX "Order_dueDate_idx" ON "Order"("dueDate");
