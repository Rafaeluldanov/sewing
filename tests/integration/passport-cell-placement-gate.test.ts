/**
 * Гейт «размещение в ячейке обязательно перед уходом с кроя».
 *
 * Регрессия инцидента 16.07.2026: паспорта `P-20260716-0011..0015`
 * прошли МИМО ячеек — помощник раскройщика не разместил крой, а
 * оверлокщик сразу забрал его через `issue`. Теперь и `issue`, и
 * `scan` на первой швейной операции обязаны видеть размещённый в
 * ячейке паспорт, иначе 409 `PASSPORT_NOT_PLACED_IN_CELL`.
 *
 * Покрываем:
 *   G1. `issue` без размещения → 409, паспорт остаётся CREATED без ячейки.
 *   G2. `scan` без размещения → 409 (scan-канал не лазейка).
 *   G3. После `place` тот же `issue` проходит (штатный путь не сломан).
 *
 * См. `PassportsService.assertPlacedBeforeLeavingCut`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — cell-placement gate before leaving cut', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  async function setupOrderWithRoute(): Promise<{
    orderId: string;
    sizeId: string;
  }> {
    const tplCode = `CPG-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const tpl = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookies.manager)
      .send({
        code: tplCode,
        name: tplCode,
        steps: [
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.SEW_OVERLOCK_2.id },
          { operationId: seed.operations.QC.id },
        ],
      })
      .expect(201);

    const sizeId = seed.sizes.M!;
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId, qtyPlan: 5 }],
        routeTemplateId: tpl.body.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    return { orderId: order.body.id, sizeId };
  }

  /** Создаёт паспорт, НЕ размещая его в ячейке. */
  async function createWithoutPlace(
    orderId: string,
    sizeId: string,
  ): Promise<string> {
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId,
        rollNumber: `R-${Math.random().toString(36).slice(2, 8)}`,
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 5,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    return passport.body.id;
  }

  async function place(passportId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);
  }

  async function startSeamstressShift(): Promise<void> {
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
  }

  // ---------------------------------------------------------------------------

  test('G1. issue без размещения в ячейке → 409, паспорт остаётся на крою', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute();
    const passportId = await createWithoutPlace(orderId, sizeId);
    await startSeamstressShift();

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_NOT_PLACED_IN_CELL');

    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.status).toBe('CREATED');
    expect(inDb.currentCellId).toBeNull();
  });

  test('G2. scan без размещения в ячейке → 409 (scan-канал не лазейка)', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute();
    const passportId = await createWithoutPlace(orderId, sizeId);
    await startSeamstressShift();

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_NOT_PLACED_IN_CELL');

    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.status).toBe('CREATED');
  });

  test('G3. после размещения тот же issue проходит', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute();
    const passportId = await createWithoutPlace(orderId, sizeId);
    await place(passportId);
    await startSeamstressShift();

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.status).toBe('IN_PROGRESS');
  });
});
