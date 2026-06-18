-- Сотрудники: статья ДДС для выплат зарплаты (казначейство).
-- Карточка сотрудника получает необязательную ссылку на CashFlowItem —
-- при выдаче выплаты (PayrollPayout.ISSUED) расходная проводка журнала ДС
-- берёт именно эту статью, переопределяя глобальную
-- TreasurySettings.salaryItemId (см. TreasuryService.postPayrollPayoutTx).
-- Hard-FK c ON DELETE SET NULL: удаление статьи ДДС лишь обнуляет привязку
-- у карточек сотрудников, сами карточки не трогает.
ALTER TABLE "Employee" ADD COLUMN "salaryCashFlowItemId" TEXT;

CREATE INDEX "Employee_salaryCashFlowItemId_idx" ON "Employee"("salaryCashFlowItemId");

ALTER TABLE "Employee" ADD CONSTRAINT "Employee_salaryCashFlowItemId_fkey" FOREIGN KEY ("salaryCashFlowItemId") REFERENCES "CashFlowItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
