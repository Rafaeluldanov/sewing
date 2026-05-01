/**
 * Integration-тест модуля «Склады» (см. ADR-0019, `docs/api.md §15`,
 * `docs/domain.md §16`, `docs/screens.md §10b`).
 *
 * Сценарии:
 *   1. CRUD: list / create / getOne / update — менеджер видит склады,
 *      может создать, переименовать, поменять `code`/`isActive`.
 *   2. Уникальность: повторное `name`/`code` отдают бизнес-ошибки
 *      `WAREHOUSE_NAME_TAKEN` / `WAREHOUSE_CODE_TAKEN` (409).
 *   3. Привязка ячеек: `PATCH /api/cells/:id { warehouseId }` —
 *      кладёт `Cell.warehouseId`, `GET /api/cells/:id` отдаёт
 *      `warehouse: {…}`, склад в `GET /warehouses/:id` показывает её
 *      в `cells[]`. Перепривязка между складами и сброс на `null` —
 *      работают.
 *   4. Не ломаем существующий flow: ячейка без склада продолжает
 *      резолвиться через `POST /api/cells/by-code` и видеться в
 *      `GET /api/cells`.
 *   5. QR/print: `GET /api/cells/:id/print` — публичный HTML A6,
 *      `GET /api/cells/:id/qr` — PNG. Формат payload `cell:{id}`
 *      (ADR-0008) не меняется.
 *   6. RBAC: SEAMSTRESS / QC / CUTTER — 403 на админских ручках;
 *      ADMIN и SHOP_MANAGER — 200.
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

describeWithDb('integration — warehouses (ADR-0019)', () => {
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

    // resetDatabase стирает и системного admin-а из startTestApp(),
    // поэтому пересоздаём его перед каждым тестом — без него RBAC-сценарий
    // «ADMIN может всё» падает с 401 (см. equipment-operations.test.ts).
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
      qc: loginAs(t, seed.employees['qc']),
      cutter: loginAs(t, seed.employees['cutter']),
      packer: loginAs(t, seed.employees['packer']),
    };
  });

  // -------------------------------------------------------------------------
  // 1. CRUD
  // -------------------------------------------------------------------------

  test('GET /api/warehouses: пустой список после seed', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/warehouses')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });

  test('POST /api/warehouses: создаёт склад с дефолтным isActive=true', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main', code: 'MAIN' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Main',
      code: 'MAIN',
      isActive: true,
      cellsCount: 0,
      cells: [],
    });
    expect(res.body.id).toMatch(/^[a-z0-9]+$/i);
    expect(typeof res.body.createdAt).toBe('string');
  });

  test('POST /api/warehouses: пустой code трактуется как null', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'NoCodeWh', code: '   ' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBeNull();
  });

  test('POST /api/warehouses: 400 на пустое имя', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('GET /api/warehouses/:id: возвращает карточку с пустым списком ячеек', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'WH-A' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .get(`/api/warehouses/${created.body.id}`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: created.body.id,
      name: 'WH-A',
      cellsCount: 0,
      cells: [],
    });
  });

  test('GET /api/warehouses/missing: 404 WAREHOUSE_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/warehouses/does-not-exist')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WAREHOUSE_NOT_FOUND');
  });

  test('PATCH /api/warehouses/:id: меняет name, code, isActive', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'old-name', code: 'OLD' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({ name: 'new-name', code: 'NEW', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: created.body.id,
      name: 'new-name',
      code: 'NEW',
      isActive: false,
    });
  });

  test('PATCH /api/warehouses/:id: code=null обнуляет код', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'wh-x', code: 'X' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({ code: null });
    expect(res.status).toBe(200);
    expect(res.body.code).toBeNull();
  });

  test('PATCH /api/warehouses/:id: пустой body — 400 VALIDATION_ERROR', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'wh-y' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // 2. Уникальность name/code
  // -------------------------------------------------------------------------

  test('POST /api/warehouses: одинаковое имя — 409 WAREHOUSE_NAME_TAKEN', async () => {
    await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Dup', code: 'A' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Dup', code: 'B' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WAREHOUSE_NAME_TAKEN');
  });

  test('POST /api/warehouses: одинаковый code — 409 WAREHOUSE_CODE_TAKEN', async () => {
    await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'A1', code: 'SAME' })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'A2', code: 'SAME' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WAREHOUSE_CODE_TAKEN');
  });

  // -------------------------------------------------------------------------
  // 3. Привязка ячеек
  // -------------------------------------------------------------------------

  test('PATCH /api/cells/:id: привязывает ячейку к складу', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);
    const cellId = seed.cells['A1'].id;

    const res = await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: wh.body.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: cellId,
      warehouse: { id: wh.body.id, name: 'Main' },
    });

    const detail = await request(t.app.getHttpServer())
      .get(`/api/warehouses/${wh.body.id}`)
      .set('Cookie', cookies.manager);
    expect(detail.body.cellsCount).toBe(1);
    expect(detail.body.cells.map((c: { id: string }) => c.id)).toContain(cellId);
    // printUrl должен быть готовым URL с /cells/:id/print.
    expect(detail.body.cells[0].printUrl).toMatch(/\/cells\/[^/]+\/print$/);
  });

  test('PATCH /api/cells/:id: warehouseId=null отвязывает ячейку', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Main' })
      .expect(201);
    const cellId = seed.cells['A1'].id;
    await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: wh.body.id })
      .expect(200);
    const res = await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: null });
    expect(res.status).toBe(200);
    expect(res.body.warehouse).toBeNull();
  });

  test('PATCH /api/cells/:id: перепривязка с одного склада на другой', async () => {
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
    const cellId = seed.cells['A1'].id;

    await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: wh1.body.id })
      .expect(200);
    const res = await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: wh2.body.id });
    expect(res.status).toBe(200);
    expect(res.body.warehouse.id).toBe(wh2.body.id);

    const wh1Detail = await request(t.app.getHttpServer())
      .get(`/api/warehouses/${wh1.body.id}`)
      .set('Cookie', cookies.manager);
    expect(wh1Detail.body.cells).toEqual([]);
  });

  test('PATCH /api/cells/:id: 404 на несуществующую ячейку', async () => {
    const res = await request(t.app.getHttpServer())
      .patch('/api/cells/never-existed')
      .set('Cookie', cookies.manager)
      .send({ warehouseId: null });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CELL_NOT_FOUND');
  });

  test('PATCH /api/cells/:id: 404 на несуществующий склад', async () => {
    const cellId = seed.cells['A1'].id;
    const res = await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: 'wh-missing' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WAREHOUSE_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // 4. Существующий flow Cell остаётся рабочим
  // -------------------------------------------------------------------------

  test('GET /api/cells: ячейки без склада продолжают возвращаться', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/cells')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const a1 = res.body.find((c: { code: string }) => c.code === 'A1');
    expect(a1).toBeDefined();
    expect(a1.warehouse).toBeNull();
  });

  test('POST /api/cells/by-code: резолвит ячейку без склада', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.cutter)
      .send({ code: 'A1' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('A1');
    expect(res.body.warehouse).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. QR / Print
  // -------------------------------------------------------------------------

  test('GET /api/cells/:id/print: публичный HTML 38×58 мм с QR и номером', async () => {
    const cellId = seed.cells['A1'].id;
    const res = await request(t.app.getHttpServer()).get(
      `/api/cells/${cellId}/print`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Минимальный template: только QR + номер ячейки.
    expect(res.text).toContain('>A1<');
    expect(res.text).toMatch(/<img[^>]+src="data:image\/png;base64,/);
    // Жёсткий формат термоэтикетки 38×58 (горизонтально) — фиксируем,
    // что @page правильный и шапка совпадает с реальной этикеткой.
    expect(res.text).toMatch(/@page\s*\{\s*size:\s*58mm\s+38mm/);
    expect(res.text).toContain('width: 58mm');
    expect(res.text).toContain('height: 38mm');
    // Print-safety страховка: чёрный QR не должен «оптимизироваться»
    // драйвером в серый, и контент не должен уезжать на 2-ю страницу.
    expect(res.text).toMatch(/print-color-adjust:\s*exact/);
    expect(res.text).toMatch(/-webkit-print-color-adjust:\s*exact/);
    expect(res.text).toMatch(/page-break-inside:\s*avoid/);
    expect(res.text).toMatch(/break-inside:\s*avoid/);
    expect(res.text).toMatch(/overflow:\s*hidden/);
    // Кнопка «Печать» доступна на screen, но обязана прятаться в @media print.
    expect(res.text).toMatch(/@media print[\s\S]*\.actions[\s\S]*display:\s*none/);
  });

  test('GET /api/cells/:id/print: НЕ содержит ни имени склада, ни internal id, ни cell:{id}', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Главный', code: 'MAIN' })
      .expect(201);
    const cellId = seed.cells['A1'].id;
    await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: wh.body.id })
      .expect(200);
    const res = await request(t.app.getHttpServer()).get(
      `/api/cells/${cellId}/print`,
    );
    expect(res.status).toBe(200);
    // Контракт нового шаблона (см. cell-print.ts): на этикетке только
    // QR + номер. Никаких упоминаний склада, qr-payload-строки или
    // подписи «cell:...» в видимом теле быть не должно.
    expect(res.text).not.toContain('Главный');
    expect(res.text).not.toContain('Склад');
    expect(res.text).not.toContain(`cell:${cellId}`);
    // Internal id ячейки тоже не должен светиться в видимом теле —
    // только escape-safe номер и сам QR (в data-URL).
    const visible = res.text.replace(/<[^>]+>/g, ' ');
    expect(visible).not.toContain(cellId);
  });

  test('GET /api/cells/:id/qr: PNG (signature 89 50 4E 47)', async () => {
    const cellId = seed.cells['A1'].id;
    const res = await request(t.app.getHttpServer()).get(
      `/api/cells/${cellId}/qr`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.slice(0, 4).toString('hex')).toBe('89504e47');
  });

  test('GET /api/cells/missing/print: 404', async () => {
    const res = await request(t.app.getHttpServer()).get(
      '/api/cells/never-existed/print',
    );
    expect(res.status).toBe(404);
  });

  test('GET /api/cells/:id/print: остаётся @Public — работает без сессии', async () => {
    const cellId = seed.cells['A1'].id;
    const res = await request(t.app.getHttpServer()).get(
      `/api/cells/${cellId}/print`,
    );
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  // -------------------------------------------------------------------------
  // 6. RBAC
  // -------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS — 403 на GET /api/warehouses', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/warehouses')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: QC, CUTTER, PACKING — 403 на POST /api/warehouses', async () => {
    for (const who of ['qc', 'cutter', 'packer'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/warehouses')
        .set('Cookie', cookies[who])
        .send({ name: `wh-${who}` });
      expect(res.status, `role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  test('RBAC: SEAMSTRESS — 403 на PATCH /api/cells/:id', async () => {
    const cellId = seed.cells['A1'].id;
    const res = await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.seamstress)
      .send({ warehouseId: null });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('RBAC: ADMIN и SHOP_MANAGER — могут CRUD', async () => {
    for (const who of ['admin', 'manager'] as const) {
      const list = await request(t.app.getHttpServer())
        .get('/api/warehouses')
        .set('Cookie', cookies[who]);
      expect(list.status, `role=${who}`).toBe(200);
      const created = await request(t.app.getHttpServer())
        .post('/api/warehouses')
        .set('Cookie', cookies[who])
        .send({ name: `wh-${who}` });
      expect(created.status, `role=${who}`).toBe(201);
    }
  });

  // -------------------------------------------------------------------------
  // 7. Удаление склада не убивает ячейки (ON DELETE SET NULL)
  // -------------------------------------------------------------------------

  test('Удаление склада на уровне БД — ячейки остаются, просто warehouseId=null', async () => {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: 'Temp' })
      .expect(201);
    const cellId = seed.cells['A1'].id;
    await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: wh.body.id })
      .expect(200);

    // API на удаление склада не предоставляет — это сознательное
    // ограничение MVP (см. ADR-0019). Удаляем через Prisma напрямую,
    // чтобы убедиться: даже физическое удаление склада не уничтожает
    // ячейку (FK ON DELETE SET NULL).
    await t.prisma.warehouse.delete({ where: { id: wh.body.id } });

    const cell = await t.prisma.cell.findUnique({ where: { id: cellId } });
    expect(cell).not.toBeNull();
    expect(cell?.warehouseId).toBeNull();
  });
});
