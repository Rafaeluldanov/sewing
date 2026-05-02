/**
 * Integration-тест для `GET /api/shifts/current-work`.
 *
 * Контракт (см. `docs/api.md §3a` и `docs/screens.md §3.3`):
 *   - вернуть только активные кройи текущего сотрудника
 *     (`Passport.currentEmployeeId = me AND status = IN_PROGRESS`);
 *   - чужие паспорта не видны;
 *   - если активного кроя нет — пустой список;
 *   - после `issue` (приёма кроя) паспорт появляется в ответе.
 *
 * Сидим минимально: один заказ, один паспорт в ячейке, заводим швее
 * смену и идём по реальному happy-path через HTTP.
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

describeWithDb('integration — GET /api/shifts/current-work', () => {
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
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  test('пустой список, если у сотрудника нет активного кроя', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });

  test('после issue паспорт появляется и отдаётся только своему сотруднику', async () => {
    const orderId = await createAndStartOrder(t, seed, cookies.manager, 3);
    const passportId = await createAndPlace(t, seed, cookies.manager, orderId, 3);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);

    const issue = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(issue.status).toBe(201);

    // 1) Свой ответ — есть запись с правильным DTO.
    const mine = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(mine.body).toHaveLength(1);
    const item = mine.body[0];
    expect(item).toMatchObject({
      id: passportId,
      status: 'IN_PROGRESS',
      qtyCut: 3,
      qtyGood: 3,
      qtyDefect: 0,
      sizeCode: 'M',
      productName: 'Test Tee',
    });
    // обязательные ID-поля есть, и операция/рулон/время приёма
    // подтянуты с backend (источник истины — БД, см. ТЗ §3).
    expect(typeof item.number).toBe('string');
    expect(item.number.length).toBeGreaterThan(0);
    expect(typeof item.rollNumber).toBe('string');
    expect(item.currentOperationCode).toBeTruthy();
    expect(item.acceptedAt).toBeTruthy();
    expect(item.updatedAt).toBeTruthy();

    // 2) Чужой ответ — не видит этого паспорта.
    const others = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(others.body).toEqual([]);

    const managerView = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(managerView.body).toEqual([]);
  });

  test('после ухода паспорта дальше по цепочке — он исчезает из current-work', async () => {
    const orderId = await createAndStartOrder(t, seed, cookies.manager, 2);
    const passportId = await createAndPlace(t, seed, cookies.manager, orderId, 2);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Подменим currentEmployeeId напрямую — эмулируем ситуацию,
    // когда другой сотрудник скан-нул паспорт на следующей операции
    // (после такого `currentEmployeeId` перезаписывается).
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { currentEmployeeId: seed.employees.qc.id },
    });

    const after = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(after.body).toEqual([]);
  });

  test('несколько активных паспортов — отдаются списком, новые сверху', async () => {
    const orderId = await createAndStartOrder(t, seed, cookies.manager, 5);
    const p1 = await createAndPlace(t, seed, cookies.manager, orderId, 2);
    const p2 = await createAndPlace(t, seed, cookies.manager, orderId, 3);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/passports/${p1}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    // явная пауза, чтобы updatedAt у p2 был строго позже p1
    await new Promise((r) => setTimeout(r, 10));
    await request(t.app.getHttpServer())
      .post(`/api/passports/${p2}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(res.body).toHaveLength(2);
    // updatedAt desc → последний выданный сверху
    expect(res.body[0].id).toBe(p2);
    expect(res.body[1].id).toBe(p1);
  });

  test('требует авторизации (без cookie — 401)', async () => {
    const res = await request(t.app.getHttpServer()).get(
      '/api/shifts/current-work',
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createAndStartOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  qtyPlanM: number,
): Promise<string> {
  const order = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items: [{ sizeId: seed.sizes.M, qtyPlan: qtyPlanM }],
    })
    .expect(201);
  await request(t.app.getHttpServer())
    .post(`/api/orders/${order.body.id}/start`)
    .set('Cookie', cookie)
    .expect(201);
  return order.body.id;
}

async function createAndPlace(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  orderId: string,
  qtyCut: number,
): Promise<string> {
  const passport = await request(t.app.getHttpServer())
    .post('/api/passports')
    .set('Cookie', cookie)
    .send({
      orderId,
      sizeId: seed.sizes.M,
      rollNumber: `R-${Math.floor(Math.random() * 1e6)}`,
      cutDate: '2026-04-15T00:00:00.000Z',
      qtyCut,
      // PHASE 2 STEP 3: cutterId обязателен у не-CUTTER ролей.
      cutterId: seed.employees.cutter.id,
    })
    .expect(201);
  await request(t.app.getHttpServer())
    .post(`/api/passports/${passport.body.id}/place`)
    .set('Cookie', cookie)
    .send({ cellId: seed.cells.A1.id })
    .expect(201);
  return passport.body.id;
}
