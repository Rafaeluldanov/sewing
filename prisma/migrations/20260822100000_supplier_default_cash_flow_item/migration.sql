-- Поставщики: статья ДДС по умолчанию (казначейство).
-- Карточка поставщика получает необязательную ссылку на CashFlowItem —
-- она подставляется по умолчанию при создании оплаты/заявки поставщику.
-- Hard-FK c ON DELETE SET NULL: удаление статьи ДДС лишь обнуляет дефолт
-- у карточек поставщиков, сами карточки не трогает.
ALTER TABLE "Supplier" ADD COLUMN "defaultCashFlowItemId" TEXT;

CREATE INDEX "Supplier_defaultCashFlowItemId_idx" ON "Supplier"("defaultCashFlowItemId");

ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_defaultCashFlowItemId_fkey" FOREIGN KEY ("defaultCashFlowItemId") REFERENCES "CashFlowItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
