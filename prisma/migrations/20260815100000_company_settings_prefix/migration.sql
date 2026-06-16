-- Поле «Префикс» организации (см. `prisma/schema.prisma::CompanySettings`,
-- UI `/admin/company-settings`). Опциональный строковый реквизит рядом с
-- `shortName`. Пока используется только как реквизит в форме; в будущем
-- пойдёт в номер заказа.
ALTER TABLE "CompanySettings"
  ADD COLUMN "prefix" TEXT;
