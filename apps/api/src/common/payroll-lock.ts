import { Prisma } from '@prisma/client';

/**
 * Транзакционный advisory-lock ЗП по сотруднику.
 *
 * Берётся ПЕРВЫМ шагом в `PayrollPayoutsService.rebuildLines` (payout
 * create / issue / recompute) И в `PayrollAccrualDocumentsService.pay()` — с
 * ОДИНАКОВЫМ ключом, чтобы сериализовать выплату и проведение накопительного
 * документа для одного сотрудника. Закрывает окно двойной оплаты: проверка
 * «строка начисления не в активной выплате» и вставка `PayrollPayoutLine` —
 * это check-then-insert TOCTOU, а на PayrollPayoutLine нет DB-уникальности по
 * operationEntryId/salaryEntryId (сознательно, чтобы CANCELLED-выплата
 * освобождала строку), и транзакции идут на дефолтном READ COMMITTED. Без
 * блокировки два конкурентных `issue()`/`pay()` по одной записи оба проходят
 * SELECT и оба коммитят строки → запись оплачивается дважды.
 *
 * `pg_advisory_xact_lock` держится до COMMIT/ROLLBACK и реентерабелен внутри
 * одной транзакции. Ключ — `hashtext('payroll-employee:'+id)` в namespace `1`.
 * Несколько сотрудников в одной транзакции блокируем в ОТСОРТИРОВАННОМ порядке
 * (см. вызов в `pay()`), иначе возможен deadlock со встречной транзакцией.
 */
export async function lockEmployeePayrollTx(
  tx: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${
    'payroll-employee:' + employeeId
  }), 1)`;
}
