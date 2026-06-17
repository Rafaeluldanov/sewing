import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Генерация номера заявки на оплату вида `PR-YYYYMMDD-NNNN`
 * (`PR` = Payment Request), где `NNNN` — суточный счётчик.
 *
 * Зеркалит `PurchaseOrderNumberService`. Вызывать ВНУТРИ транзакции;
 * для MVP/малого RPS хватает дефолтного уровня изоляции — `number`
 * UNIQUE защищает от гонки (клиент ретраит при коллизии).
 */
@Injectable()
export class SupplierPaymentRequestNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<string> {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const prefix = `PR-${yyyy}${mm}${dd}-`;

    const last = await tx.supplierPaymentRequest.findFirst({
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
