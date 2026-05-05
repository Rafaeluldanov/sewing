/**
 * Integration-тест для `ShiftsService` / `POST /api/shifts/*` —
 * dedicated coverage по плану `docs/test-gap-plan.md §P0-3`.
 *
 * Что покрываем здесь и больше нигде:
 *   - lifecycle одной смены (start → current → stop), включая контракт
 *     DTO в `packages/shared/src/shifts.ts`;
 *   - сервис-уровневый инвариант «одна активная смена на сотрудника»
 *     (`ShiftAlreadyActiveException`); БД-уровень того же инварианта
 *     (partial unique) уже покрыт в `db-invariants.test.ts`;
 *   - 4xx-ветки start: bad equipmentId/operationId, inactive equipment/
 *     operation;
 *   - stop без активной смены → `ShiftNotActiveException` (409, не 500);
 *   - `getCurrent` без смены и со сменой;
 *   - `getCurrentWork` фильтрует `Passport.status != IN_PROGRESS` —
 *     дополнительный угол к `current-work.test.ts`, который проверяет
 *     только сценарий «смена `currentEmployeeId`», но не сценарий
 *     терминальных статусов;
 *   - 401 на mutation/read, у кого нет cookie.
 *
 * Чего сознательно НЕ покрываем (есть у соседей — не дублируем):
 *   - `SalaryService.syncDailySalary` trigger из shift start/stop —
 *     полностью покрыт в `salary.test.ts §1..§4` (SALARY/PIECEWORK/
 *     MIXED + idempotency 5x start/stop). DTO PIECEWORK тоже там.
 *   - allow-list `Equipment.allowedOperations` в `/shifts/meta` — есть
 *     в `equipment-operations.test.ts §220..§272`, `qc-shift-flow.test.ts`,
 *     `cutter-assistant-shift.test.ts §133..§149`.
 *   - happy-path старта смены CUTTER_ASSISTANT — в `cutter-assistant-
 *     shift.test.ts`. Здесь стартуем швеёй, чтобы не дублировать.
 *   - DB partial unique active-shift — в `db-invariants.test.ts §31..§64`.
 *
 * FINDING (см. `docs/operations-test-findings.md`):
 *   `ShiftsService.start` НЕ проверяет, что `operationId` входит в
 *   `Equipment.allowedOperations`. Источник истины (`/shifts/meta`)
 *   корректно отдаёт allow-list, но контроллер старта смены примет
 *   любую активную операцию на любом активном оборудовании. Этот
 *   gap фиксируем характеристическим тестом «pinned current behavior».
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

describeWithDb('integration — ShiftsService dedicated coverage', () => {
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
      packer: loginAs(t, seed.employees['packer']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. start — happy path + контракт DTO
  // ---------------------------------------------------------------------------

  test('POST /api/shifts/start: создаёт активную ShiftSession и отдаёт DTO', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations.SEW_OVERLOCK_1;

    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      employeeId: seed.employees.seamstress.id,
      equipmentId: eq.id,
      equipmentCode: 'overlock-01',
      operationId: op.id,
      operationCode: 'SEW_OVERLOCK_1',
      active: true,
      endedAt: null,
    });
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.startedAt).toBe('string');

    // Persisted row совпадает с DTO.
    const row = await t.prisma.shiftSession.findFirst({
      where: { employeeId: seed.employees.seamstress.id, endedAt: null },
    });
    expect(row).not.toBeNull();
    expect(row!.equipmentId).toBe(eq.id);
    expect(row!.operationId).toBe(op.id);
  });

  // ---------------------------------------------------------------------------
  // 2. start — инвариант «одна активная смена на сотрудника»
  // ---------------------------------------------------------------------------

  test('повторный start без stop → 409 SHIFT_ALREADY_ACTIVE, в БД остаётся одна активная смена', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations.SEW_OVERLOCK_1;

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SHIFT_ALREADY_ACTIVE');

    const active = await t.prisma.shiftSession.findMany({
      where: { employeeId: seed.employees.seamstress.id, endedAt: null },
    });
    expect(active).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 3. start — 4xx ветки на отсутствующих/неактивных ссылках
  // ---------------------------------------------------------------------------

  test('start с неизвестным equipmentId → 404 EQUIPMENT_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: '00000000-0000-0000-0000-000000000000',
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EQUIPMENT_NOT_FOUND');
  });

  test('start с неизвестным operationId → 404 OPERATION_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: '00000000-0000-0000-0000-000000000000',
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OPERATION_NOT_FOUND');
  });

  test('start с inactive equipment → 409 EQUIPMENT_INACTIVE, ShiftSession не создаётся', async () => {
    const eq = seed.equipment['overlock-01'];
    await t.prisma.equipment.update({ where: { id: eq.id }, data: { active: false } });

    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: eq.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_INACTIVE');

    const created = await t.prisma.shiftSession.findFirst({
      where: { employeeId: seed.employees.seamstress.id },
    });
    expect(created).toBeNull();
  });

  test('start с inactive operation → 409 OPERATION_INACTIVE', async () => {
    const op = seed.operations.SEW_OVERLOCK_1;
    await t.prisma.operation.update({ where: { id: op.id }, data: { active: false } });

    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: op.id,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPERATION_INACTIVE');
  });

  // ---------------------------------------------------------------------------
  // 4. Allow-list EquipmentOperation enforcement на старте смены
  //    (был finding, fixed в ShiftsService.start; см.
  //    docs/operations-test-findings.md §Resolved).
  // ---------------------------------------------------------------------------

  test('start с operationId вне Equipment.allowedOperations → 409 SHIFT_OPERATION_NOT_ALLOWED_FOR_EQUIPMENT, ShiftSession не создаётся', async () => {
    // qc-station-01 разрешает только QC, не CUT_DIVISION (см. seedMinimal).
    // /shifts/meta уже отрезает этот mismatch для UI; теперь и backend
    // на POST /shifts/start блокирует обходной запрос.
    const eq = seed.equipment['qc-station-01'];
    const op = seed.operations.CUT_DIVISION;

    // Источник правды — тот же, что у /shifts/meta: проверяем, что
    // mismatch действительно есть в allow-list карте.
    const meta = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    const qcStation = (meta.body.equipment as Array<{
      code: string;
      allowedOperationIds: string[];
    }>).find((e) => e.code === 'qc-station-01');
    expect(qcStation, 'qc-station-01 must be present in meta').toBeDefined();
    expect(qcStation!.allowedOperationIds).not.toContain(op.id);

    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_OPERATION_NOT_ALLOWED_FOR_EQUIPMENT');

    const created = await t.prisma.shiftSession.findFirst({
      where: { employeeId: seed.employees.seamstress.id },
    });
    expect(created).toBeNull();
  });

  test('start с EquipmentOperation isActive=false → 409 SHIFT_OPERATION_NOT_ALLOWED_FOR_EQUIPMENT (soft-delete биндинга)', async () => {
    // overlock-01 ↔ SEW_OVERLOCK_1 — нормально разрешённая пара. Если
    // менеджер «выключил» связь через `isActive=false` (см. ADR-0017),
    // start не должен проходить — даже если операция и оборудование
    // оба `active=true`.
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations.SEW_OVERLOCK_1;
    await t.prisma.equipmentOperation.updateMany({
      where: { equipmentId: eq.id, operationId: op.id },
      data: { isActive: false },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_OPERATION_NOT_ALLOWED_FOR_EQUIPMENT');
  });

  // ---------------------------------------------------------------------------
  // 5. stop — happy path + 409 без активной смены
  // ---------------------------------------------------------------------------

  test('POST /api/shifts/stop: закрывает активную смену, current → null', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations.SEW_OVERLOCK_1;

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const stop = await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(stop.status).toBe(201);
    expect(stop.body).toMatchObject({
      employeeId: seed.employees.seamstress.id,
      equipmentCode: 'overlock-01',
      operationCode: 'SEW_OVERLOCK_1',
      active: false,
    });
    expect(typeof stop.body.endedAt).toBe('string');

    // Активной смены больше нет.
    const stillOpen = await t.prisma.shiftSession.findFirst({
      where: { employeeId: seed.employees.seamstress.id, endedAt: null },
    });
    expect(stillOpen).toBeNull();
  });

  test('stop без активной смены → 409 SHIFT_NOT_ACTIVE, новая ShiftSession не создаётся', async () => {
    const stop = await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(stop.status).toBe(409);
    expect(stop.body.code).toBe('SHIFT_NOT_ACTIVE');

    const all = await t.prisma.shiftSession.findMany({
      where: { employeeId: seed.employees.seamstress.id },
    });
    expect(all).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 6. getCurrent — пустой и заполненный
  // ---------------------------------------------------------------------------

  test('GET /api/shifts/current без активной смены — falsy body, без 500', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/current')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    // NestJS возвращает `null`, supertest парсит пустое тело как `{}`.
    // Проверяем по контракту DTO (см. cutter-assistant-shift.test.ts).
    expect(res.body).not.toMatchObject({ active: true });
    expect(res.body.equipmentId).toBeUndefined();
  });

  test('GET /api/shifts/current с активной сменой — отдаёт DTO', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations.SEW_OVERLOCK_1;
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/current')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      employeeId: seed.employees.seamstress.id,
      equipmentCode: 'overlock-01',
      operationCode: 'SEW_OVERLOCK_1',
      active: true,
    });
  });

  // ---------------------------------------------------------------------------
  // 7. getCurrentWork — focused на статус-фильтрацию, не дублируя
  //    `current-work.test.ts` (там покрыт сценарий «currentEmployeeId
  //    перезаписан другим сотрудником»).
  // ---------------------------------------------------------------------------

  test('current-work: PACKED-паспорт не возвращается даже при currentEmployeeId=me', async () => {
    // Готовим passport с status=PACKED, но искусственно оставляем
    // currentEmployeeId на seamstress — чтобы убедиться, что фильтрация
    // именно по статусу, а не только по currentEmployeeId.
    const orderId = await createOrderInProduction(t, seed, cookies.manager);
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-PACKED-${Date.now()}`,
        qrCode: `passport:packed-${Date.now()}`,
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-PACKED',
        cutDate: new Date(),
        qtyPlan: 1,
        qtyCut: 1,
        qtyGood: 1,
        qtyDefect: 0,
        status: 'PACKED',
        currentEmployeeId: seed.employees.seamstress.id,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(res.body).toEqual([]);
    // Контрольно: паспорт действительно создан (тест не пустой).
    expect(passport.status).toBe('PACKED');
  });

  // ---------------------------------------------------------------------------
  // 8. RBAC basics — 401 без cookie
  // ---------------------------------------------------------------------------

  test('401 без cookie на /api/shifts/start | /stop | /current | /current-work | /meta', async () => {
    // No-cookie checks are sequential to avoid ECONNRESET / flaky
    // parallel supertest requests against the embedded Nest server.
    const server = t.app.getHttpServer();

    const startRes = await request(server)
      .post('/api/shifts/start')
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      });
    expect(startRes.status).toBe(401);

    const stopRes = await request(server).post('/api/shifts/stop').send({});
    expect(stopRes.status).toBe(401);

    const currentRes = await request(server).get('/api/shifts/current');
    expect(currentRes.status).toBe(401);

    const currentWorkRes = await request(server).get(
      '/api/shifts/current-work',
    );
    expect(currentWorkRes.status).toBe(401);

    const metaRes = await request(server).get('/api/shifts/meta');
    expect(metaRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createOrderInProduction(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<string> {
  const created = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
    })
    .expect(201);
  await request(t.app.getHttpServer())
    .post(`/api/orders/${created.body.id}/start`)
    .set('Cookie', cookie)
    .expect(201);
  return created.body.id as string;
}

