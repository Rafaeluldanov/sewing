/**
 * Integration-тест массовой печати «Печать всех ячеек» из карточки
 * склада (см. `docs/api.md §15`, `docs/screens.md §10b`).
 *
 * Сценарии:
 *   1. POST /api/warehouses/:id/print-cells создаёт `cellsCount × copies`
 *      PENDING-job-ов для всех АКТИВНЫХ ячеек склада с
 *      sourceType=CELL_LABEL и payloadUrl, указывающим на
 *      `/api/cells/:id/print`.
 *   2. Деактивированные ячейки в очередь не попадают.
 *   3. Пустой склад → 409 WAREHOUSE_NO_CELLS_TO_PRINT.
 *   4. Несуществующий склад → 404 WAREHOUSE_NOT_FOUND.
 *   5. Несуществующий принтер → 404 PRINTER_NOT_FOUND.
 *   6. Деактивированный принтер → 409 PRINTER_INACTIVE.
 *   7. Single-cell печать (`GET /api/cells/:id/print`) продолжает
 *      работать после изменений.
 *   8. RBAC: SEAMSTRESS/QC/CUTTER — 403 на bulk endpoint.
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

describeWithDb('integration — warehouses bulk print cells (§15)', () => {
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
    // поэтому пересоздаём его перед каждым тестом — иначе RBAC-кейс
    // «ADMIN может всё» падает с 401 (см. warehouses.test.ts).
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
    };
  });

  /** Создаёт склад, привязывает к нему ячейки `codes`, возвращает id. */
  async function makeWarehouseWithCells(codes: string[]): Promise<string> {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: `WH-${codes.join('-')}` })
      .expect(201);
    for (const code of codes) {
      const cell = seed.cells[code];
      if (!cell) throw new Error(`Seed cell ${code} not found`);
      await request(t.app.getHttpServer())
        .patch(`/api/cells/${cell.id}`)
        .set('Cookie', cookies.manager)
        .send({ warehouseId: wh.body.id })
        .expect(200);
    }
    return wh.body.id;
  }

  async function makePrinter(name = 'Test printer'): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/printers')
      .set('Cookie', cookies.manager)
      .send({ name, type: 'LABEL' })
      .expect(201);
    return res.body.id;
  }

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  test('POST /api/warehouses/:id/print-cells: создаёт CELL_LABEL job-ы для каждой активной ячейки', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 3);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter('LBL-01');

    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId, copies: 1 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      warehouseId: whId,
      printerId,
      cellsCount: cellCodes.length,
      copies: 1,
      jobsCreated: cellCodes.length,
      labelSize: '38x58',
    });

    const jobs = await t.prisma.printJob.findMany({
      where: { printerId },
      orderBy: { createdAt: 'asc' },
    });
    expect(jobs).toHaveLength(cellCodes.length);
    for (const job of jobs) {
      expect(job.sourceType).toBe('CELL_LABEL');
      expect(job.status).toBe('PENDING');
      expect(job.payloadUrl).toMatch(/\/cells\/[^/]+\/print$/);
      expect(job.sourceId).toBeTruthy();
    }
    // sourceId-ы покрывают ровно те ячейки, что мы привязали.
    const expectedIds = new Set(
      cellCodes.map((c) => seed.cells[c]!.id),
    );
    const actualIds = new Set(jobs.map((j) => j.sourceId));
    expect(actualIds).toEqual(expectedIds);
  });

  test('copies>1: создаёт cellsCount × copies заданий', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 2);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter('LBL-COPIES');

    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId, copies: 3 });

    expect(res.status).toBe(201);
    expect(res.body.cellsCount).toBe(2);
    expect(res.body.copies).toBe(3);
    expect(res.body.jobsCreated).toBe(2 * 3);

    const count = await t.prisma.printJob.count({ where: { printerId } });
    expect(count).toBe(6);
  });

  test('copies опущен → дефолт 1', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter('LBL-DEFAULT');

    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId });

    expect(res.status).toBe(201);
    expect(res.body.copies).toBe(1);
    expect(res.body.jobsCreated).toBe(1);
  });

  test('labelSize по умолчанию = 38x58', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter();
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId });
    expect(res.body.labelSize).toBe('38x58');
  });

  // -------------------------------------------------------------------------
  // 2. Деактивированные ячейки игнорируются
  // -------------------------------------------------------------------------

  test('Деактивированные ячейки в печать не попадают', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 3);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter('LBL-INACTIVE');

    // Деактивируем одну из ячеек напрямую — публичного API нет.
    const inactiveCell = seed.cells[cellCodes[0]!]!;
    await t.prisma.cell.update({
      where: { id: inactiveCell.id },
      data: { active: false },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId, copies: 1 });

    expect(res.status).toBe(201);
    expect(res.body.cellsCount).toBe(cellCodes.length - 1);
    expect(res.body.jobsCreated).toBe(cellCodes.length - 1);

    const jobs = await t.prisma.printJob.findMany({ where: { printerId } });
    const ids = jobs.map((j) => j.sourceId);
    expect(ids).not.toContain(inactiveCell.id);
  });

  // -------------------------------------------------------------------------
  // 3. Пустой склад
  // -------------------------------------------------------------------------

  test('Склад без ячеек → 409 WAREHOUSE_NO_CELLS_TO_PRINT', async () => {
    const whId = await makeWarehouseWithCells([]);
    const printerId = await makePrinter();
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WAREHOUSE_NO_CELLS_TO_PRINT');
  });

  // -------------------------------------------------------------------------
  // 4. Ошибки валидации / not-found / inactive
  // -------------------------------------------------------------------------

  test('Несуществующий склад → 404 WAREHOUSE_NOT_FOUND', async () => {
    const printerId = await makePrinter();
    const res = await request(t.app.getHttpServer())
      .post('/api/warehouses/never-existed/print-cells')
      .set('Cookie', cookies.manager)
      .send({ printerId });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WAREHOUSE_NOT_FOUND');
  });

  test('Несуществующий принтер → 404 PRINTER_NOT_FOUND', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId: 'never-existed' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PRINTER_NOT_FOUND');
  });

  test('Деактивированный принтер → 409 PRINTER_INACTIVE', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter('LBL-DEACTIVATED');
    await t.prisma.printer.update({
      where: { id: printerId },
      data: { isActive: false },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRINTER_INACTIVE');
  });

  test('Без printerId — 400 VALIDATION_ERROR', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('copies > MAX → 400 VALIDATION_ERROR', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter();
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.manager)
      .send({ printerId, copies: 9999 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // 5. Не ломаем существующий single-cell flow
  // -------------------------------------------------------------------------

  test('GET /api/cells/:id/print продолжает работать (HTML 38×58)', async () => {
    const cellCode = Object.keys(seed.cells)[0]!;
    const cellId = seed.cells[cellCode]!.id;
    const res = await request(t.app.getHttpServer()).get(
      `/api/cells/${cellId}/print`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/@page\s*\{\s*size:\s*58mm\s+38mm/);
    expect(res.text).toContain(cellCode);
    // Контракт нового шаблона: только QR + номер.
    expect(res.text).not.toContain(`cell:${cellId}`);
    expect(res.text).not.toContain('Склад');
  });

  // -------------------------------------------------------------------------
  // 6. RBAC
  // -------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS / QC / CUTTER — 403 на bulk print', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter();
    for (const who of ['seamstress', 'qc', 'cutter'] as const) {
      const res = await request(t.app.getHttpServer())
        .post(`/api/warehouses/${whId}/print-cells`)
        .set('Cookie', cookies[who])
        .send({ printerId });
      expect(res.status, `role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  test('RBAC: ADMIN — может массово печатать', async () => {
    const cellCodes = Object.keys(seed.cells).slice(0, 1);
    const whId = await makeWarehouseWithCells(cellCodes);
    const printerId = await makePrinter();
    const res = await request(t.app.getHttpServer())
      .post(`/api/warehouses/${whId}/print-cells`)
      .set('Cookie', cookies.admin)
      .send({ printerId });
    expect(res.status).toBe(201);
    expect(res.body.jobsCreated).toBe(1);
  });
});
