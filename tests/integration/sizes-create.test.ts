/**
 * Integration-тесты этапа «Создание пользовательского размера»
 * (`POST /api/sizes`, см. `apps/api/src/modules/sizes/*`,
 * `packages/shared/src/sizes.ts`).
 *
 * Покрытие:
 *   1. Happy path: POST `{ code: '200*300*10' }` создаёт `Size`
 *      с каноничным `code = '200×300×10'` и `sortOrder` = max+10
 *      по уже существующему справочнику.
 *   2. Idempotent: повторный POST с тем же кодом (или его
 *      «синонимом» — другая запись разделителей) возвращает
 *      существующий размер и НЕ создаёт дубль.
 *   3. Стандартные размеры (104 / XS / 6XL) после создания
 *      пользовательского НЕ менялись (sortOrder, code).
 *   4. RBAC: SEAMSTRESS / QC получают 403 на `POST /api/sizes`,
 *      ADMIN/SHOP_MANAGER — 200/201.
 *   5. Валидация: пустой code → 400 VALIDATION_ERROR; слишком
 *      длинный → 400.
 *   6. AuditLog: успешный create пишет одну строку
 *      `SIZE_CREATED` с правильным entityType/entityId.
 *   7. Доступность нового размера в OrderItem: можно создать
 *      `OrderItem` со свежесозданным `sizeId` без падений.
 *   8. Доступность нового размера в OperationRateBySize и
 *      OperationTimeNormBySize: тариф/норма с `sizeId` нового
 *      размера сохраняются (поразмерные ставки/нормы).
 *
 * Сценарии 7 и 8 — это smoke-проверки совместимости со связанными
 * таблицами; они не пересоздают полный production-flow заказа.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — sizes (POST /api/sizes)', () => {
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
    await refreshAdminCookie(t);
    cookies = {
      admin: t.adminCookie,
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path + нормализация кода + sortOrder = max + 10
  // ---------------------------------------------------------------------------

  test('POST /api/sizes создаёт новый размер с нормализованным кодом', async () => {
    const before = await t.prisma.size.aggregate({
      _max: { sortOrder: true },
      _count: { _all: true },
    });
    const beforeMax = before._max.sortOrder ?? 0;
    const beforeCount = before._count._all;

    const res = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: '200*300*10' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: '200×300×10',
      sortOrder: beforeMax + 10,
    });
    expect(typeof res.body.id).toBe('string');

    // Размер реально вставлен в БД.
    const inDb = await t.prisma.size.findUnique({ where: { id: res.body.id } });
    expect(inDb?.code).toBe('200×300×10');
    expect(inDb?.sortOrder).toBe(beforeMax + 10);

    const after = await t.prisma.size.count();
    expect(after).toBe(beforeCount + 1);
  });

  test('варианты ввода нормализуются к единому коду', async () => {
    const variants = ['200x300x10', '200X300X10', '200 x 300 x 10', '200×300×10'];
    for (const code of variants) {
      const res = await request(t.app.getHttpServer())
        .post('/api/sizes')
        .set('Cookie', cookies.manager)
        .send({ code });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe('200×300×10');
    }
    // Несмотря на 4 запроса, в БД ровно одна строка с этим code.
    const rows = await t.prisma.size.findMany({
      where: { code: '200×300×10' },
    });
    expect(rows.length).toBe(1);
  });

  test('«6xl» → «6XL» (uppercase, ASCII)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: '  6xl  ' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('6XL');
  });

  // ---------------------------------------------------------------------------
  // 2. Idempotent create
  // ---------------------------------------------------------------------------

  test('повторный POST с тем же кодом возвращает существующий размер (idempotent)', async () => {
    const first = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: '200*300*10' });
    expect(first.status).toBe(201);
    const id = first.body.id as string;

    const second = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: '200x300x10' }); // другой ввод, тот же каноничный код
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(id);
    expect(second.body.code).toBe('200×300×10');

    // Только одна запись.
    const rows = await t.prisma.size.findMany({
      where: { code: '200×300×10' },
    });
    expect(rows.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Стандартные размеры не меняются
  // ---------------------------------------------------------------------------

  test('создание custom-размера не меняет существующие S/M/L', async () => {
    const before = await t.prisma.size.findMany({
      orderBy: { sortOrder: 'asc' },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: 'плед 120×150' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('плед 120×150');

    const after = await t.prisma.size.findMany({
      where: { id: { in: before.map((s) => s.id) } },
      orderBy: { sortOrder: 'asc' },
    });
    expect(after.map((s) => ({ code: s.code, sortOrder: s.sortOrder }))).toEqual(
      before.map((s) => ({ code: s.code, sortOrder: s.sortOrder })),
    );
  });

  // ---------------------------------------------------------------------------
  // 4. RBAC
  // ---------------------------------------------------------------------------

  test('SEAMSTRESS / QC → 403; ADMIN/SHOP_MANAGER → 201', async () => {
    for (const role of ['seamstress', 'qc'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/sizes')
        .set('Cookie', cookies[role])
        .send({ code: 'BANNED-1' });
      expect(res.status).toBe(403);
    }

    const adminRes = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.admin)
      .send({ code: 'ADMIN-OK' });
    expect(adminRes.status).toBe(201);

    const managerRes = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: 'MANAGER-OK' });
    expect(managerRes.status).toBe(201);
  });

  // ---------------------------------------------------------------------------
  // 5. Валидация
  // ---------------------------------------------------------------------------

  test('пустой / только-пробельный code → 400 VALIDATION_ERROR', async () => {
    for (const code of ['', '   ', '\n']) {
      const res = await request(t.app.getHttpServer())
        .post('/api/sizes')
        .set('Cookie', cookies.manager)
        .send({ code });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  test('слишком длинный code → 400', async () => {
    const tooLong = '1'.repeat(65);
    const res = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: tooLong });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 6. AuditLog
  // ---------------------------------------------------------------------------

  test('успешный create пишет AuditLog SIZE_CREATED ровно один раз', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: 'AUDIT-CHECK' });
    expect(res.status).toBe(201);

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'SIZE', entityId: res.body.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.event)).toEqual(['SIZE_CREATED']);
    // payload содержит code/sortOrder.
    const payload = audit[0]!.payload as {
      code?: string;
      sortOrder?: number;
    };
    expect(payload.code).toBe('AUDIT-CHECK');
    expect(typeof payload.sortOrder).toBe('number');
  });

  test('idempotent повтор НЕ пишет дополнительный AuditLog', async () => {
    const first = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: 'IDEMP-AUDIT' });
    expect(first.status).toBe(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: 'idemp-audit' });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'SIZE', entityId: first.body.id },
    });
    expect(audit.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 7. Доступность нового размера в GET /api/sizes (read-side)
  // ---------------------------------------------------------------------------

  test('GET /api/sizes отдаёт новый custom-размер, отсортированный в конец', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: 'CUSTOM-LAST' });
    expect(res.status).toBe(201);

    const list = await request(t.app.getHttpServer())
      .get('/api/sizes')
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    const codes = (list.body as Array<{ code: string }>).map((s) => s.code);
    expect(codes).toContain('CUSTOM-LAST');
    // Стандартные S/M/L по-прежнему присутствуют и идут в начале.
    const idxS = codes.indexOf('S');
    const idxCustom = codes.indexOf('CUSTOM-LAST');
    expect(idxS).toBeGreaterThanOrEqual(0);
    expect(idxCustom).toBeGreaterThan(idxS);
  });

  // ---------------------------------------------------------------------------
  // 8. Доступность нового размера в OrderItem / OperationRateBySize /
  //    OperationTimeNormBySize (со-таблицы остались совместимы)
  // ---------------------------------------------------------------------------

  test('новый размер можно использовать в OrderItem / OperationRateBySize / OperationTimeNormBySize', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/sizes')
      .set('Cookie', cookies.manager)
      .send({ code: 'COMPAT-1' });
    expect(created.status).toBe(201);
    const sizeId = created.body.id as string;

    // OrderItem (через Prisma напрямую — мы проверяем именно факт
    // совместимости sizeId, а не полный flow заказа).
    const order = await t.prisma.order.create({
      data: {
        number: 'TEST-COMPAT-1',
        orderDate: new Date(),
        items: {
          create: {
            productId: seed.product.id,
            sizeId,
            qtyPlan: 5,
          },
        },
      },
      include: { items: true },
    });
    expect(order.items[0]!.sizeId).toBe(sizeId);
    expect(order.items[0]!.qtyPlan).toBe(5);

    // OperationRateBySize.
    const overlock = seed.operations['SEW_OVERLOCK_1']!;
    const rate = await t.prisma.operationRateBySize.create({
      data: {
        operationId: overlock.id,
        sizeId,
        rate: new Prisma.Decimal(15),
      },
    });
    expect(rate.sizeId).toBe(sizeId);

    // OperationTimeNormBySize.
    const timeNorm = await t.prisma.operationTimeNormBySize.create({
      data: {
        operationId: overlock.id,
        sizeId,
        seconds: 120,
      },
    });
    expect(timeNorm.sizeId).toBe(sizeId);
  });
});
