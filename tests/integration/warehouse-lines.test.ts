/**
 * Integration-тест массового создания ячеек через линию
 * (см. `docs/api.md §15`, `docs/domain.md §16`).
 *
 * Покрывает:
 *   1. Создание линии: `POST /api/warehouses/:id/lines { code, count }`
 *      возвращает линию и `count` ячеек с кодами `${code}1..${code}N`.
 *   2. Все созданные ячейки привязаны к складу и линии, имеют корректный
 *      QR-payload `cell:{id}` (ADR-0008) и видны в `GET /warehouses/:id`.
 *   3. Глобальная уникальность кода линии: повтор → 409
 *      `WAREHOUSE_LINE_CODE_TAKEN`. Не имеет значения, на каком складе.
 *   4. Конфликт по `Cell.code`: если ячейка с таким кодом уже есть,
 *      транзакция откатывается, линия не создаётся.
 *   5. Не ломаем существующее: ячейки без линии (seed) продолжают
 *      резолвиться через `POST /api/cells/by-code`, QR ячеек, созданных
 *      линией, парсится как `cell:{id}`.
 *   6. labelTemplate: сохраняется при create/update и виден в DTO.
 *   7. RBAC: SEAMSTRESS — 403, ADMIN/SHOP_MANAGER — 200.
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

describeWithDb('integration — warehouse lines (массовое создание ячеек)', () => {
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
      admin: loginAs(t, {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        fullName: admin.fullName,
      }),
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  // -------------------------------------------------------------------------
  // 1. Создание линии: возвращает корректные коды и QR
  // -------------------------------------------------------------------------

  test('POST /:id/lines: создаёт линию X и ячейки X1..XN', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'X', count: 20 });

    expect(res.status).toBe(201);
    expect(res.body.line).toMatchObject({ code: 'X', cellsCount: 20 });
    expect(res.body.cells).toHaveLength(20);

    const codes = res.body.cells.map((c: { code: string }) => c.code);
    expect(codes[0]).toBe('X1');
    expect(codes[19]).toBe('X20');
    expect(codes).toEqual(
      Array.from({ length: 20 }, (_, i) => `X${i + 1}`),
    );

    // QR-payload каждой ячейки — `cell:{id}` (ADR-0008), формат не сломан.
    for (const cell of res.body.cells as Array<{ id: string; qrCode: string }>) {
      expect(cell.qrCode).toBe(`cell:${cell.id}`);
    }
  });

  test('POST /:id/lines: ячейки привязаны к складу и линии', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);

    const created = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      // Берём код, не пересекающийся с seed-ячейками (A1/A2).
      .send({ code: 'C', count: 3 })
      .expect(201);

    // Через Prisma убеждаемся: warehouseId/lineId/lineIndex заполнены.
    const cells = await t.prisma.cell.findMany({
      where: { lineId: created.body.line.id },
      orderBy: { lineIndex: 'asc' },
    });
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.code)).toEqual(['C1', 'C2', 'C3']);
    expect(cells.map((c) => c.lineIndex)).toEqual([1, 2, 3]);
    expect(cells.every((c) => c.warehouseId === wh.body.id)).toBe(true);
    expect(cells.every((c) => c.active)).toBe(true);
  });

  test('GET /warehouses/:id: показывает линии и все её ячейки', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'B', count: 5 })
      .expect(201);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/warehouses/${wh.body.id}`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(detail.body.cellsCount).toBe(5);
    expect(detail.body.cells.map((c: { code: string }) => c.code)).toEqual([
      'B1',
      'B2',
      'B3',
      'B4',
      'B5',
    ]);
    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.lines[0]).toMatchObject({ code: 'B', cellsCount: 5 });
  });

  test('POST /:id/lines: count=1 — корректно создаёт одну ячейку', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Solo' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'Z', count: 1 });
    expect(res.status).toBe(201);
    expect(res.body.cells.map((c: { code: string }) => c.code)).toEqual(['Z1']);
  });

  // -------------------------------------------------------------------------
  // 2. Уникальность линии (глобально)
  // -------------------------------------------------------------------------

  test('POST /:id/lines: повторный код линии — 409 WAREHOUSE_LINE_CODE_TAKEN', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'D', count: 2 })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'D', count: 5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WAREHOUSE_LINE_CODE_TAKEN');
  });

  test('POST /:id/lines: код уникален между разными складами', async () => {
    const wh1 = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'WH-1' })
      .expect(201);
    const wh2 = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'WH-2' })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh1.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'E', count: 2 })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh2.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'E', count: 2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WAREHOUSE_LINE_CODE_TAKEN');
  });

  test('POST /:id/lines: 404 на несуществующий склад', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses/never-existed/lines')
      .set('Cookie', cookies.manager)
      .send({ code: 'A', count: 5 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WAREHOUSE_NOT_FOUND');
  });

  test('POST /:id/lines: code пустой — 400 VALIDATION_ERROR', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'X' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: '   ', count: 5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('POST /:id/lines: count < 1 — 400 VALIDATION_ERROR', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'X' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'A', count: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('POST /:id/lines: count > 200 — 400 VALIDATION_ERROR', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'X' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'A', count: 500 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // 3. Конфликт с уже существующей ячейкой (Cell.code)
  // -------------------------------------------------------------------------

  test('POST /:id/lines: конфликт с существующей Cell.code → 409, линия не создаётся', async () => {
    // Seed создаёт ячейку A1.
    expect(seed.cells['A1']).toBeDefined();

    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'A', count: 5 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WAREHOUSE_LINE_CELL_CODE_TAKEN');

    // Линия не должна была сохраниться (rollback / pre-flight).
    const lines = await t.prisma.warehouseLine.findMany({});
    expect(lines).toHaveLength(0);

    // Существующая seed-ячейка A1 не пострадала.
    const stillThere = await t.prisma.cell.findUnique({ where: { code: 'A1' } });
    expect(stillThere?.id).toBe(seed.cells['A1'].id);
  });

  // -------------------------------------------------------------------------
  // 4. Существующий flow продолжает работать
  // -------------------------------------------------------------------------

  test('POST /api/cells/by-code: ячейки, созданные линией, резолвятся по коду', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'X', count: 3 })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.manager)
      .send({ code: 'X2' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('X2');
    expect(res.body.warehouse).toMatchObject({ id: wh.body.id, name: 'Main' });
  });

  test('GET /api/cells: после создания линии ячейки попадают в общий список', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.manager)
      .send({ code: 'L', count: 2 })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .get('/api/cells')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const codes = (res.body as Array<{ code: string }>).map((c) => c.code);
    expect(codes).toContain('L1');
    expect(codes).toContain('L2');
    // Seed-ячейки A1/A2 продолжают существовать рядом — не сломали.
    expect(codes).toContain('A1');
  });

  // -------------------------------------------------------------------------
  // 5. labelTemplate: сохраняется и виден в DTO
  // -------------------------------------------------------------------------

  test('POST /api/warehouses: сохраняет labelTemplate', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'with-template', labelTemplate: '{"size":"A6"}' });
    expect(res.status).toBe(201);
    expect(res.body.labelTemplate).toBe('{"size":"A6"}');
  });

  test('PATCH /api/warehouses/:id: обновляет labelTemplate', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'no-template' })
      .expect(201);
    expect(created.body.labelTemplate).toBeNull();
    const res = await request(t.app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({ labelTemplate: 'plain text label' });
    expect(res.status).toBe(200);
    expect(res.body.labelTemplate).toBe('plain text label');
  });

  test('PATCH /api/warehouses/:id: пустой labelTemplate сбрасывается в null', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'reset-template', labelTemplate: 'something' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({ labelTemplate: '   ' });
    expect(res.status).toBe(200);
    expect(res.body.labelTemplate).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. RBAC
  // -------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS — 403 на POST /:id/lines', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.seamstress)
      .send({ code: 'A', count: 3 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: ADMIN — может создавать линии', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.admin)
      .send({ name: 'Main' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${wh.body.id}/lines`)
      .set('Cookie', cookies.admin)
      .send({ code: 'F', count: 2 });
    expect(res.status).toBe(201);
    expect(res.body.cells).toHaveLength(2);
  });
});
