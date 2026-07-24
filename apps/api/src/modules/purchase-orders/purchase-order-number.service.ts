import { Injectable } from '@nestjs/common';
import { moscowDateParts } from '../../common/moscow-date.js';
import type { Prisma } from '@prisma/client';

/**
 * Генерация номера закупочного документа вида `PO-YYYYMMDD-NNNN`,
 * где `NNNN` — суточный счётчик (дополняется нулями до 4 знаков).
 *
 * По той же схеме, что `OrderNumberService.nextNumber()`. Вызывать
 * ВНУТРИ транзакции; для MVP и малого RPS хватает дефолтного уровня
 * изоляции — вероятность коллизии мала, а `PurchaseOrder.number`
 * UNIQUE всё равно защитит (при гонке клиент просто ретраит запрос).
 */
@Injectable()
export class PurchaseOrderNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<string> {
    const { yyyy, mm, dd } = moscowDateParts(now);
    const prefix = `PO-${yyyy}${mm}${dd}-`;

    const last = await tx.purchaseOrder.findFirst({
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
