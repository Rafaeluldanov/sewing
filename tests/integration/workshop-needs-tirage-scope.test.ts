/**
 * Integration-тест скоупа `TIRAGE` в `GET /api/orders/:id/workshop-needs`.
 *
 * Разбор 02-00024 (прод, 25.08.2026): в «Сводно по заказу» появились
 * дубликаты — рядом с 18 тиражными строками встали 11 строк сигнального
 * образца. Образец считается на 1 изделие теми же материалами
 * (`WorkshopNeedsService.calculateForSampleInTx`, `orderSampleId != null`),
 * и в тиражной таблице выглядит вторым комплектом строк.
 *
 * Канонический фрагмент `TIRAGE_NEED_WHERE` для этого и заведён — им уже
 * ходит смета на бэке, — но у ручки заказа скоупа под него не было:
 * `ACTIVE` образец пропускает намеренно (выдачам и блоку «Потребность цеха»
 * он нужен).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — скоуп TIRAGE: образец не дублирует тираж', () => {
  let t: TestApp;
  let seed: SeedResult;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
  });

  test('строки образца видны в ACTIVE и не видны в TIRAGE', async () => {
    const pattern = await createSpecPattern(t, t.adminCookie, {
      article: 'TIRAGE-SCOPE-1',
      name: 'Лекало для скоупа',
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '1.2',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'Кулирка',
          densityGsm: 160,
          plannedWidthCm: 180,
        },
        {
          name: 'Нитки',
          unit: 'м',
          qtyPerUnit: '50',
          materialRole: 'THREAD',
          fabricType: 'Нитки',
        },
      ],
    });

    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-08-25T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId: pattern.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      })
      .expect(201);
    const orderId = order.body.id as string;

    // Тиражная потребность.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({ force: true })
      .expect(201);

    // Сигнальный образец шьётся из производства и считает СВОЮ потребность
    // на 1 изделие.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'IN_PRODUCTION' },
    });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', loginAs(t, seed.employees['shop-chief']))
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);

    const sampleRows = await t.prisma.workshopNeed.count({
      where: { orderId, orderSampleId: { not: null } },
    });
    expect(sampleRows).toBeGreaterThan(0);

    // ACTIVE (default) — выдачам и блоку «Потребность цеха» образец нужен.
    const active = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/workshop-needs`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(
      (active.body as Array<{ orderSampleId: string | null }>).some(
        (n) => n.orderSampleId != null,
      ),
    ).toBe(true);

    // TIRAGE — деньги и материалы тиража: только тиражные строки.
    const tirage = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/workshop-needs?calculationScope=TIRAGE`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    const rows = tirage.body as Array<{
      orderSampleId: string | null;
      sourceName: string;
    }>;
    expect(rows.every((n) => n.orderSampleId == null)).toBe(true);
    expect(rows).toHaveLength(active.body.length - sampleRows);
    // Материалы тиража на месте — отфильтровали образец, а не всё подряд.
    expect(rows.map((n) => n.sourceName).sort()).toEqual(['Кулирка', 'Нитки']);
  });
});
