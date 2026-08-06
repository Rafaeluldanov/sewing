/**
 * Integration-тесты пула накладных в отчёте «Материалы: план → факт по
 * заказу» (`GET /api/costs/actual-materials`,
 * `apps/api/src/modules/costs/order-actual-materials.service.ts`).
 *
 * Сторожим ровно то, что чинилось:
 *   1. без периода накладные НЕ распределяются вовсе (раньше пул брался
 *      за всю историю компании и целиком падал на горстку заказов с
 *      приёмками — «полная факт» раздувалась в разы);
 *   2. с периодом в пул попадают только проводки этого окна;
 *   3. СТОРНО уменьшает период ИСХОДНОЙ проводки, а не тот, в котором
 *      нажали «Сторно»: `TreasuryService.storno` пишет отмену с
 *      `postedAt = сейчас`, и наивный фильтр по окну вычитал бы отмену
 *      прошлогоднего расхода из текущего месяца — пул уходил в минус и
 *      клэмпом молча превращался в ноль.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — накладные в отчёте «план → факт по заказу»', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookie = loginAs(t, seed.employees['shop-chief']);
  });

  /** Проводка по статье накладных. */
  async function postOverhead(opts: {
    itemId: string;
    accountId: string;
    amountRub: number;
    postedAt: string;
    direction?: 'IN' | 'OUT';
    isStorno?: boolean;
    reversalOfId?: string;
  }): Promise<string> {
    const row = await t.prisma.cashFlowEntry.create({
      data: {
        accountId: opts.accountId,
        itemId: opts.itemId,
        direction: opts.direction ?? 'OUT',
        amount: new Prisma.Decimal(opts.amountRub),
        registrarType: opts.isStorno ? 'STORNO' : 'MANUAL',
        // Уникальность проводки — по (registrarType, registrarId, lineNo,
        // isStorno), поэтому каждой свой регистратор.
        registrarId: `test-${Math.random().toString(36).slice(2, 10)}`,
        postedAt: new Date(opts.postedAt),
        isStorno: opts.isStorno ?? false,
        reversalOfId: opts.reversalOfId,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Заказ с проведённой приёмкой — чтобы у отчёта была база
   * распределения (без неё он выходит ранним return-ом).
   */
  async function orderWithReceipt(receivedAt: string): Promise<string> {
    const order = await t.prisma.order.create({
      data: {
        number: `O-OVH-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(receivedAt),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 10,
          },
        },
      },
      select: { id: true },
    });
    const supplier = await t.prisma.supplier.create({
      data: { name: `Поставщик ${Math.random().toString(36).slice(2, 6)}` },
      select: { id: true, name: true },
    });
    const po = await t.prisma.purchaseOrder.create({
      data: {
        number: `PO-OVH-${Math.random().toString(36).slice(2, 8)}`,
        supplierId: supplier.id,
        supplierNameSnapshot: supplier.name,
        status: 'POSTED',
      },
      select: { id: true },
    });
    const receipt = await t.prisma.purchaseReceipt.create({
      data: {
        number: `PR-OVH-${Math.random().toString(36).slice(2, 8)}`,
        status: 'POSTED',
        purchaseOrderId: po.id,
        customerOrderId: order.id,
        receivedAt: new Date(receivedAt),
        lines: {
          create: {
            status: 'POSTED',
            itemNameSnapshot: 'Кулирка',
            unitSnapshot: 'кг',
            unit: 'кг',
            receivedQty: new Prisma.Decimal(10),
            priceSnapshot: new Prisma.Decimal(1000),
            currencySnapshot: 'RUB',
          },
        },
      },
      select: { id: true },
    });
    expect(receipt.id).toBeTruthy();
    return order.id;
  }

  async function report(params?: { dateFrom?: string; dateTo?: string }) {
    const res = await request(t.app.getHttpServer())
      .get('/api/costs/actual-materials')
      .query(params ?? {})
      .set('Cookie', cookie)
      .expect(200);
    return res.body as {
      totalOverheadRub: string;
      totalFullCostFactRub: string;
      totalFactDirectRub: string;
      overheadPeriod: { dateFrom: string; dateTo: string } | null;
      rows: Array<{ overheadRub: string }>;
    };
  }

  async function overheadFixture() {
    const account = await t.prisma.cashAccount.create({
      data: { kind: 'BANK', name: 'Счёт' },
      select: { id: true },
    });
    const item = await t.prisma.cashFlowItem.create({
      data: { name: 'Аренда', isOverhead: true },
      select: { id: true },
    });
    return { accountId: account.id, itemId: item.id };
  }

  test('без периода накладные не распределяются вовсе', async () => {
    const { accountId, itemId } = await overheadFixture();
    await orderWithReceipt('2026-08-10T00:00:00.000Z');
    // Два года накладных — ровно та ситуация, что раздувала «полную факт».
    await postOverhead({ itemId, accountId, amountRub: 5_000_000, postedAt: '2024-05-01T00:00:00.000Z' });
    await postOverhead({ itemId, accountId, amountRub: 8000, postedAt: '2026-08-05T00:00:00.000Z' });

    const body = await report();
    expect(body.overheadPeriod).toBeNull();
    expect(body.totalOverheadRub).toBe('0.00');
    // Полная = прямой, накладные не подмешаны.
    expect(body.totalFullCostFactRub).toBe(body.totalFactDirectRub);
  });

  test('с периодом в пул попадают только проводки окна', async () => {
    const { accountId, itemId } = await overheadFixture();
    await orderWithReceipt('2026-08-10T00:00:00.000Z');
    await postOverhead({ itemId, accountId, amountRub: 5_000_000, postedAt: '2024-05-01T00:00:00.000Z' });
    await postOverhead({ itemId, accountId, amountRub: 8000, postedAt: '2026-08-05T00:00:00.000Z' });

    const body = await report({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });
    expect(body.overheadPeriod).toEqual({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
    });
    expect(Number(body.totalOverheadRub)).toBeCloseTo(8000, 2);
  });

  test('сторно уменьшает период исходной проводки, а не свой собственный', async () => {
    const { accountId, itemId } = await overheadFixture();
    await orderWithReceipt('2026-08-10T00:00:00.000Z');

    // Прошлогодний расход и его отмена, нажатая уже в августе.
    const oldEntryId = await postOverhead({
      itemId,
      accountId,
      amountRub: 100_000,
      postedAt: '2025-03-01T00:00:00.000Z',
    });
    await postOverhead({
      itemId,
      accountId,
      amountRub: 100_000,
      direction: 'IN',
      isStorno: true,
      reversalOfId: oldEntryId,
      postedAt: '2026-08-20T00:00:00.000Z',
    });
    // Собственно августовская аренда.
    await postOverhead({ itemId, accountId, amountRub: 8000, postedAt: '2026-08-05T00:00:00.000Z' });

    const august = await report({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });
    // Наивный фильтр по окну дал бы 8000 − 100 000 < 0 → клэмп в ноль,
    // и августовские накладные молча исчезли бы.
    expect(Number(august.totalOverheadRub)).toBeCloseTo(8000, 2);

    // А в марте 2025 расхода больше нет — отмена погасила его там.
    await orderWithReceipt('2025-03-10T00:00:00.000Z');
    const march = await report({ dateFrom: '2025-03-01', dateTo: '2025-03-31' });
    expect(Number(march.totalOverheadRub)).toBeCloseTo(0, 2);
  });
});
