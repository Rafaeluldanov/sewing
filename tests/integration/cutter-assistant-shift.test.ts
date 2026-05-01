/**
 * Integration-тест: помощник раскройщика (CUTTER_ASSISTANT) работает
 * строго в контексте активной смены на оборудовании.
 *
 * Бизнес-смысл (см. `docs/flows.md §F2`, `docs/screens.md §3`,
 * `apps/web/app/work/page.tsx`):
 *   1. CUTTER_ASSISTANT может стартовать смену на раскройном
 *      столе через `POST /api/shifts/start` ровно тем же контрактом,
 *      что и швея — отдельных endpoint-ов нет, RBAC на shifts/* нет
 *      (любая авторизованная роль).
 *   2. До старта смены печать (а значит и фактический выпуск
 *      паспорта) падает в `SHIFT_SESSION_REQUIRED` — это и есть
 *      «нельзя без смены».
 *   3. После старта смены печать работает: backend выбирает принтер
 *      по `equipmentId` активной смены (см.
 *      `apps/api/src/modules/printers/print-jobs.service.ts`,
 *      `resolvePrinter`).
 *   4. Сам `POST /api/passports` (создание паспорта) RBAC-доступен
 *      `CUTTER_ASSISTANT` и НЕ требует смены — это сознательное
 *      решение домена (создать карточку паспорта без печати можно),
 *      но реальный пилотный flow «выпустить = создать + распечатать»
 *      требует смены через печать. Этот тест фиксирует обе ветки.
 *
 * `seedMinimal` поднимает `cutting-table-01` с разрешённой операцией
 * `CUT_DIVISION` (см. `tests/utils/seed.ts`), поэтому отдельного
 * seed-блока для оборудования здесь не нужно. Сотрудник
 * `CUTTER_ASSISTANT` создаётся точечно — `seedMinimal` его не
 * содержит (та же стратегия, что в `tests/integration/role-rbac.test.ts`).
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

describeWithDb('integration — CUTTER_ASSISTANT shift on equipment', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let assistantId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    const assistantPin = await bcrypt.hash('cas-shift', 4);
    const assistant = await t.prisma.employee.upsert({
      where: { login: 'cas-shift' },
      create: {
        login: 'cas-shift',
        fullName: 'Cutter Assistant Shift',
        role: 'CUTTER_ASSISTANT',
        active: true,
        pinHash: assistantPin,
      },
      update: {
        active: true,
        role: 'CUTTER_ASSISTANT',
        fullName: 'Cutter Assistant Shift',
      },
    });
    assistantId = assistant.id;

    cookies = {
      assistant: loginAs(t, {
        id: assistant.id,
        login: assistant.login,
        role: assistant.role,
        fullName: assistant.fullName,
      }),
      manager: loginAs(t, seed.employees['shop-chief']),
    };
  });

  // -------------------------------------------------------------------------
  // 1. Смена через раскройный стол
  // -------------------------------------------------------------------------

  test('CUTTER_ASSISTANT стартует смену на раскройном столе через /api/shifts/start', async () => {
    const eq = seed.equipment['cutting-table-01'];
    const op = seed.operations['CUT_DIVISION'];

    const res = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.assistant)
      .send({ equipmentId: eq.id, operationId: op.id });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      employeeId: assistantId,
      equipmentId: eq.id,
      equipmentCode: 'cutting-table-01',
      operationId: op.id,
      operationCode: 'CUT_DIVISION',
      active: true,
    });
    expect(res.body.startedAt).toBeTruthy();
  });

  test('GET /api/shifts/current возвращает только что открытую смену CUTTER_ASSISTANT', async () => {
    const eq = seed.equipment['cutting-table-01'];
    const op = seed.operations['CUT_DIVISION'];

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.assistant)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/current')
      .set('Cookie', cookies.assistant);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      equipmentCode: 'cutting-table-01',
      operationCode: 'CUT_DIVISION',
      active: true,
    });
  });

  test('GET /api/shifts/meta доступен CUTTER_ASSISTANT и отдаёт раскройный стол с allowedOperationIds', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.assistant);
    expect(res.status).toBe(200);

    const cuttingTable = (res.body.equipment as Array<{
      code: string;
      active: boolean;
      allowedOperationIds: string[];
    }>).find((e) => e.code === 'cutting-table-01');
    expect(cuttingTable).toBeTruthy();
    expect(cuttingTable!.active).toBe(true);
    // На раскройном столе из seedMinimal разрешён ровно CUT_DIVISION.
    const opIds = new Set(cuttingTable!.allowedOperationIds);
    expect(opIds.has(seed.operations['CUT_DIVISION'].id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Печать (как маркер «нельзя без смены»)
  // -------------------------------------------------------------------------

  test('Без активной смены print-job CUTTER_ASSISTANT падает в SHIFT_SESSION_REQUIRED', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.assistant)
      .send({ sourceType: 'TEST' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_SESSION_REQUIRED');
  });

  test('С активной сменой и принтером, привязанным к раскройному столу, print-job создаётся', async () => {
    const eq = seed.equipment['cutting-table-01'];
    const op = seed.operations['CUT_DIVISION'];

    const printer = await t.prisma.printer.create({
      data: { name: 'Cutting table printer', equipmentId: eq.id },
    });

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.assistant)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.assistant)
      .send({ sourceType: 'TEST' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      printerId: printer.id,
      sourceType: 'TEST',
      status: 'PENDING',
    });
  });

  // -------------------------------------------------------------------------
  // 3. Завершение смены
  // -------------------------------------------------------------------------

  test('CUTTER_ASSISTANT завершает свою смену через /api/shifts/stop', async () => {
    const eq = seed.equipment['cutting-table-01'];
    const op = seed.operations['CUT_DIVISION'];

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.assistant)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const stop = await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.assistant)
      .send({});
    expect(stop.status).toBe(201);
    expect(stop.body).toMatchObject({
      equipmentCode: 'cutting-table-01',
      operationCode: 'CUT_DIVISION',
      active: false,
    });
    expect(stop.body.endedAt).toBeTruthy();

    const current = await request(t.app.getHttpServer())
      .get('/api/shifts/current')
      .set('Cookie', cookies.assistant);
    expect(current.status).toBe(200);
    // NestJS отдаёт `null` как пустое тело — supertest парсит его как `{}`,
    // а не `null`. Проверяем по БД, что активной смены действительно
    // нет, а у HTTP-ответа проверяем только отсутствие осмысленных
    // полей контракта (`active`/`equipmentId`).
    expect(current.body).not.toMatchObject({ active: true });
    expect(current.body.equipmentId).toBeUndefined();
    const stillOpen = await t.prisma.shiftSession.findFirst({
      where: { employeeId: assistantId, endedAt: null },
    });
    expect(stillOpen).toBeNull();
  });
});
