-- Заявки на оплату поставщику: статья ДДС (казначейство).
-- Soft-ссылка на CashFlowItem (без FK, как supplierId) + снимок имени.
-- По умолчанию подставляется из карточки поставщика
-- (Supplier.defaultCashFlowItemId), в форме заявки редактируема. Снимок
-- имени переживает переименование/удаление статьи ДДС.
ALTER TABLE "SupplierPaymentRequest" ADD COLUMN "cashFlowItemId" TEXT;
ALTER TABLE "SupplierPaymentRequest" ADD COLUMN "cashFlowItemNameSnapshot" TEXT;

CREATE INDEX "SupplierPaymentRequest_cashFlowItemId_idx" ON "SupplierPaymentRequest"("cashFlowItemId");
