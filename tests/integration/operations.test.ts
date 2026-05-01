/**
 * Integration-тест управленческого блока «Операции»
 * (см. `docs/api.md §15a`, `docs/domain.md §4a`,
 * `docs/screens.md §10c`, ADR-0020).
 *
 * Сценарии:
 *   1. CRUD — создание FIXED / BY_SIZE / SALARY_ONLY, list, getOne, patch.
 *   2. Уникальность `Operation.code` (`OPERATION_CODE_TAKEN`).
 *   3. Уникальность `(operationId, sizeId)` в `OperationRateBySize`
 *      (`OPERATION_RATE_DUPLICATE_SIZE` на 400 / `OPERATION_RATE_SIZE_NOT_FOUND`).
 *   4. RBAC — менеджерские роли видят, рабочие — 403.
 *   5. Earnings integration — earningsService.resolveRate
 *      используется в `createImmediateForCutter` /
 *      `createPendingForPreviousOperation`:
 *        - FIXED → используется `Operation.fixedRate`;
 *        - BY_SIZE → используется `OperationRateBySize.rate`;
 *        - SALARY_ONLY → начисление вообще не создаётся.
 *   6. Не ломаем существующий e2e-flow: passport.create + scan
 *      продолжают работать на новых ставках.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — operations management (ADR-0020)', () => {
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

    const adminPin = await bcrypt.hash('rbac-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'rbac-admin' },
      create: {
        login: 'rbac-admin',
        fullName: 'RBAC Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'RBAC Admin' },
    });

    cookies = {
      admin: loginAs(t, {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        fullName: admin.fullName,
      }),
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      cutter: loginAs(t, seed.employees['cutter']),
      packer: loginAs(t, seed.employees['packer']),
    };
  });

  // -------------------------------------------------------------------------
  // 1. CRUD: list / create / getOne / update
  // -------------------------------------------------------------------------

  test('GET /api/operations: возвращает все seed-операции с pricingMode', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/operations')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const items = res.body as Array<{
      code: string;
      pricingMode: string;
      fixedRate: number | null;
      ratesBySizeCount: number;
    }>;
    const cut = items.find((i) => i.code === 'CUT_CUT');
    expect(cut).toMatchObject({ pricingMode: 'FIXED', fixedRate: 10 });
    const overlock = items.find((i) => i.code === 'SEW_OVERLOCK_1');
    expect(overlock).toMatchObject({
      pricingMode: 'BY_SIZE',
      fixedRate: null,
    });
    expect(overlock?.ratesBySizeCount).toBeGreaterThan(0);
    const qc = items.find((i) => i.code === 'QC');
    expect(qc).toMatchObject({ pricingMode: 'SALARY_ONLY', fixedRate: null });
  });

  test('POST /api/operations: создаёт FIXED-операцию с fixedRate', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'CUT_CUSTOM',
        name: 'Произвольный раскрой',
        category: 'CUTTING',
        pricingMode: 'FIXED',
        fixedRate: 11.5,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'CUT_CUSTOM',
      name: 'Произвольный раскрой',
      category: 'CUTTING',
      pricingMode: 'FIXED',
      fixedRate: 11.5,
      isActive: true,
      ratesBySize: [],
    });
  });

  test('POST /api/operations: создаёт BY_SIZE с ratesBySize одним вызовом', async () => {
    const sizeS = seed.sizes['S'];
    const sizeM = seed.sizes['M'];
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'SEW_OVERLOCK_3',
        name: 'Оверлок 3',
        category: 'SEWING',
        pricingMode: 'BY_SIZE',
        ratesBySize: [
          { sizeId: sizeS, rate: 12 },
          { sizeId: sizeM, rate: 14 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.pricingMode).toBe('BY_SIZE');
    expect(res.body.fixedRate).toBeNull();
    expect(res.body.ratesBySize).toHaveLength(2);
    expect(
      res.body.ratesBySize.map((r: { sizeId: string; rate: number }) => ({
        sizeId: r.sizeId,
        rate: r.rate,
      })),
    ).toEqual(
      expect.arrayContaining([
        { sizeId: sizeS, rate: 12 },
        { sizeId: sizeM, rate: 14 },
      ]),
    );
  });

  test('POST /api/operations: создаёт SALARY_ONLY без ставок', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'EXTRA_QC',
        name: 'Доп. ОТК',
        category: 'QC',
        pricingMode: 'SALARY_ONLY',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      pricingMode: 'SALARY_ONLY',
      fixedRate: null,
      ratesBySize: [],
    });
  });

  test('POST /api/operations: для FIXED без fixedRate — 400', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'NEW_FIXED',
        name: 'Новая',
        category: 'SEWING',
        pricingMode: 'FIXED',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('POST /api/operations: для SALARY_ONLY с fixedRate — 400', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'BAD_SALARY',
        name: 'Неверная окладная',
        category: 'PACKING',
        pricingMode: 'SALARY_ONLY',
        fixedRate: 5,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('PATCH /api/operations/:id: меняет название', async () => {
    const cutId = seed.operations['CUT_CUT'].id;
    const res = await request(t.app.getHttpServer())
      .patch(`/api/operations/${cutId}`)
      .set('Cookie', cookies.manager)
      .send({ name: 'Раскрой v2' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Раскрой v2');
  });

  test('PATCH /api/operations/:id: смена FIXED → BY_SIZE с заполнением ставок', async () => {
    const cutId = seed.operations['CUT_CUT'].id;
    const sizeS = seed.sizes['S'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/operations/${cutId}`)
      .set('Cookie', cookies.manager)
      .send({
        pricingMode: 'BY_SIZE',
        ratesBySize: [{ sizeId: sizeS, rate: 13 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.pricingMode).toBe('BY_SIZE');
    expect(res.body.fixedRate).toBeNull();
    expect(res.body.ratesBySize).toHaveLength(1);
    expect(res.body.ratesBySize[0]).toMatchObject({
      sizeId: sizeS,
      rate: 13,
    });
  });

  test('PATCH /api/operations/:id: смена BY_SIZE → SALARY_ONLY очищает ставки', async () => {
    const overId = seed.operations['SEW_OVERLOCK_1'].id;
    const res = await request(t.app.getHttpServer())
      .patch(`/api/operations/${overId}`)
      .set('Cookie', cookies.manager)
      .send({ pricingMode: 'SALARY_ONLY' });
    expect(res.status).toBe(200);
    expect(res.body.pricingMode).toBe('SALARY_ONLY');
    expect(res.body.ratesBySize).toEqual([]);
    expect(res.body.fixedRate).toBeNull();

    // Проверяем непосредственно в БД, что строки удалены.
    const inDb = await t.prisma.operationRateBySize.findMany({
      where: { operationId: overId },
    });
    expect(inDb).toEqual([]);
  });

  test('PATCH /api/operations/:id: BY_SIZE с пустым ratesBySize=[] стирает всё', async () => {
    const overId = seed.operations['SEW_OVERLOCK_1'].id;
    const res = await request(t.app.getHttpServer())
      .patch(`/api/operations/${overId}`)
      .set('Cookie', cookies.manager)
      .send({ ratesBySize: [] });
    expect(res.status).toBe(200);
    expect(res.body.ratesBySize).toEqual([]);
    const inDb = await t.prisma.operationRateBySize.findMany({
      where: { operationId: overId },
    });
    expect(inDb).toEqual([]);
  });

  test('GET /api/operations/:id: 404 на несуществующий', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/operations/no-such-id')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OPERATION_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // 2. Уникальность Operation.code
  // -------------------------------------------------------------------------

  test('POST /api/operations: дубликат code → 409 OPERATION_CODE_TAKEN', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'CUT_CUT',
        name: 'Дубликат',
        category: 'CUTTING',
        pricingMode: 'FIXED',
        fixedRate: 1,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPERATION_CODE_TAKEN');
  });

  // -------------------------------------------------------------------------
  // 3. Уникальность (operationId, sizeId) и валидация ставок
  // -------------------------------------------------------------------------

  test('POST /api/operations: дубликат sizeId в ratesBySize → 400', async () => {
    const sizeS = seed.sizes['S'];
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'SEW_DUP_SIZE',
        name: 'дубль размера',
        category: 'SEWING',
        pricingMode: 'BY_SIZE',
        ratesBySize: [
          { sizeId: sizeS, rate: 1 },
          { sizeId: sizeS, rate: 2 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OPERATION_RATE_DUPLICATE_SIZE');
  });

  test('POST /api/operations: несуществующий sizeId → 400 OPERATION_RATE_SIZE_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'SEW_BAD_SIZE',
        name: 'неверный размер',
        category: 'SEWING',
        pricingMode: 'BY_SIZE',
        ratesBySize: [{ sizeId: 'no-such-size-id', rate: 5 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OPERATION_RATE_SIZE_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // 4. RBAC
  // -------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS — 403 на GET /api/operations', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/operations')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: CUTTER, QC, PACKING — 403 на POST /api/operations', async () => {
    for (const who of ['cutter', 'qc', 'packer'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/operations')
        .set('Cookie', cookies[who])
        .send({
          code: `EVIL_${who.toUpperCase()}`,
          name: 'Hack',
          category: 'SEWING',
          pricingMode: 'SALARY_ONLY',
        });
      expect(res.status, `role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  test('RBAC: ADMIN и SHOP_MANAGER — могут CRUD', async () => {
    for (const who of ['admin', 'manager'] as const) {
      const list = await request(t.app.getHttpServer())
        .get('/api/operations')
        .set('Cookie', cookies[who]);
      expect(list.status, `role=${who}`).toBe(200);
      const created = await request(t.app.getHttpServer())
        .post('/api/operations')
        .set('Cookie', cookies[who])
        .send({
          code: `OK_${who.toUpperCase()}`,
          name: `op-${who}`,
          category: 'SEWING',
          pricingMode: 'SALARY_ONLY',
        });
      expect(created.status, `role=${who}`).toBe(201);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Earnings integration: resolveRate как источник истины
  // -------------------------------------------------------------------------

  test('Earnings: FIXED — раскройщик получает Operation.fixedRate * qty', async () => {
    // CUT_CUT в seed = FIXED, fixedRate = 10. qtyCut = 7 → ожидаемая сумма 70.
    const orderId = await createInProductionOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes['S'], qtyPlan: 50 },
    ]);
    const passportId = await issuePassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes['S'],
      7,
    );

    const earnings = await t.prisma.operationEntry.findMany({
      where: { passportId },
    });
    expect(earnings).toHaveLength(1);
    expect(earnings[0].operationId).toBe(seed.operations['CUT_CUT'].id);
    expect(Number(earnings[0].ratePerUnit)).toBe(10);
    expect(Number(earnings[0].amount)).toBe(70);
  });

  test('Earnings: SALARY_ONLY — раскройщик не получает начисления', async () => {
    // Переводим CUT_CUT на SALARY_ONLY и проверяем, что начисления нет.
    await request(t.app.getHttpServer())
      .patch(`/api/operations/${seed.operations['CUT_CUT'].id}`)
      .set('Cookie', cookies.manager)
      .send({ pricingMode: 'SALARY_ONLY' })
      .expect(200);

    const orderId = await createInProductionOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes['S'], qtyPlan: 10 },
    ]);
    const passportId = await issuePassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes['S'],
      5,
    );

    const earnings = await t.prisma.operationEntry.findMany({
      where: { passportId },
    });
    expect(earnings).toEqual([]);
  });

  test('Earnings: BY_SIZE — ставка берётся из OperationRateBySize', async () => {
    // Переключаем CUT_CUT в BY_SIZE с разными ставками по размерам и
    // проверяем, что immediate-начисление подхватило именно
    // OperationRateBySize, а не fixedRate (которого больше нет).
    const cutId = seed.operations['CUT_CUT'].id;
    await request(t.app.getHttpServer())
      .patch(`/api/operations/${cutId}`)
      .set('Cookie', cookies.manager)
      .send({
        pricingMode: 'BY_SIZE',
        ratesBySize: [
          { sizeId: seed.sizes['S'], rate: 7 },
          { sizeId: seed.sizes['M'], rate: 9 },
        ],
      })
      .expect(200);

    const orderId = await createInProductionOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes['M'], qtyPlan: 10 },
    ]);
    const passportId = await issuePassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes['M'],
      4,
    );

    const earnings = await t.prisma.operationEntry.findMany({
      where: { passportId },
    });
    expect(earnings).toHaveLength(1);
    expect(Number(earnings[0].ratePerUnit)).toBe(9);
    expect(Number(earnings[0].amount)).toBe(36);
  });
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function createInProductionOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  items: Array<{ sizeId: string; qtyPlan: number }>,
): Promise<string> {
  const created = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      // Эти тесты валидируют marketplace-схему начисления закройщика
      // (fixedRate × qty / BY_SIZE-ставка). После внедрения второй
      // схемы (B2B по проценту от пошива, см.
      // `docs/payroll-cutter-compensation-recon.md`) необходимо явно
      // сказать «это marketplace», иначе backend выберет B2B-flow.
      division: 'MARKETPLACE',
      items,
    })
    .expect(201);
  const orderId: string = created.body.id;
  await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/start`)
    .set('Cookie', cookie)
    .expect(201);
  return orderId;
}

async function issuePassport(
  t: TestApp,
  cookie: string,
  orderId: string,
  sizeId: string,
  qtyCut: number,
): Promise<string> {
  const res = await request(t.app.getHttpServer())
    .post('/api/passports')
    .set('Cookie', cookie)
    .send({
      orderId,
      sizeId,
      rollNumber: `R-${Math.floor(Math.random() * 1e6)}`,
      cutDate: '2026-04-15T00:00:00.000Z',
      qtyCut,
    })
    .expect(201);
  return res.body.id as string;
}
