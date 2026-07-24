import { Injectable } from '@nestjs/common';
import { moscowDateParts } from '../../common/moscow-date.js';
import type { Prisma } from '@prisma/client';

/**
 * Генерация номера заказа.
 *
 * Основная схема (заказ привязан к подразделению): `КОД-NNNNN`, где `КОД`
 * — код подразделения (`CompanyDivision.code`), а `NNNNN` — сквозной
 * счётчик В ПРЕДЕЛАХ подразделения, дополненный нулями до 5 знаков
 * (например, `01-00001`, `01-00002`, `02-00001`). Номер сразу говорит,
 * какому подразделению принадлежит заказ.
 *
 * Фолбэк (подразделение не указано — напр. черновик из КБ): прежняя
 * суточная схема `O-YYYYMMDD-NNNN`. Существующие заказы НЕ
 * перенумеровываем — новая схема действует только для новых заказов.
 *
 * Счётчик считаем «найти максимум по префиксу + 1». Это корректно
 * благодаря фиксированной ширине хвоста (лексикографический `desc`
 * совпадает с числовым). Вызывать ВНУТРИ транзакции; `Order.number`
 * UNIQUE защищает от гонки — при коллизии клиент ретраит запрос, как и в
 * остальных `*NumberService`.
 */
@Injectable()
export class OrderNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    companyDivisionId?: string | null,
    now: Date = new Date(),
  ): Promise<string> {
    // Новая схема: код подразделения + счётчик per-подразделение.
    if (companyDivisionId) {
      const division = await tx.companyDivision.findUnique({
        where: { id: companyDivisionId },
        select: { code: true },
      });
      const code = division?.code?.trim();
      if (code) {
        return this.nextByPrefix(tx, `${code}-`, 5);
      }
    }

    // Фолбэк: суточная схема `O-YYYYMMDD-NNNN` (заказ без подразделения).
    const { yyyy, mm, dd } = moscowDateParts(now);
    return this.nextByPrefix(tx, `O-${yyyy}${mm}${dd}-`, 4);
  }

  /**
   * Найти последний `Order.number` с данным префиксом и вернуть
   * `prefix + (N + 1)`, дополнив хвост нулями до `width` знаков.
   */
  private async nextByPrefix(
    tx: Prisma.TransactionClient,
    prefix: string,
    width: number,
  ): Promise<string> {
    const last = await tx.order.findFirst({
      where: { number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    let next = 1;
    if (last?.number) {
      const parsed = Number.parseInt(last.number.slice(prefix.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        next = parsed + 1;
      }
    }
    return `${prefix}${String(next).padStart(width, '0')}`;
  }
}
