/**
 * Integration-тесты модуля «Мастер цеха» (`MasterCalls`, MVP).
 *
 * Контракт: `apps/api/src/modules/master-calls/*`,
 * `docs/domain.md §10a`, `docs/flows.md §F-Master`,
 * `docs/screens.md §8a`.
 *
 * Покрываем шесть инвариантов из ТЗ:
 *
 *   1. рабочий (SEAMSTRESS) создаёт `OPEN`-вызов через
 *      `POST /api/master-calls` — записывается в БД, возвращается
 *      сериализованный `MasterCallDto` с employee/equipment/operation;
 *   2. повторный `POST` от того же сотрудника — идемпотентен: тот же
 *      `id` и тот же `createdAt`, новой строки в `MasterCall` нет;
 *   3. SHOPFLOOR_MASTER видит вызов в `GET /api/master-calls`;
 *   4. SHOPFLOOR_MASTER закрывает вызов сканом QR
 *      (`POST /api/master-calls/resolve-by-employee-qr`) — переходит в
 *      `RESOLVED`, заполняется `resolvedById = master.id`;
 *   5. рабочая роль (SEAMSTRESS) НЕ может позвать resolve-эндпоинт
 *      (403 FORBIDDEN_ROLE) — backend остаётся источником истины;
 *   6. `AuditLog` содержит `MASTER_CALLED` и `MASTER_CALL_RESOLVED`
 *      ровно по одному разу на полный цикл (идемпотентный create
 *      второго `MASTER_CALLED` не пишет — это сознательное решение,
 *      см. §10a).
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

describeWithDb('integration — master calls (MVP)', () => {
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
      master: loginAs(t, seed.employees['master']),
    };
  });

  /**
   * Открывает смену швеи на overlock-01, чтобы созданный
   * `MasterCall` снэпшотил `equipmentId` / `operationId` (это
   * проверяется в первом тесте). Без этого `equipment` / `operation`
   * в DTO были бы `null` — и тест на снэпшот не имел бы смысла.
   */
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

  test('worker создаёт OPEN MasterCall с equipment/operation snapshot', async () => {
    await startSeamstressShift();
    const res = await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'OPEN',
      message: null,
      resolvedAt: null,
      employee: {
        id: seed.employees['seamstress'].id,
        fullName: seed.employees['seamstress'].fullName,
        role: 'SEAMSTRESS',
      },
      equipment: {
        id: seed.equipment['overlock-01'].id,
        code: 'overlock-01',
      },
      operation: {
        id: seed.operations.SEW_OVERLOCK_1.id,
      },
    });
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.createdAt).toBe('string');

    const inDb = await t.prisma.masterCall.findMany({
      where: { employeeId: seed.employees['seamstress'].id },
    });
    expect(inDb).toHaveLength(1);
    expect(inDb[0]!.status).toBe('OPEN');
  });

  test('повторный POST идемпотентен: тот же id, без второй строки', async () => {
    await startSeamstressShift();
    const first = await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.createdAt).toBe(first.body.createdAt);

    const count = await t.prisma.masterCall.count({
      where: { employeeId: seed.employees['seamstress'].id },
    });
    expect(count).toBe(1);
  });

  test('GET /api/master-calls: SHOPFLOOR_MASTER видит OPEN-вызов', async () => {
    await startSeamstressShift();
    await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const list = await request(t.app.getHttpServer())
      .get('/api/master-calls')
      .set('Cookie', cookies.master)
      .expect(200);

    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      status: 'OPEN',
      employee: { id: seed.employees['seamstress'].id },
    });
    expect(Array.isArray(list.body[0].currentPassports)).toBe(true);
  });

  test('SHOPFLOOR_MASTER закрывает вызов сканом QR', async () => {
    await startSeamstressShift();
    const created = await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const resolved = await request(t.app.getHttpServer())
      .post('/api/master-calls/resolve-by-employee-qr')
      .set('Cookie', cookies.master)
      .send({ qr: `EMPLOYEE:${seed.employees['seamstress'].id}` })
      .expect(201);

    expect(resolved.body.id).toBe(created.body.id);
    expect(resolved.body.status).toBe('RESOLVED');
    expect(resolved.body.resolvedAt).toBeTruthy();

    const inDb = await t.prisma.masterCall.findUnique({
      where: { id: created.body.id },
    });
    expect(inDb?.status).toBe('RESOLVED');
    expect(inDb?.resolvedAt).toBeInstanceOf(Date);
    expect(inDb?.resolvedById).toBe(seed.employees['master'].id);

    // После закрытия очередь снова пустая.
    const list = await request(t.app.getHttpServer())
      .get('/api/master-calls')
      .set('Cookie', cookies.master)
      .expect(200);
    expect(list.body).toHaveLength(0);
  });

  test('SEAMSTRESS не имеет права закрыть вызов (FORBIDDEN_ROLE)', async () => {
    await startSeamstressShift();
    await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post('/api/master-calls/resolve-by-employee-qr')
      .set('Cookie', cookies.seamstress)
      .send({ qr: `EMPLOYEE:${seed.employees['seamstress'].id}` })
      .expect(403);

    expect(res.body?.code ?? res.body?.error?.code).toBe('FORBIDDEN_ROLE');

    // Вызов всё ещё OPEN.
    const inDb = await t.prisma.masterCall.findFirst({
      where: { employeeId: seed.employees['seamstress'].id },
    });
    expect(inDb?.status).toBe('OPEN');
  });

  test('AuditLog содержит MASTER_CALLED и MASTER_CALL_RESOLVED по одному разу', async () => {
    await startSeamstressShift();

    // Два POST подряд — но идемпотентность означает, что
    // MASTER_CALLED должен быть один (см. §10a).
    await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    const second = await request(t.app.getHttpServer())
      .post('/api/master-calls')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    await request(t.app.getHttpServer())
      .post('/api/master-calls/resolve-by-employee-qr')
      .set('Cookie', cookies.master)
      .send({ qr: `EMPLOYEE:${seed.employees['seamstress'].id}` })
      .expect(201);

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'MASTER_CALL', entityId: second.body.id },
      orderBy: { createdAt: 'asc' },
    });
    const events = audits.map((a) => a.event);
    expect(events).toContain('MASTER_CALLED');
    expect(events).toContain('MASTER_CALL_RESOLVED');
    expect(events.filter((e) => e === 'MASTER_CALLED')).toHaveLength(1);
    expect(events.filter((e) => e === 'MASTER_CALL_RESOLVED')).toHaveLength(1);
  });
});
