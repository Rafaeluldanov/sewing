/**
 * Integration-тест нового endpoint `POST /api/cells/by-code`.
 *
 * Endpoint появился ради shelf-placement flow помощника раскройщика
 * (см. `docs/flows.md §F3b`, `docs/screens.md §3.8`). Backend = источник
 * истины: web-flow на /work перед confirm-модалкой ходит сюда, чтобы
 * убедиться, что ячейка существует и активна; только после успешного
 * ответа открывается режим скана паспортов в эту ячейку.
 *
 * Покрываем три формата кода (по [ADR-0008](../adr/0008-qr-format.md)),
 * negative-кейсы (404 для несуществующих, 409 для деактивированных) и
 * RBAC: endpoint должен быть доступен любому залогиненному сотруднику —
 * это read-only lookup, симметричный `/api/passports/by-code`.
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

describeWithDb('integration — cells by-code lookup', () => {
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
      seamstress: loginAs(t, seed.employees['seamstress']),
      cutter: loginAs(t, seed.employees['cutter']),
      manager: loginAs(t, seed.employees['shop-chief']),
    };
  });

  test('резолвит ячейку по QR `cell:{id}`', async () => {
    const cell = seed.cells.A1;
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.seamstress)
      .send({ code: cell.qrCode });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: cell.id,
      code: cell.code,
      qrCode: cell.qrCode,
      active: true,
    });
    expect(Array.isArray(res.body.contents)).toBe(true);
  });

  test('резолвит ячейку по человекочитаемому `code` (например `A1`)', async () => {
    const cell = seed.cells.A2;
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.cutter)
      .send({ code: 'A2' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(cell.id);
    expect(res.body.code).toBe('A2');
  });

  test('резолвит ячейку по голому `id`', async () => {
    const cell = seed.cells.A1;
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.manager)
      .send({ code: cell.id });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(cell.id);
  });

  test('404 CELL_NOT_FOUND для несуществующего кода', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.seamstress)
      .send({ code: 'cell:does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CELL_NOT_FOUND');
  });

  test('409 CELL_INACTIVE для деактивированной ячейки', async () => {
    const cell = seed.cells.A1;
    await t.prisma.cell.update({
      where: { id: cell.id },
      data: { active: false },
    });
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.seamstress)
      .send({ code: cell.qrCode });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CELL_INACTIVE');
  });

  test('400 VALIDATION_ERROR при пустом коде', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .set('Cookie', cookies.seamstress)
      .send({ code: '   ' });
    expect(res.status).toBe(400);
  });

  test('требует валидную сессию (без cookie — 401)', async () => {
    const cell = seed.cells.A1;
    const res = await request(t.app.getHttpServer())
      .post('/api/cells/by-code')
      .send({ code: cell.qrCode });
    expect(res.status).toBe(401);
  });
});
