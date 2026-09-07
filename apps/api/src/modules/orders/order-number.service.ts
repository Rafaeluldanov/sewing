import { Injectable } from '@nestjs/common';
import { moscowDateParts } from '../../common/moscow-date.js';
import type { Prisma } from '@prisma/client';

/**
 * Генерация номера заказа.
 *
 * Главная схема (решение владельца ERP 07.09.2026): нумерация ПО ПРАВИЛАМ ERP —
 * `ПРФ-NNNNNN`, где `ПРФ` — префикс организации ERP из настроек цеха
 * (`CompanySettings.prefix`), а `NNNNNN` — сквозной счётчик внутри префикса,
 * дополненный нулями до 6 знаков (`ФС-000001`, `ФС-000002`). Ровно так
 * нумеруются документы в ERP (`erp/core/numerator.py`), и заказ цеха виден
 * там же, где её собственные: в журнале потребностей, в структуре
 * подчинённости заказа покупателя, в сдаче. Пока префикс не задан, схема
 * не действует — заполняется он в ERP, экран «Настройки цеха».
 *
 * Прежняя схема (префикса нет, заказ привязан к подразделению): `КОД-NNNNN`
 * по коду подразделения (`CompanyDivision.code`), 5 знаков.
 * Фолбэк (нет ни префикса, ни подразделения — напр. черновик из КБ):
 * суточная схема `O-YYYYMMDD-NNNN`.
 *
 * ⛔ Существующие заказы НЕ перенумеровываются никогда: номер напечатан на
 * бумагах цеха и стоит ссылкой в ERP. Смена префикса начинает НОВЫЙ счёт с
 * первого номера, старые заказы остаются со своими.
 *
 * Счётчик — «максимум по префиксу + 1». Вызывать ВНУТРИ транзакции;
 * `Order.number` UNIQUE защищает от гонки — при коллизии клиент ретраит
 * запрос, как и в остальных `*NumberService`.
 */
@Injectable()
export class OrderNumberService {
  async nextNumber(
    tx: Prisma.TransactionClient,
    companyDivisionId?: string | null,
    now: Date = new Date(),
  ): Promise<string> {
    // Правила ERP: префикс организации + 6 знаков. Настройка одна на цех, поэтому и
    // счёт один — как у типа документа в ERP (там ключ счётчика «тип:префикс»).
    const settings = await tx.companySettings.findUnique({
      where: { id: 'default' },
      select: { prefix: true },
    });
    const erpPrefix = settings?.prefix?.trim();
    if (erpPrefix) {
      return this.nextByPrefix(tx, `${erpPrefix}-`, 6);
    }

    // Прежняя схема: код подразделения + счётчик per-подразделение.
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

    // Лексикографический максимум совпадает с числовым, только пока ВСЕ хвосты одной
    // ширины. Смена схемы это ломает («02-00043» против «02-000044»), поэтому строку с
    // чужой шириной не разбираем, а честно ищем максимум по всему префиксу. Ветка редкая:
    // после первого номера новой схемы верх списка снова однороден.
    const tail = last?.number.slice(prefix.length);
    if (tail !== undefined && !this.isTail(tail, width)) {
      const all = await tx.order.findMany({
        where: { number: { startsWith: prefix } },
        select: { number: true },
      });
      const max = all.reduce((acc, r) => {
        const t = r.number.slice(prefix.length);
        return this.isTail(t, width) ? Math.max(acc, Number.parseInt(t, 10)) : acc;
      }, 0);
      return `${prefix}${String(max + 1).padStart(width, '0')}`;
    }

    let next = 1;
    if (tail !== undefined) {
      const parsed = Number.parseInt(tail, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        next = parsed + 1;
      }
    }
    return `${prefix}${String(next).padStart(width, '0')}`;
  }

  /** Хвост номера «своей» схемы: ровно `width` цифр. */
  private isTail(tail: string, width: number): boolean {
    return tail.length === width && /^\d+$/.test(tail);
  }
}
