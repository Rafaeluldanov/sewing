import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Генерация номера заказа вида `O-YYYYMMDD-NNNN`, где NNNN — суточный
 * счётчик (дополняется нулями до 4 знаков).
 *
 * Реализация: ищем последний номер за сегодня по префиксу и инкрементим
 * локально. Вызывать ВНУТРИ транзакции с SERIALIZABLE/REPEATABLE READ;
 * для MVP и малого RPS хватает дефолтного уровня — вероятность коллизии
 * мала, а `Order.number` UNIQUE всё равно защитит (в случае гонки клиент
 * просто ретраит запрос).
 */
@Injectable()
export class OrderNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<string> {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const prefix = `O-${yyyy}${mm}${dd}-`;

    const last = await tx.order.findFirst({
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
