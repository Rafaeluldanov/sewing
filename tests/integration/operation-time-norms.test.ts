/**
 * Integration-тест нормирования операций по времени
 * (Этап 1 из `docs/operation-time-norms-recon.md`).
 *
 * Сценарии:
 *   1. POST /api/operations создаёт операцию с FIXED-нормой времени;
 *      getOne возвращает `timeNormSec`.
 *   2. PATCH /api/operations/:id переключает на BY_SIZE и заполняет
 *      `timeNormsBySize`; getOne возвращает строки.
 *   3. Обратное переключение BY_SIZE → FIXED — стирает строки матрицы.
 *   4. `OperationsService.resolveTimeNormSec` (через PrismaService —
 *      т.е. ещё не закрытый внутренний helper) возвращает корректные
 *      секунды по парам (FIXED) и (BY_SIZE × sizeId).
 *   5. `resolveRate` остаётся неизменным: после всех манипуляций с
 *      нормой времени сдельные начисления продолжают считаться по
 *      существующим тарифам (`Operation.fixedRate` /
 *      `OperationRateBySize.rate`). Это страхует от случайного
 *      перетряхивания payroll-контракта.
 *   6. Старая операция без норм времени (default FIXED + null)
 *      возвращается из API без ошибок.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { OperationsService } from '@sewing/api/modules/operations/operations.service';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — operation time norms (Этап 1)', () => {
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

    const adminPin = await bcrypt.hash('time-norm-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'time-norm-admin' },
      create: {
        login: 'time-norm-admin',
        fullName: 'Time Norm Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'Time Norm Admin' },
    });

    cookies = {
      admin: loginAs(t, {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        fullName: admin.fullName,
      }),
      manager: loginAs(t, seed.employees['shop-chief']),
    };
  });

  // -------------------------------------------------------------------------
  // 1. CREATE FIXED with timeNormSec
  // -------------------------------------------------------------------------

  test('POST /api/operations: создаёт операцию с FIXED-нормой времени = 100 сек', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'FIXED_TIME_OP',
        name: 'Операция с фиксированной нормой',
        category: 'SEWING',
        pricingMode: 'SALARY_ONLY',
        timeNormMode: 'FIXED',
        timeNormSec: 100,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'FIXED_TIME_OP',
      timeNormMode: 'FIXED',
      timeNormSec: 100,
      timeNormsBySize: [],
    });

    // GET /api/operations/:id возвращает то же.
    const got = await request(t.app.getHttpServer())
      .get(`/api/operations/${res.body.id}`)
      .set('Cookie', cookies.manager);
    expect(got.status).toBe(200);
    expect(got.body.timeNormMode).toBe('FIXED');
    expect(got.body.timeNormSec).toBe(100);
    expect(got.body.timeNormsBySize).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2. UPDATE → BY_SIZE с поразмерными нормами
  // -------------------------------------------------------------------------

  test('PATCH /api/operations/:id: BY_SIZE с timeNormsBySize (M=100, L=120) — getOne возвращает строки', async () => {
    const opId = seed.operations['SEW_OVERLOCK_1'].id;
    const sizeM = seed.sizes['M'];
    const sizeL = seed.sizes['L'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/operations/${opId}`)
      .set('Cookie', cookies.manager)
      .send({
        timeNormMode: 'BY_SIZE',
        timeNormsBySize: [
          { sizeId: sizeM, seconds: 100 },
          { sizeId: sizeL, seconds: 120 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.timeNormMode).toBe('BY_SIZE');
    expect(res.body.timeNormSec).toBeNull();
    expect(res.body.timeNormsBySize).toHaveLength(2);
    expect(
      res.body.timeNormsBySize.map(
        (r: { sizeId: string; seconds: number }) => ({
          sizeId: r.sizeId,
          seconds: r.seconds,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { sizeId: sizeM, seconds: 100 },
        { sizeId: sizeL, seconds: 120 },
      ]),
    );

    // Источник истины: проверяем БД напрямую.
    const inDb = await t.prisma.operationTimeNormBySize.findMany({
      where: { operationId: opId },
    });
    expect(inDb).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 3. UPDATE: BY_SIZE → FIXED стирает timeNormsBySize
  // -------------------------------------------------------------------------

  test('PATCH /api/operations/:id: переключение BY_SIZE → FIXED стирает timeNormsBySize', async () => {
    const opId = seed.operations['SEW_OVERLOCK_2'].id;
    const sizeS = seed.sizes['S'];

    // Сначала включим BY_SIZE с нормами.
    await request(t.app.getHttpServer())
      .patch(`/api/operations/${opId}`)
      .set('Cookie', cookies.manager)
      .send({
        timeNormMode: 'BY_SIZE',
        timeNormsBySize: [{ sizeId: sizeS, seconds: 50 }],
      })
      .expect(200);
    const beforeRows = await t.prisma.operationTimeNormBySize.findMany({
      where: { operationId: opId },
    });
    expect(beforeRows).toHaveLength(1);

    // Теперь обратно в FIXED.
    const res = await request(t.app.getHttpServer())
      .patch(`/api/operations/${opId}`)
      .set('Cookie', cookies.manager)
      .send({ timeNormMode: 'FIXED', timeNormSec: 80 });
    expect(res.status).toBe(200);
    expect(res.body.timeNormMode).toBe('FIXED');
    expect(res.body.timeNormSec).toBe(80);
    expect(res.body.timeNormsBySize).toEqual([]);

    const afterRows = await t.prisma.operationTimeNormBySize.findMany({
      where: { operationId: opId },
    });
    expect(afterRows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. resolveTimeNormSec (через DI-сервис)
  // -------------------------------------------------------------------------

  test('OperationsService.resolveTimeNormSec возвращает корректные секунды (FIXED + BY_SIZE)', async () => {
    // Достаём сервис из Nest DI — `OperationsService` зарегистрирован
    // в `OperationsModule`, который Reuses в `AppModule`. Тестам так
    // удобнее, чем дёргать SQL руками: проверяем именно тот контракт,
    // который видит `EarningsService` / будущий `OrderOperationPlanService`.
    const ops = t.app.get(OperationsService);

    // Готовим FIXED-операцию через API.
    const fixed = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'FIX_TIME',
        name: 'Fix time op',
        category: 'SEWING',
        pricingMode: 'SALARY_ONLY',
        timeNormMode: 'FIXED',
        timeNormSec: 42,
      })
      .expect(201);
    const fixedId: string = fixed.body.id;

    const sizeM = seed.sizes['M'];
    expect(await ops.resolveTimeNormSec(fixedId, sizeM)).toBe(42);

    // BY_SIZE: операцию готовим тем же путём.
    const sizeS = seed.sizes['S'];
    const sizeL = seed.sizes['L'];
    const opId = seed.operations['SEW_OVERLOCK_1'].id;
    await request(t.app.getHttpServer())
      .patch(`/api/operations/${opId}`)
      .set('Cookie', cookies.manager)
      .send({
        timeNormMode: 'BY_SIZE',
        timeNormsBySize: [
          { sizeId: sizeS, seconds: 11 },
          { sizeId: sizeL, seconds: 22 },
        ],
      })
      .expect(200);
    expect(await ops.resolveTimeNormSec(opId, sizeS)).toBe(11);
    expect(await ops.resolveTimeNormSec(opId, sizeL)).toBe(22);
    // Норма по неуказанному размеру → null (не exception).
    expect(await ops.resolveTimeNormSec(opId, sizeM)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. resolveRate не изменён
  // -------------------------------------------------------------------------

  test('resolveRate сохраняет ставки даже после правок норм времени (контракт payroll не изменён)', async () => {
    const ops = t.app.get(OperationsService);

    const cutId = seed.operations['CUT_CUT'].id; // FIXED, fixedRate=10 в seed.
    const overId = seed.operations['SEW_OVERLOCK_1'].id; // BY_SIZE seed.
    const sizeS = seed.sizes['S'];

    // Меняем нормы времени на обеих операциях.
    await request(t.app.getHttpServer())
      .patch(`/api/operations/${cutId}`)
      .set('Cookie', cookies.manager)
      .send({ timeNormMode: 'FIXED', timeNormSec: 90 })
      .expect(200);
    await request(t.app.getHttpServer())
      .patch(`/api/operations/${overId}`)
      .set('Cookie', cookies.manager)
      .send({
        timeNormMode: 'BY_SIZE',
        timeNormsBySize: [{ sizeId: sizeS, seconds: 30 }],
      })
      .expect(200);

    // Проверяем, что resolveRate выдаёт ровно те же значения, что и
    // до правок: CUT_CUT FIXED → 10, SEW_OVERLOCK_1 BY_SIZE × S → 10
    // (значение из seed: rate=10 для всех размеров оверлока).
    const cutRate = await ops.resolveRate(cutId, sizeS);
    expect(Number(cutRate)).toBe(10);
    const overRate = await ops.resolveRate(overId, sizeS);
    expect(Number(overRate)).toBe(10);
  });

  // -------------------------------------------------------------------------
  // 6. Backward-compat: старая операция без норм
  // -------------------------------------------------------------------------

  test('GET /api/operations/:id: старая операция без норм возвращается с timeNormMode=FIXED и timeNormSec=null', async () => {
    const opId = seed.operations['QC'].id; // QC seed без норм времени.
    const res = await request(t.app.getHttpServer())
      .get(`/api/operations/${opId}`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.timeNormMode).toBe('FIXED');
    expect(res.body.timeNormSec).toBeNull();
    expect(res.body.timeNormsBySize).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 7. Validation: FIXED + timeNormsBySize → 400
  // -------------------------------------------------------------------------

  test('POST /api/operations: FIXED + timeNormsBySize → 400 VALIDATION_ERROR', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'BAD_TIME_FIXED',
        name: 'Bad fixed',
        category: 'SEWING',
        pricingMode: 'SALARY_ONLY',
        timeNormMode: 'FIXED',
        timeNormSec: 10,
        timeNormsBySize: [{ sizeId: seed.sizes['S'], seconds: 5 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('POST /api/operations: BY_SIZE + timeNormSec → 400 VALIDATION_ERROR', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'BAD_TIME_BY_SIZE',
        name: 'Bad by-size',
        category: 'SEWING',
        pricingMode: 'SALARY_ONLY',
        timeNormMode: 'BY_SIZE',
        timeNormSec: 10,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
