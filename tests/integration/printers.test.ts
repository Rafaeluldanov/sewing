/**
 * Integration-тест модуля «Принтеры и печать через агент» (MVP).
 *
 * Сценарии (см. ТЗ §11):
 *   1. Менеджер создаёт принтер и привязывает к рабочему месту.
 *   2. Менеджер генерирует pairingCode.
 *   3. Агент пары через `POST /printers/agent/pair` → получает
 *      `printerId + agentToken`. Heartbeat обновляет `isOnline`.
 *   4. Сотрудник на активной смене жмёт «Печать» → backend выбирает
 *      принтер по `equipmentId` смены и создаёт PrintJob.
 *   5. Без активной смены — `SHIFT_SESSION_REQUIRED`.
 *   6. С активной сменой, но без принтера на equipment —
 *      `PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT`.
 *   7. Агент пуллит job через `GET /print-jobs/agent`, видит созданный
 *      PENDING job, отмечает PRINTED через `PATCH /print-jobs/:id`.
 *   8. RBAC: SEAMSTRESS не может управлять принтерами; SHOP_MANAGER —
 *      может; агент без токена — 401.
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

describeWithDb('integration — printers + print jobs (MVP §17)', () => {
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
      admin: t.adminCookie,
    };
  });

  // -------------------------------------------------------------------------
  // 1. CRUD-принтер + RBAC
  // -------------------------------------------------------------------------

  test('SHOP_MANAGER создаёт принтер с привязкой к equipment', async () => {
    const eq = seed.equipment['overlock-01'];
    const res = await request(t.app.getHttpServer())
      .post('/api/printers')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Оверлок-1 принтер',
        type: 'PASSPORT',
        equipmentId: eq.id,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Оверлок-1 принтер',
      type: 'PASSPORT',
      equipmentId: eq.id,
      isActive: true,
      isOnline: false,
      pairingCode: null,
    });
    expect(typeof res.body.id).toBe('string');
  });

  test('GET /api/printers возвращает summary с привязкой', async () => {
    const eq = seed.equipment['overlock-01'];
    await t.prisma.printer.create({
      data: { name: 'P1', equipmentId: eq.id },
    });
    const res = await request(t.app.getHttpServer())
      .get('/api/printers')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: 'P1',
      equipmentId: eq.id,
      equipmentCode: 'overlock-01',
      isOnline: false,
      hasPairingCode: false,
      pendingJobsCount: 0,
    });
  });

  test('RBAC: SEAMSTRESS не может управлять принтерами', async () => {
    const create = await request(t.app.getHttpServer())
      .post('/api/printers')
      .set('Cookie', cookies.seamstress)
      .send({ name: 'P', type: 'DEFAULT' });
    expect(create.status).toBe(403);

    const list = await request(t.app.getHttpServer())
      .get('/api/printers')
      .set('Cookie', cookies.seamstress);
    expect(list.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 2. PairingCode + agent pair
  // -------------------------------------------------------------------------

  test('SHOP_MANAGER генерирует pairingCode, агент по нему получает токен', async () => {
    const eq = seed.equipment['overlock-01'];
    const created = await request(t.app.getHttpServer())
      .post('/api/printers')
      .set('Cookie', cookies.manager)
      .send({ name: 'P', equipmentId: eq.id })
      .expect(201);

    const pair = await request(t.app.getHttpServer())
      .post(`/api/printers/${created.body.id}/pairing-code`)
      .set('Cookie', cookies.manager)
      .expect(201);
    expect(pair.body.pairingCode).toMatch(/^[A-Z0-9-]{4,}$/);

    const res = await request(t.app.getHttpServer())
      .post('/api/printers/agent/pair')
      .send({ pairingCode: pair.body.pairingCode });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      printerId: created.body.id,
      printerName: 'P',
    });
    expect(typeof res.body.agentToken).toBe('string');
    expect(res.body.agentToken.length).toBeGreaterThan(16);

    // После pair-а pairingCode на принтере очищается.
    const refreshed = await request(t.app.getHttpServer())
      .get(`/api/printers/${created.body.id}`)
      .set('Cookie', cookies.manager);
    expect(refreshed.body.pairingCode).toBeNull();
  });

  test('agent/pair с неверным кодом → 4xx PRINTER_PAIRING_CODE_INVALID', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/printers/agent/pair')
      .send({ pairingCode: 'NOPE-NOPE' });
    expect([401, 409]).toContain(res.status);
    expect(res.body.code).toBe('PRINTER_PAIRING_CODE_INVALID');
  });

  test('агент без токена не может пуллить job-ы', async () => {
    const res = await request(t.app.getHttpServer()).get(
      '/api/print-jobs/agent',
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 3. Print job: select printer by equipment of active shift
  // -------------------------------------------------------------------------

  test('создание job: выбирает принтер по equipment активной смены', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations['SEW_OVERLOCK_2'];
    const printer = await t.prisma.printer.create({
      data: { name: 'Overlock printer', equipmentId: eq.id },
    });

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.seamstress)
      .send({ sourceType: 'TEST' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      printerId: printer.id,
      sourceType: 'TEST',
      status: 'PENDING',
    });
    expect(res.body.payloadUrl).toMatch(/^https?:\/\/.+\/api\//);
  });

  test('создание job без активной смены → 409 SHIFT_SESSION_REQUIRED', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.seamstress)
      .send({ sourceType: 'TEST' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_SESSION_REQUIRED');
  });

  test('создание job без принтера на equipment → 409 PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations['SEW_OVERLOCK_2'];
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.seamstress)
      .send({ sourceType: 'TEST' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT');
  });

  // -------------------------------------------------------------------------
  // 4. Agent end-to-end: poll → patch
  // -------------------------------------------------------------------------

  test('агент видит PENDING job, помечает PRINTED', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations['SEW_OVERLOCK_2'];
    const printer = await t.prisma.printer.create({
      data: {
        name: 'Overlock printer',
        equipmentId: eq.id,
        agentToken: 'token-test-123',
      },
    });

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);

    const created = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.seamstress)
      .send({ sourceType: 'TEST' })
      .expect(201);

    const poll = await request(t.app.getHttpServer())
      .get('/api/print-jobs/agent')
      .set('x-printer-agent-token', 'token-test-123');
    expect(poll.status).toBe(200);
    expect(Array.isArray(poll.body)).toBe(true);
    expect(poll.body.length).toBeGreaterThanOrEqual(1);
    expect(poll.body[0]).toMatchObject({
      id: created.body.id,
      status: 'PENDING',
    });

    const patched = await request(t.app.getHttpServer())
      .patch(`/api/print-jobs/${created.body.id}`)
      .set('x-printer-agent-token', 'token-test-123')
      .send({ status: 'PRINTED' });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('PRINTED');
    expect(patched.body.completedAt).not.toBeNull();

    // Принтер должен стать online после polling-а.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/printers/${printer.id}`)
      .set('Cookie', cookies.manager);
    expect(detail.body.isOnline).toBe(true);
    expect(detail.body.lastSeenAt).not.toBeNull();
  });

  test('агент c FAILED-статусом обязан указать errorMessage', async () => {
    const printer = await t.prisma.printer.create({
      data: { name: 'P', agentToken: 'tok-fail' },
    });
    const job = await t.prisma.printJob.create({
      data: {
        printerId: printer.id,
        sourceType: 'TEST',
        payloadUrl: 'http://example/api/passports/xxx/print',
      },
    });
    const noMsg = await request(t.app.getHttpServer())
      .patch(`/api/print-jobs/${job.id}`)
      .set('x-printer-agent-token', 'tok-fail')
      .send({ status: 'FAILED' });
    expect(noMsg.status).toBe(400);

    const ok = await request(t.app.getHttpServer())
      .patch(`/api/print-jobs/${job.id}`)
      .set('x-printer-agent-token', 'tok-fail')
      .send({ status: 'FAILED', errorMessage: 'no paper' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('FAILED');
    expect(ok.body.errorMessage).toBe('no paper');
  });

  test('агент не видит job чужого принтера', async () => {
    const printerA = await t.prisma.printer.create({
      data: { name: 'A', agentToken: 'tok-a' },
    });
    const printerB = await t.prisma.printer.create({
      data: { name: 'B', agentToken: 'tok-b' },
    });
    await t.prisma.printJob.create({
      data: {
        printerId: printerA.id,
        sourceType: 'TEST',
        payloadUrl: 'http://example/api/x',
      },
    });

    const pollB = await request(t.app.getHttpServer())
      .get('/api/print-jobs/agent')
      .set('x-printer-agent-token', 'tok-b');
    expect(pollB.status).toBe(200);
    expect(pollB.body).toEqual([]);

    // Сила: используем printerB чтобы не пометить TS как unused.
    expect(printerB.id).not.toBe(printerA.id);
  });

  // -------------------------------------------------------------------------
  // 5. Test-print через explicit printerId — только менеджер
  // -------------------------------------------------------------------------

  test('explicit printerId: SEAMSTRESS — 403, SHOP_MANAGER — 201', async () => {
    const printer = await t.prisma.printer.create({
      data: { name: 'P' },
    });

    const seam = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.seamstress)
      .send({ sourceType: 'TEST', printerId: printer.id });
    expect(seam.status).toBe(403);

    const mgr = await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.manager)
      .send({ sourceType: 'TEST', printerId: printer.id });
    expect(mgr.status).toBe(201);
    expect(mgr.body.printerId).toBe(printer.id);
  });

  // -------------------------------------------------------------------------
  // 6. Heartbeat обновляет isOnline
  // -------------------------------------------------------------------------

  test('heartbeat: обновляет lastSeenAt и isOnline', async () => {
    const printer = await t.prisma.printer.create({
      data: { name: 'P', agentToken: 'tok-hb' },
    });
    expect(printer.isOnline).toBe(false);

    const res = await request(t.app.getHttpServer())
      .post('/api/printers/agent/heartbeat')
      .set('x-printer-agent-token', 'tok-hb');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, selectedWindowsPrinter: null });

    const after = await t.prisma.printer.findUnique({
      where: { id: printer.id },
    });
    expect(after?.isOnline).toBe(true);
    expect(after?.lastSeenAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 7. Windows-printers upload + selectedWindowsPrinter (см. §17b)
  // -------------------------------------------------------------------------

  test('агент шлёт hostName + список Windows-принтеров → сохраняется на принтере', async () => {
    const printer = await t.prisma.printer.create({
      data: { name: 'P', agentToken: 'tok-wp' },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/printers/agent/windows-printers')
      .set('x-printer-agent-token', 'tok-wp')
      .send({
        hostName: 'QC-PC-01',
        printers: ['HP LaserJet', 'Zebra ZD220', 'Microsoft Print to PDF'],
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      printerId: printer.id,
      agentHostName: 'QC-PC-01',
      availableWindowsPrinters: [
        'HP LaserJet',
        'Zebra ZD220',
        'Microsoft Print to PDF',
      ],
      selectedWindowsPrinter: null,
    });

    const after = await t.prisma.printer.findUnique({
      where: { id: printer.id },
    });
    expect(after?.agentHostName).toBe('QC-PC-01');
    expect(after?.availableWindowsPrinters).toEqual([
      'HP LaserJet',
      'Zebra ZD220',
      'Microsoft Print to PDF',
    ]);
    expect(after?.windowsPrintersUpdatedAt).not.toBeNull();
    // upload параллельно работает как heartbeat.
    expect(after?.isOnline).toBe(true);
    expect(after?.lastSeenAt).not.toBeNull();
  });

  test('agent/windows-printers без токена → 401', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/printers/agent/windows-printers')
      .send({ hostName: 'PC', printers: [] });
    expect(res.status).toBe(401);
  });

  test('повторный upload перезаписывает список целиком + дедупит', async () => {
    const printer = await t.prisma.printer.create({
      data: {
        name: 'P',
        agentToken: 'tok-wp2',
        availableWindowsPrinters: ['Old A', 'Old B'],
        agentHostName: 'OLD-HOST',
      },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/printers/agent/windows-printers')
      .set('x-printer-agent-token', 'tok-wp2')
      .send({
        hostName: 'NEW-HOST',
        printers: ['New A', 'New B', 'New A'],
      });
    expect(res.status).toBe(201);

    const after = await t.prisma.printer.findUnique({
      where: { id: printer.id },
    });
    expect(after?.agentHostName).toBe('NEW-HOST');
    expect(after?.availableWindowsPrinters).toEqual(['New A', 'New B']);
  });

  test('upload не сбрасывает selectedWindowsPrinter, выбранный менеджером', async () => {
    const printer = await t.prisma.printer.create({
      data: {
        name: 'P',
        agentToken: 'tok-wp3',
        availableWindowsPrinters: ['HP', 'Zebra'],
        selectedWindowsPrinter: 'HP',
      },
    });

    await request(t.app.getHttpServer())
      .post('/api/printers/agent/windows-printers')
      .set('x-printer-agent-token', 'tok-wp3')
      .send({ hostName: 'PC', printers: ['HP', 'Zebra', 'New'] })
      .expect(201);

    const after = await t.prisma.printer.findUnique({
      where: { id: printer.id },
    });
    expect(after?.selectedWindowsPrinter).toBe('HP');
  });

  test('PATCH printer { selectedWindowsPrinter } валидирует список', async () => {
    const printer = await t.prisma.printer.create({
      data: {
        name: 'P',
        availableWindowsPrinters: ['HP LaserJet', 'Zebra'],
      },
    });

    // успех — имя есть в списке.
    const ok = await request(t.app.getHttpServer())
      .patch(`/api/printers/${printer.id}`)
      .set('Cookie', cookies.manager)
      .send({ selectedWindowsPrinter: 'Zebra' });
    expect(ok.status).toBe(200);
    expect(ok.body.selectedWindowsPrinter).toBe('Zebra');

    // ошибка — имя не присылал агент.
    const bad = await request(t.app.getHttpServer())
      .patch(`/api/printers/${printer.id}`)
      .set('Cookie', cookies.manager)
      .send({ selectedWindowsPrinter: 'Random' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT');

    // null — снять выбор без проверок.
    const cleared = await request(t.app.getHttpServer())
      .patch(`/api/printers/${printer.id}`)
      .set('Cookie', cookies.manager)
      .send({ selectedWindowsPrinter: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.selectedWindowsPrinter).toBeNull();
  });

  test('GET /api/printers/:id отдаёт agentHostName и списки', async () => {
    const printer = await t.prisma.printer.create({
      data: {
        name: 'P',
        agentHostName: 'QC-PC-01',
        availableWindowsPrinters: ['HP', 'Zebra'],
        selectedWindowsPrinter: 'HP',
      },
    });

    const res = await request(t.app.getHttpServer())
      .get(`/api/printers/${printer.id}`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agentHostName: 'QC-PC-01',
      availableWindowsPrinters: ['HP', 'Zebra'],
      selectedWindowsPrinter: 'HP',
    });
  });

  test('offline принтер всё равно показывает последний известный список', async () => {
    // Принтер ни разу не онлайн (isOnline=false, lastSeenAt=null), но
    // в БД есть прошлые availableWindowsPrinters — UI должен их видеть.
    const printer = await t.prisma.printer.create({
      data: {
        name: 'P',
        agentHostName: 'OLD-PC',
        availableWindowsPrinters: ['HP', 'Zebra'],
      },
    });
    const res = await request(t.app.getHttpServer())
      .get(`/api/printers/${printer.id}`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.isOnline).toBe(false);
    expect(res.body.availableWindowsPrinters).toEqual(['HP', 'Zebra']);
    expect(res.body.agentHostName).toBe('OLD-PC');
  });

  test('GET /print-jobs/agent: PrintJobDto содержит selectedWindowsPrinter', async () => {
    const eq = seed.equipment['overlock-01'];
    const op = seed.operations['SEW_OVERLOCK_2'];
    const printer = await t.prisma.printer.create({
      data: {
        name: 'P',
        equipmentId: eq.id,
        agentToken: 'tok-job-sel',
        availableWindowsPrinters: ['Zebra ZD220'],
        selectedWindowsPrinter: 'Zebra ZD220',
      },
    });

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/print-jobs')
      .set('Cookie', cookies.seamstress)
      .send({ sourceType: 'TEST' })
      .expect(201);

    const poll = await request(t.app.getHttpServer())
      .get('/api/print-jobs/agent')
      .set('x-printer-agent-token', 'tok-job-sel');
    expect(poll.status).toBe(200);
    expect(poll.body[0]).toMatchObject({
      printerId: printer.id,
      selectedWindowsPrinter: 'Zebra ZD220',
    });

    // Heartbeat также возвращает текущий выбор.
    const hb = await request(t.app.getHttpServer())
      .post('/api/printers/agent/heartbeat')
      .set('x-printer-agent-token', 'tok-job-sel');
    expect(hb.status).toBe(201);
    expect(hb.body.selectedWindowsPrinter).toBe('Zebra ZD220');
  });
});
