/**
 * Unit-тесты `OrderNumberService` — нумерация заказа цеха.
 *
 * Решение владельца ERP 07.09.2026: заказы цеха нумеруются ПО ПРАВИЛАМ ERP —
 * префикс организации из настроек цеха плюс сквозной счётчик в шесть знаков
 * (`ФС-000001`). Прежние схемы остаются запасными: код подразделения
 * (`02-00043`) и суточная (`O-YYYYMMDD-NNNN`).
 *
 * Здесь закрепляется то, что легко сломать молча:
 *   - префикс главнее подразделения (иначе настройка ничего не меняет);
 *   - счёт идёт внутри префикса и продолжается, а не начинается заново;
 *   - смена схемы не путает счётчик: «02-00043» рядом с «02-000044»
 *     лексикографически больше, и наивный `desc` выдал бы номер-дубль;
 *   - существующие заказы не перенумеровываются — сервис их только читает.
 */
import { describe, expect, test } from 'vitest';

import { OrderNumberService } from '../../apps/api/src/modules/orders/order-number.service.js';

type Row = { number: string };

/** Подделка транзакции Prisma: только то, что читает сервис. */
function tx(opts: { prefix?: string | null; division?: string | null; orders?: string[] }) {
  const orders: Row[] = (opts.orders ?? []).map((number) => ({ number }));
  const byPrefix = (where: { number?: { startsWith?: string } }): Row[] => {
    const p = where?.number?.startsWith ?? '';
    return orders.filter((o) => o.number.startsWith(p));
  };
  return {
    companySettings: {
      findUnique: async () => (opts.prefix === undefined ? null : { prefix: opts.prefix }),
    },
    companyDivision: {
      findUnique: async () => (opts.division ? { code: opts.division } : null),
    },
    order: {
      findFirst: async ({ where }: { where: { number: { startsWith: string } } }) => {
        const rows = byPrefix(where).sort((a, b) => (a.number < b.number ? 1 : -1));
        return rows[0] ?? null;
      },
      findMany: async ({ where }: { where: { number: { startsWith: string } } }) => byPrefix(where),
    },
  } as never;
}

const svc = new OrderNumberService();
const DAY = new Date('2026-09-07T09:00:00Z');

describe('нумерация заказа цеха по правилам ERP', () => {
  test('префикс организации ERP главнее кода подразделения', async () => {
    const n = await svc.nextNumber(tx({ prefix: 'ФС', division: '02' }), 'div-1', DAY);
    expect(n).toBe('ФС-000001');
  });

  test('счёт продолжается внутри префикса', async () => {
    const n = await svc.nextNumber(
      tx({ prefix: 'ФС', orders: ['ФС-000001', 'ФС-000011', 'ФС-000002'] }),
      null,
      DAY,
    );
    expect(n).toBe('ФС-000012');
  });

  test('чужой префикс в счёт не идёт', async () => {
    const n = await svc.nextNumber(tx({ prefix: 'ФС', orders: ['ИП-000042', '02-00043'] }), null, DAY);
    expect(n).toBe('ФС-000001');
  });

  test('старые номера прежней ширины не ломают счётчик', async () => {
    // «02-00043» лексикографически больше «02-000044»: наивный `desc` дал бы дубль.
    const n = await svc.nextNumber(
      tx({ prefix: '02', orders: ['02-00043', '02-000044', '02-000045'] }),
      null,
      DAY,
    );
    expect(n).toBe('02-000046');
  });

  test('без префикса работает прежняя схема подразделения', async () => {
    const n = await svc.nextNumber(
      tx({ prefix: null, division: '02', orders: ['02-00043'] }),
      'div-1',
      DAY,
    );
    expect(n).toBe('02-00044');
  });

  test('без префикса и подразделения — суточная схема', async () => {
    const n = await svc.nextNumber(tx({ prefix: '   ', division: null }), null, DAY);
    expect(n).toBe('O-20260907-0001');
  });
});
