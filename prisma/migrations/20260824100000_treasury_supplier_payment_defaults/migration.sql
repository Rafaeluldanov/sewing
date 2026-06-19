-- Казначейство: счёт и статья ДДС по умолчанию для оплат поставщикам.
-- Если задан supplierAccountId, создание заявки на оплату внутри заказа
-- поставщику автоматически формирует по каждому этапу черновик «заявки
-- на расход» (SupplierPayment) на этом счёте; supplierItemId — fallback
-- статьи ДДС, если в заявке она не выбрана. Связи soft (без FK).
ALTER TABLE "TreasurySettings" ADD COLUMN "supplierAccountId" TEXT;
ALTER TABLE "TreasurySettings" ADD COLUMN "supplierItemId" TEXT;
