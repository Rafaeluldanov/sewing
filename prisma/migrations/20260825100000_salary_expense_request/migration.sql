-- Обобщение заявки на расход (SupplierPayment): помимо оплаты поставщику
-- документ теперь представляет и выплату зарплаты сотруднику. Заявка
-- kind=SALARY создаётся автоматически при «Выплатить» в зарплатах; проводка
-- журнала ДС пишется на шаге «Оплатить» заявку (как у поставщика).

-- Вид заявки на расход.
CREATE TYPE "ExpensePaymentKind" AS ENUM ('SUPPLIER', 'SALARY');

-- Контрагент по поставщику становится необязательным (у зарплаты его нет).
ALTER TABLE "SupplierPayment" ALTER COLUMN "supplierId" DROP NOT NULL;
ALTER TABLE "SupplierPayment" ALTER COLUMN "supplierNameSnapshot" DROP NOT NULL;

-- Вид + контрагент-сотрудник + привязка к выплате.
ALTER TABLE "SupplierPayment" ADD COLUMN "kind" "ExpensePaymentKind" NOT NULL DEFAULT 'SUPPLIER';
ALTER TABLE "SupplierPayment" ADD COLUMN "employeeId" TEXT;
ALTER TABLE "SupplierPayment" ADD COLUMN "employeeNameSnapshot" TEXT;
ALTER TABLE "SupplierPayment" ADD COLUMN "payrollPayoutId" TEXT;

-- Одна заявка на расход на одну выплату (идемпотентность авто-создания).
CREATE UNIQUE INDEX "SupplierPayment_payrollPayoutId_key" ON "SupplierPayment"("payrollPayoutId");
CREATE INDEX "SupplierPayment_employeeId_idx" ON "SupplierPayment"("employeeId");
CREATE INDEX "SupplierPayment_kind_idx" ON "SupplierPayment"("kind");
