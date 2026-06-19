import { Injectable } from '@nestjs/common';
import { ExpensePaymentKind, type Prisma } from '@prisma/client';

/**
 * Генерация номера заявки на расход (`SupplierPayment`) вида
 * `ПРЕФИКС-YYYYMMDD-NNNN`, где `NNNN` — суточный счётчик на префикс.
 * Префикс зависит от вида расхода:
 *   - `ЗП-` — выплата зарплаты (`kind = SALARY`);
 *   - `РС-` — расход поставщику (`kind = SUPPLIER`).
 *
 * Зеркалит `SupplierPaymentRequestNumberService` (там `PR-`). Вызывать
 * ВНУТРИ транзакции; `SupplierPayment.number` UNIQUE защищает от гонки
 * (клиент ретраит при коллизии).
 */
const KIND_PREFIX: Record<ExpensePaymentKind, string> = {
  [ExpensePaymentKind.SALARY]: 'ЗП',
  [ExpensePaymentKind.SUPPLIER]: 'РС',
};

@Injectable()
export class ExpensePaymentNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    kind: ExpensePaymentKind,
    now: Date = new Date(),
  ): Promise<string> {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const prefix = `${KIND_PREFIX[kind]}-${yyyy}${mm}${dd}-`;

    const last = await tx.supplierPayment.findFirst({
      where: { number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    let next = 1;
    if (last?.number) {
      const tail = last.number.slice(prefix.length);
      const parsed = Number.parseInt(tail, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        next = parsed + 1;
      }
    }
    return `${prefix}${String(next).padStart(4, '0')}`;
  }
}
