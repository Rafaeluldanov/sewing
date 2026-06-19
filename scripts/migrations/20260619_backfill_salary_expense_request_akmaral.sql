-- Бэкфилл заявки на расход (SupplierPayment, kind=SALARY) по уже выданной
-- выплате зарплаты.
--
-- Контекст: фича «выплата создаёт заявку на расход» (commit ab8d278)
-- задеплочена на прод 2026-06-19 06:03:54. Выплата сотруднику Абдырахман
-- кызы Акмарал (payoutId=cmqkjerjo000hckgrfv1zt96x, 54526.00 ₽) была выдана
-- в 06:17:55 — на ~12 минут РАНЬШЕ, чем в Казначейство → Настройки задали
-- зарплатный счёт (TreasurySettings.updatedAt = 06:29:33). На момент выдачи
-- createSalaryExpenseRequestTx сработал в опт-ин-ветке «нет salaryAccountId»
-- (см. лог TreasuryService «salary expense request skipped») и заявку не создал.
--
-- Заявка создаётся только в момент выдачи и не восстанавливается задним
-- числом, поэтому добиваем её вручную — ровно так, как сделал бы код:
-- счёт = TreasurySettings.salaryAccountId, статья = Employee.salaryCashFlowItemId
-- (fallback на глобальную salaryItemId), сумма = PayrollPayout.amountTotalRub,
-- статус DRAFT. Идемпотентно (NOT EXISTS по payrollPayoutId @unique).
--
-- Применено на проде 2026-06-19.

INSERT INTO "SupplierPayment" (
  id, kind, "supplierId", "supplierNameSnapshot",
  "employeeId", "employeeNameSnapshot", "payrollPayoutId",
  "purchaseOrderId", "purchaseOrderNumberSnapshot",
  "accountId", "itemId", amount, status, comment,
  "cashFlowEntryId", "createdById", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'SALARY'::"ExpensePaymentKind",
  NULL, NULL,
  p."employeeId",
  e."fullName",
  p.id,
  NULL, NULL,
  s."salaryAccountId",
  COALESCE(e."salaryCashFlowItemId", s."salaryItemId"),
  p."amountTotalRub",
  'DRAFT'::"SupplierPaymentStatus",
  'Бэкфилл: заявка по выплате (зарплатный счёт настроен после выдачи)',
  NULL,
  p."issuedById",
  now(), now()
FROM "PayrollPayout" p
JOIN "Employee" e ON e.id = p."employeeId"
CROSS JOIN "TreasurySettings" s
WHERE p.id = 'cmqkjerjo000hckgrfv1zt96x'
  AND s.id = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM "SupplierPayment" sp WHERE sp."payrollPayoutId" = p.id
  );
