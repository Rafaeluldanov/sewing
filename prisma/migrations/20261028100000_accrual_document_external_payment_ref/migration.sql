-- Проведение документа начисления из ERP: ссылка на её заявку на оплату.
ALTER TABLE "PayrollAccrualDocument" ADD COLUMN "externalPaymentRef" JSONB;
