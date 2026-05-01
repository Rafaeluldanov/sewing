import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Генерация номера паспорта вида `P-YYYYMMDD-NNNN`, где NNNN — суточный
 * счётчик (дополняется нулями до 4 знаков). Полностью симметрична с
 * `OrderNumberService` (см. `docs/domain.md §5`).
 *
 * Вызывать ВНУТРИ транзакции. Уникальность дополнительно защищена
 * `Passport.number @unique` — в случае гонки клиент просто ретраит запрос.
 */
@Injectable()
export class PassportNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<string> {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const prefix = `P-${yyyy}${mm}${dd}-`;

    const last = await tx.passport.findFirst({
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
