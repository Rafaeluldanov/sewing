/**
 * Integration-тест управления оборудованием и его операциями
 * (см. ADR-0017, `docs/api.md §3a`).
 *
 * Сценарии:
 *   1. seed создаёт связи `EquipmentOperation` (overlock-01 →
 *      SEW_OVERLOCK_1, SEW_OVERLOCK_2; qc-station-01 → QC и т.д.).
 *   2. `GET /api/equipment` возвращает список с количеством
 *      разрешённых операций.
 *   3. `GET /api/equipment/:id` возвращает карточку с allowed-операциями
 *      в правильном порядке.
 *   4. `PATCH /api/equipment/:id/operations` полностью заменяет набор
 *      (удаляет, добавляет, переупорядочивает).
 *   5. `GET /api/shifts/meta` отдаёт `equipment[].allowedOperationIds`,
 *      и швея с обновлённым набором тут же видит новые операции.
 *   6. Если у оборудования нет ни одной операции — список пустой
 *      (UI-сторона отрисует empty-state).
 *   7. RBAC: SEAMSTRESS не может вызвать ни GET ни PATCH; SHOP_MANAGER
 *      и ADMIN — могут.
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

describeWithDb('integration — equipment <-> operations (ADR-0017)', () => {
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
        paymentType: 'SALARY',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'RBAC Admin' },
    });

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      cutter: loginAs(t, seed.employees['cutter']),
      admin: loginAs(t, {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        fullName: admin.fullName,
      }),
    };
  });

  // -------------------------------------------------------------------------
  // 1. Seed создаёт связи
  // -------------------------------------------------------------------------

  test('seed: overlock-01 разрешает SEW_OVERLOCK_1 и SEW_OVERLOCK_2', async () => {
    const eq = seed.equipment['overlock-01'];
    const links = await t.prisma.equipmentOperation.findMany({
      where: { equipmentId: eq.id },
      include: { operation: true },
      orderBy: { sortOrder: 'asc' },
    });
    expect(links.map((l) => l.operation.code)).toEqual([
      'SEW_OVERLOCK_1',
      'SEW_OVERLOCK_2',
    ]);
    expect(links.every((l) => l.isActive)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. GET /api/equipment
  // -------------------------------------------------------------------------

  test('GET /api/equipment: SHOP_MANAGER видит счётчик allowedOperationsCount', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/equipment')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const overlock = res.body.find(
      (eq: { code: string }) => eq.code === 'overlock-01',
    );
    expect(overlock).toBeDefined();
    expect(overlock.allowedOperationsCount).toBe(2);
    const qc = res.body.find(
      (eq: { code: string }) => eq.code === 'qc-station-01',
    );
    expect(qc.allowedOperationsCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. GET /api/equipment/:id
  // -------------------------------------------------------------------------

  test('GET /api/equipment/:id: возвращает allowedOperations упорядоченно', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .get(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('overlock-01');
    expect(
      res.body.allowedOperations.map(
        (l: { operationCode: string }) => l.operationCode,
      ),
    ).toEqual(['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2']);
  });

  test('GET /api/equipment/missing: 404 EQUIPMENT_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/equipment/does-not-exist')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EQUIPMENT_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // 4. PATCH /api/equipment/:id/operations
  // -------------------------------------------------------------------------

  test('PATCH operations: полная замена набора (add + remove + reorder)', async () => {
    const eq = seed.equipment['overlock-01'];
    // На overlock-01 включено [SEW_OVERLOCK_1, SEW_OVERLOCK_2].
    // Заменяем на [SEW_OVERLOCK_2, QC] — должны увидеть удаление,
    // добавление и обратный порядок.
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.manager)
      .send({
        operationIds: [
          seed.operations['SEW_OVERLOCK_2'].id,
          seed.operations['QC'].id,
        ],
      });
    expect(res.status).toBe(200);
    expect(
      res.body.allowedOperations.map(
        (l: { operationCode: string }) => l.operationCode,
      ),
    ).toEqual(['SEW_OVERLOCK_2', 'QC']);

    const dbLinks = await t.prisma.equipmentOperation.findMany({
      where: { equipmentId: eq.id },
      orderBy: { sortOrder: 'asc' },
      include: { operation: true },
    });
    expect(dbLinks.map((l) => l.operation.code)).toEqual([
      'SEW_OVERLOCK_2',
      'QC',
    ]);
  });

  test('PATCH operations: пустой массив = «нет ни одной операции»', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.manager)
      .send({ operationIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.allowedOperations).toEqual([]);

    // /shifts/meta тоже должен показать пустой allowedOperationIds.
    const meta = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.seamstress);
    expect(meta.status).toBe(200);
    const overlockInMeta = meta.body.equipment.find(
      (q: { code: string }) => q.code === 'overlock-01',
    );
    expect(overlockInMeta.allowedOperationIds).toEqual([]);
  });

  test('PATCH operations: 400 на дубликаты', async () => {
    const eq = seed.equipment['overlock-01'];
    const opId = seed.operations['SEW_OVERLOCK_1'].id;
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.manager)
      .send({ operationIds: [opId, opId] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('PATCH operations: 404 если operationId не существует', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.manager)
      .send({ operationIds: ['never-existed'] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OPERATION_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // 5. /shifts/meta — backend-driven /work
  // -------------------------------------------------------------------------

  test('/shifts/meta: equipment.allowedOperationIds — это «правда» для /work', async () => {
    const meta1 = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.seamstress);
    expect(meta1.status).toBe(200);
    const overlockBefore = meta1.body.equipment.find(
      (q: { code: string }) => q.code === 'overlock-01',
    );
    const op1 = seed.operations['SEW_OVERLOCK_1'].id;
    const op2 = seed.operations['SEW_OVERLOCK_2'].id;
    expect(overlockBefore.allowedOperationIds).toEqual([op1, op2]);

    // Меняем набор: оставляем только OVERLOCK_2 в первом порядке.
    await request(t.app.getHttpServer())
      .patch(`/api/equipment/${seed.equipment['overlock-01'].id}/operations`)
      .set('Cookie', cookies.manager)
      .send({ operationIds: [op2] })
      .expect(200);

    const meta2 = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.seamstress);
    const overlockAfter = meta2.body.equipment.find(
      (q: { code: string }) => q.code === 'overlock-01',
    );
    expect(overlockAfter.allowedOperationIds).toEqual([op2]);
  });

  // -------------------------------------------------------------------------
  // 6. /shifts/meta скрывает неактивные операции
  // -------------------------------------------------------------------------

  test('/shifts/meta: исключает связи с операцией active=false', async () => {
    const eq = seed.equipment['overlock-01'];
    // Деактивируем SEW_OVERLOCK_1 — связь остаётся, но в meta пропадает.
    await t.prisma.operation.update({
      where: { id: seed.operations['SEW_OVERLOCK_1'].id },
      data: { active: false },
    });

    const meta = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.seamstress);
    const overlock = meta.body.equipment.find(
      (q: { code: string }) => q.code === eq.code,
    );
    expect(overlock.allowedOperationIds).toEqual([
      seed.operations['SEW_OVERLOCK_2'].id,
    ]);
  });

  // -------------------------------------------------------------------------
  // 7. RBAC
  // -------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS — 403 на GET /api/equipment', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/equipment')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: SEAMSTRESS — 403 на PATCH operations', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.seamstress)
      .send({ operationIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: ADMIN, SHOP_MANAGER — 200', async () => {
    for (const who of ['admin', 'manager'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/equipment')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(200);
    }
  });

  test('RBAC: QC и CUTTER — 403', async () => {
    for (const who of ['qc', 'cutter'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/equipment')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // 7a. displayNumber — ручной номер станка для физической маркировки
  // -------------------------------------------------------------------------

  test('seed: каждый станок получает displayNumber', async () => {
    const overlock = await t.prisma.equipment.findUnique({
      where: { id: seed.equipment['overlock-01'].id },
    });
    expect(overlock?.displayNumber).toBe('1');
    const qc = await t.prisma.equipment.findUnique({
      where: { id: seed.equipment['qc-station-01'].id },
    });
    expect(qc?.displayNumber).toBe('1');
  });

  test('GET /api/equipment summary включает displayNumber', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/equipment')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const overlock = res.body.find(
      (eq: { code: string }) => eq.code === 'overlock-01',
    );
    expect(overlock).toMatchObject({ displayNumber: '1' });
  });

  test('GET /api/equipment/:id detail включает displayNumber', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .get(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.displayNumber).toBe('1');
  });

  test('PATCH /api/equipment/:id сохраняет displayNumber', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ displayNumber: '42' });
    expect(res.status).toBe(200);
    expect(res.body.displayNumber).toBe('42');

    const row = await t.prisma.equipment.findUnique({ where: { id: eq.id } });
    expect(row?.displayNumber).toBe('42');
  });

  test('PATCH /api/equipment/:id триммит и обнуляет пустую строку в null', async () => {
    const eq = seed.equipment['overlock-01'];
    const r1 = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ displayNumber: '   ' });
    expect(r1.status).toBe(200);
    expect(r1.body.displayNumber).toBeNull();

    const r2 = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ displayNumber: null });
    expect(r2.status).toBe(200);
    expect(r2.body.displayNumber).toBeNull();
  });

  test('PATCH /api/equipment/:id 400 на слишком длинный номер', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ displayNumber: 'X'.repeat(20) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('PATCH /api/equipment/:id 404 на несуществующее оборудование', async () => {
    const res = await request(t.app.getHttpServer())
      .patch('/api/equipment/does-not-exist')
      .set('Cookie', cookies.manager)
      .send({ displayNumber: '7' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EQUIPMENT_NOT_FOUND');
  });

  test('RBAC: SEAMSTRESS — 403 на PATCH /api/equipment/:id', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.seamstress)
      .send({ displayNumber: '99' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: ADMIN — может обновлять displayNumber', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.admin)
      .send({ displayNumber: '7' });
    expect(res.status).toBe(200);
    expect(res.body.displayNumber).toBe('7');
  });

  // -------------------------------------------------------------------------
  // 7b. Печатная этикетка QR оборудования
  // -------------------------------------------------------------------------

  test('GET /api/equipment/:id/print отдаёт HTML с QR и displayNumber', async () => {
    const eq = seed.equipment['overlock-01'];
    // Сначала проставим понятный номер.
    await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ displayNumber: '7' })
      .expect(200);

    const res = await request(t.app.getHttpServer()).get(
      `/api/equipment/${eq.id}/print`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Крупный номер — главный визуальный элемент этикетки.
    expect(res.text).toContain('№7');
    expect(res.text).toContain(eq.code);
    // QR-код встраивается как data URL с base64 PNG.
    expect(res.text).toMatch(/<img[^>]+src="data:image\/png;base64,/);
  });

  test('GET /api/equipment/:id/print остаётся @Public — без сессии', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer()).get(
      `/api/equipment/${eq.id}/print`,
    );
    // Никаких 401/403 — печатная станция работает без сессии.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test('GET /api/equipment/:id/print 404 на несуществующее оборудование', async () => {
    const res = await request(t.app.getHttpServer()).get(
      '/api/equipment/missing/print',
    );
    expect(res.status).toBe(404);
  });

  test('GET /api/equipment/:id/qr отдаёт PNG', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer()).get(
      `/api/equipment/${eq.id}/qr`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // PNG-сигнатура (89 50 4E 47).
    expect(res.body.slice(0, 4).toString('hex')).toBe('89504e47');
  });

  test('print etiketka: если displayNumber пуст — показывает «—», но не падает', async () => {
    const eq = seed.equipment['overlock-01'];
    await t.prisma.equipment.update({
      where: { id: eq.id },
      data: { displayNumber: null },
    });
    const res = await request(t.app.getHttpServer()).get(
      `/api/equipment/${eq.id}/print`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('номер не задан');
    expect(res.text).toContain('№—');
  });

  // -------------------------------------------------------------------------
  // 8. Стартовый flow смены: /work опирается только на /shifts/meta
  // -------------------------------------------------------------------------

  test('start-shift всё ещё проходит, если operationId есть в allowed-наборе', async () => {
    const overlock = seed.equipment['overlock-01'];
    const op = seed.operations['SEW_OVERLOCK_2'];
    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: overlock.id, operationId: op.id });
    expect(res.status).toBe(201);
    expect(res.body.equipmentCode).toBe('overlock-01');
    expect(res.body.operationCode).toBe('SEW_OVERLOCK_2');
  });

  // -------------------------------------------------------------------------
  // 9. PATCH /api/equipment/:id — переименование (ADR-0017 §5)
  // -------------------------------------------------------------------------

  test('PATCH /api/equipment/:id обновляет name', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ name: 'Оверлок №1 (новое название)' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Оверлок №1 (новое название)');
    // ID, code и qrCode при переименовании не меняются — printer
    // bindings и уже отсканированные QR продолжают работать.
    expect(res.body.id).toBe(eq.id);
    expect(res.body.code).toBe(eq.code);
    expect(res.body.qrCode).toBe(eq.qrCode);

    const row = await t.prisma.equipment.findUnique({ where: { id: eq.id } });
    expect(row?.name).toBe('Оверлок №1 (новое название)');
  });

  test('PATCH /api/equipment/:id одновременно name + displayNumber', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ name: 'Оверлок A', displayNumber: '11' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Оверлок A');
    expect(res.body.displayNumber).toBe('11');
  });

  test('PATCH /api/equipment/:id 400 на пустой name', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('PATCH /api/equipment/:id 400 на слишком длинный name', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({ name: 'X'.repeat(200) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('PATCH /api/equipment/:id 400 если ничего не передано', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // 10. POST /api/equipment — создание оборудования (ADR-0017 §5)
  // -------------------------------------------------------------------------

  test('POST /api/equipment создаёт оборудование с явным name+code', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Оверлок 99',
        code: 'overlock-99',
        displayNumber: '99',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Оверлок 99',
      code: 'overlock-99',
      displayNumber: '99',
      active: true,
      allowedOperations: [],
    });
    // qrCode формируется из id (ADR-0008) — scan flow совместим.
    expect(res.body.qrCode).toBe(`equipment:${res.body.id}`);

    // Запись виден в списке.
    const list = await request(t.app.getHttpServer())
      .get('/api/equipment')
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    expect(
      list.body.some((eq: { code: string }) => eq.code === 'overlock-99'),
    ).toBe(true);
  });

  test('POST /api/equipment автогенерит код из имени, когда code не задан', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: 'Оверлок 03' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Оверлок 03');
    // slug от «Оверлок 03» = «overlok-03» (ё→e, к→k и т. д.).
    expect(res.body.code).toMatch(/^overlok-03/);
    expect(res.body.qrCode).toBe(`equipment:${res.body.id}`);
  });

  test('POST /api/equipment добавляет суффикс при коллизии автогенерируемого кода', async () => {
    const r1 = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: 'Распошив 50' });
    expect(r1.status).toBe(201);

    const r2 = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: 'Распошив 50' });
    expect(r2.status).toBe(201);
    expect(r2.body.code).not.toBe(r1.body.code);
    expect(r2.body.code.startsWith(r1.body.code)).toBe(true);
  });

  test('POST /api/equipment связывает переданные operationIds в порядке массива', async () => {
    const op1 = seed.operations['SEW_OVERLOCK_1'].id;
    const op2 = seed.operations['SEW_OVERLOCK_2'].id;
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Оверлок 04',
        operationIds: [op2, op1],
      });
    expect(res.status).toBe(201);
    expect(
      res.body.allowedOperations.map(
        (l: { operationCode: string }) => l.operationCode,
      ),
    ).toEqual(['SEW_OVERLOCK_2', 'SEW_OVERLOCK_1']);

    const dbLinks = await t.prisma.equipmentOperation.findMany({
      where: { equipmentId: res.body.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(dbLinks).toHaveLength(2);
    expect(dbLinks.map((l) => l.sortOrder)).toEqual([10, 20]);
  });

  test('POST /api/equipment 400 на пустой name', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('POST /api/equipment 400 на слишком длинный name', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: 'X'.repeat(200) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('POST /api/equipment 400 на код в неверном формате', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: 'Оверлок 05', code: 'OVERLOCK_05' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('POST /api/equipment 409 EQUIPMENT_CODE_TAKEN при дубликате явного кода', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: 'Дубликат', code: eq.code });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_CODE_TAKEN');
  });

  test('POST /api/equipment 404 если operationId не существует', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Оверлок 06',
        operationIds: ['never-existed'],
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OPERATION_NOT_FOUND');
  });

  test('RBAC: SEAMSTRESS — 403 на POST /api/equipment', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.seamstress)
      .send({ name: 'Оверлок 07' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: ADMIN и SHOP_MANAGER могут создавать оборудование', async () => {
    for (const who of ['admin', 'manager'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/equipment')
        .set('Cookie', cookies[who])
        .send({ name: `Оверлок ${who}` });
      expect(res.status, `role=${who}`).toBe(201);
    }
  });

  // -------------------------------------------------------------------------
  // 11. После создания оборудования печать QR работает сразу
  // -------------------------------------------------------------------------

  test('Свежесозданное оборудование сразу выдаёт валидную QR-этикетку', async () => {
    const create = await request(t.app.getHttpServer())
      .post('/api/equipment')
      .set('Cookie', cookies.manager)
      .send({ name: 'Тест печати', displayNumber: '777' });
    expect(create.status).toBe(201);

    const res = await request(t.app.getHttpServer()).get(
      `/api/equipment/${create.body.id}/print`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('№777');
    expect(res.text).toMatch(/<img[^>]+src="data:image\/png;base64,/);
  });

  // -------------------------------------------------------------------------
  // 12. UX-контракт: создание операции с одновременной привязкой к
  //     оборудованию (без расширения API, см. `docs/api.md §15a` и
  //     `screens.md §10c`).
  //
  //     Симулируем то, что делает server action
  //     `createOperationAction` на /admin/operations/new:
  //       1) POST /api/operations  — создаёт глобальную операцию;
  //       2) GET  /api/equipment/:id — читаем текущий allow-list;
  //       3) PATCH /api/equipment/:id/operations { operationIds: [...current, newId] }
  //          — full-replace, аккуратно дописывая новый id.
  //     Цель — гарантировать, что после такой последовательности
  //     /shifts/meta для seamstress отдаёт новую операцию внутри
  //     equipment.allowedOperationIds, и что прежние связи не стёрты.
  // -------------------------------------------------------------------------

  test('UX: новая операция + привязка к станку → попадает в /shifts/meta.allowedOperationIds', async () => {
    const eq = seed.equipment['overlock-01'];

    // 1) Создаём операцию.
    const create = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'SEW_OVERLOCK_3',
        name: 'Оверлок 3',
        category: 'SEWING',
        pricingMode: 'FIXED',
        fixedRate: 12.5,
      });
    expect(create.status).toBe(201);
    const newOpId: string = create.body.id;

    // 2) Читаем текущий allow-list (overlock-01 уже разрешает 1 и 2).
    const before = await request(t.app.getHttpServer())
      .get(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager);
    expect(before.status).toBe(200);
    const currentIds: string[] = before.body.allowedOperations.map(
      (l: { operationId: string }) => l.operationId,
    );
    expect(currentIds).toEqual([
      seed.operations['SEW_OVERLOCK_1'].id,
      seed.operations['SEW_OVERLOCK_2'].id,
    ]);

    // 3) PATCH full-replace с дописанным новым id (как делает action).
    const patch = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.manager)
      .send({ operationIds: [...currentIds, newOpId] });
    expect(patch.status).toBe(200);
    expect(
      patch.body.allowedOperations.map(
        (l: { operationCode: string }) => l.operationCode,
      ),
    ).toEqual(['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2', 'SEW_OVERLOCK_3']);

    // 4) Швея в meta видит новую операцию в этом станке.
    const meta = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.seamstress);
    expect(meta.status).toBe(200);
    const overlockMeta = meta.body.equipment.find(
      (q: { code: string }) => q.code === 'overlock-01',
    );
    expect(overlockMeta.allowedOperationIds).toEqual([
      seed.operations['SEW_OVERLOCK_1'].id,
      seed.operations['SEW_OVERLOCK_2'].id,
      newOpId,
    ]);
  });

  test('UX: dedupe — повторная привязка той же операции не плодит дубликаты', async () => {
    const eq = seed.equipment['overlock-01'];
    // Создаём «новую» (по сути — дубль одной из существующих по семантике,
    // но с другим code, чтобы пройти валидацию).
    const create = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'SEW_OVERLOCK_DUP',
        name: 'Оверлок dup',
        category: 'SEWING',
        pricingMode: 'FIXED',
        fixedRate: 1,
      });
    expect(create.status).toBe(201);
    const newOpId: string = create.body.id;

    // Делаем то, что делает action: читаем allow-list, дописываем,
    // PATCH-им. Имитируем и второй проход — id уже там.
    const eq1 = await request(t.app.getHttpServer())
      .get(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager);
    const ids1: string[] = eq1.body.allowedOperations.map(
      (l: { operationId: string }) => l.operationId,
    );
    const next1 = ids1.includes(newOpId) ? ids1 : [...ids1, newOpId];
    await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.manager)
      .send({ operationIds: next1 })
      .expect(200);

    const eq2 = await request(t.app.getHttpServer())
      .get(`/api/equipment/${eq.id}`)
      .set('Cookie', cookies.manager);
    const ids2: string[] = eq2.body.allowedOperations.map(
      (l: { operationId: string }) => l.operationId,
    );
    // Action пропускает PATCH, если operationId уже есть. Симулируем
    // именно «не дублировать»: повторно отправлять не надо.
    expect(ids2.filter((id) => id === newOpId)).toHaveLength(1);

    // На всякий случай — дубликаты в одном PATCH запрещены backend-ом.
    const dup = await request(t.app.getHttpServer())
      .patch(`/api/equipment/${eq.id}/operations`)
      .set('Cookie', cookies.manager)
      .send({ operationIds: [newOpId, newOpId] });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('VALIDATION_ERROR');
  });

  test('UX: «без выбора оборудования» — операция создаётся, но в /shifts/meta её ни у одного станка нет', async () => {
    // Допустимый сценарий по UX: ничего не отметили в чек-листе.
    const create = await request(t.app.getHttpServer())
      .post('/api/operations')
      .set('Cookie', cookies.manager)
      .send({
        code: 'SEW_GLOBAL_ONLY',
        name: 'Только глобально',
        category: 'SEWING',
        pricingMode: 'FIXED',
        fixedRate: 5,
      });
    expect(create.status).toBe(201);
    const newOpId: string = create.body.id;

    const meta = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.seamstress);
    expect(meta.status).toBe(200);
    for (const eq of meta.body.equipment) {
      expect(eq.allowedOperationIds).not.toContain(newOpId);
    }
  });
});
