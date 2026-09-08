import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { moscowDateParts } from '../../common/moscow-date.js';

/**
 * Номер документа выпуска — `ПР-YYYYMMDD-NNNN`, суточный счётчик по Москве.
 *
 * Симметрично `PassportNumberService` и `OrderNumberService`: один формат номеров на весь цех,
 * чтобы «ПР-20260908-0003» читалось так же, как «P-20260908-0012».
 *
 * Вызывать ВНУТРИ транзакции. Уникальность дополнительно держит `ProductionDocument.number
 * @unique` — на гонке двух закрытий вторая транзакция упадёт и ретрайнется.
 */
@Injectable()
export class ProductionDocumentNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<string> {
    const { yyyy, mm, dd } = moscowDateParts(now);
    const prefix = `ПР-${yyyy}${mm}${dd}-`;

    const last = await tx.productionDocument.findFirst({
      where: { number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    let next = 1;
    if (last?.number) {
      const parsed = Number.parseInt(last.number.slice(prefix.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) next = parsed + 1;
    }
    return `${prefix}${String(next).padStart(4, '0')}`;
  }
}
