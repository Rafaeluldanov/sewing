/**
 * Integration-тест фичи «Корректировка фактического количества по
 * паспорту» (ОТК → мастер цеха).
 *
 * HTTP-уровень (supertest): бьём в те же роуты, что фронт `/qc` и
 * `/master`. Это заодно прогоняет RBAC, tenant-middleware и
 * GlobalExceptionFilter. Данные готовим/читаем прямым тестовым клиентом
 * `t.prisma` (он в обход tenant-context; приложение и тесты делят одну БД
 * — см. `tests/utils/app.ts`).
 *
 * Покрываем:
 *   - create заявки (PENDING, снимок qtyBefore);
 *   - одна открытая заявка на паспорт (второй POST → 409);
 *   - approve «вниз» (10→9): двигаются qtyCut+qtyGood, пересчёт сдельной
 *     ЗП швеи (qty/amount) И раскройщика (qty по qtyCut), событие
 *     `QTY_CORRECTED`, штамп reviewedBy;
 *   - approve «вверх» (10→12): reconcile поднимает ЗП швеи обратно;
 *   - гард «только IN_PROGRESS» (PACKED → 409);
 *   - reject не меняет количеств;
 *   - RBAC: подтвердить может только мастер/менеджер (роль QC → 403);
 *   - одношаговая корректировка мастера
 *     (`POST /api/master-actions/passports/:id/qty-correction`):
 *     создаётся сразу APPROVED и применяется в одной транзакции; при
 *     висящей PENDING-заявке ОТК → 409; роль QC → 403.
 *
 * Сознательно НЕ покрываем «уже выплаченную строку ЗП пропускаем»
 * (`salarySkipped`) — требует scaffolding `PayrollPayout`; логика skip'а
 * покрыта на уровне earnings.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { EarningsService } from '@sewing/api/modules/earnings/earnings.service';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — passport qty corrections (ОТК → мастер)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let earnings: EarningsService;
  let qcCookie: string;
  let masterCookie: string;

  beforeAll(async () => {
    t = await startTestApp();
    earnings = t.app.get(EarningsService);
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    delete process.env.CUTTER_B2B_SEWING_PERCENT;
    qcCookie = loginAs(t, {
      id: seed.employees.qc.id,
      role: 'QC',
      login: seed.employees.qc.login,
      fullName: seed.employees.qc.fullName,
    });
    masterCookie = loginAs(t, {
      id: seed.employees.master.id,
      role: 'SHOPFLOOR_MASTER',
      login: seed.employees.master.login,
      fullName: seed.employees.master.fullName,
    });
  });

  const http = () => request(t.app.getHttpServer());

  /**
   * Заказ IN_PRODUCTION (MARKETPLACE — простая фикс-схема раскройщика) +
   * паспорт IN_PROGRESS с двумя начислениями: раскройщик
   * (PASSPORT_CREATED, qty=qtyCut) и швея (OPERATION_TRANSITION,
   * qty=qtyCut, ставка BY_SIZE=10 для M).
   */
  async function setup(qtyCut: number): Promise<{ passportId: string }> {
    const sizeId = seed.sizes.M;
    const order = await t.prisma.order.create({
      data: {
        number: `O-QC-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: {
          create: { productId: seed.product.id, sizeId, qtyPlan: qtyCut },
        },
        routeSteps: {
          create: [{ index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id }],
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-QC-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:qc-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId,
        color: seed.product.color,
        rollNumber: 'R-QC',
        cutDate: new Date(),
        status: 'IN_PROGRESS',
        qtyPlan: qtyCut,
        qtyCut,
        qtyGood: qtyCut,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    await t.prisma.$transaction(async (tx) => {
      await earnings.createImmediateForCutter(tx, {
        passportId: passport.id,
        cutterId: seed.employees.cutter.id,
        sizeId,
        productId: seed.product.id,
        qty: qtyCut,
      });
      await earnings.createPendingForCompletedOperation(tx, {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        productId: seed.product.id,
        sizeId,
        qty: qtyCut,
        sourceEventId: null,
      });
    });
    return { passportId: passport.id };
  }

  function createCorrection(
    passportId: string,
    body: { qtyAfter: number; reason?: string },
    cookie = qcCookie,
  ) {
    return http()
      .post(`/api/qc/passports/${passportId}/qty-corrections`)
      .set('Cookie', cookie)
      .send(body);
  }

  function seamstressEntry(passportId: string) {
    return t.prisma.operationEntry.findFirstOrThrow({
      where: { passportId, sourceEventType: 'OPERATION_TRANSITION' },
    });
  }
  function cutterEntry(passportId: string) {
    return t.prisma.operationEntry.findFirstOrThrow({
      where: { passportId, sourceEventType: 'PASSPORT_CREATED' },
    });
  }

  // ---------------------------------------------------------------------------

  test('create: PENDING-заявка со снимком qtyBefore и delta', async () => {
    const { passportId } = await setup(10);
    const res = await createCorrection(passportId, {
      qtyAfter: 9,
      reason: 'испорчена, пятно',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.qtyBefore).toBe(10);
    expect(res.body.qtyAfter).toBe(9);
    expect(res.body.delta).toBe(-1);
    expect(res.body.requestedByEmployeeId).toBe(seed.employees.qc.id);

    // Появилась в очереди мастера.
    const queue = await http()
      .get('/api/master-qty-corrections')
      .set('Cookie', masterCookie);
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].id).toBe(res.body.id);
  });

  test('create дважды по одному паспорту → 409 ALREADY_PENDING', async () => {
    const { passportId } = await setup(10);
    await createCorrection(passportId, { qtyAfter: 9 });
    const dup = await createCorrection(passportId, { qtyAfter: 8 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('QTY_CORRECTION_ALREADY_PENDING');
  });

  test('approve «вниз» 10→9: двигает qtyCut+qtyGood, пересчёт ЗП швеи и раскройщика, событие', async () => {
    const { passportId } = await setup(10);
    const created = await createCorrection(passportId, {
      qtyAfter: 9,
      reason: 'недосчёт',
    });
    const id = created.body.id as string;

    const res = await http()
      .post(`/api/master-qty-corrections/${id}/approve`)
      .set('Cookie', masterCookie)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.qtyCut).toBe(9);
    expect(res.body.qtyGood).toBe(9);
    expect(res.body.salaryAdjusted).toBeGreaterThanOrEqual(2);

    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.qtyCut).toBe(9);
    expect(passport.qtyGood).toBe(9);
    expect(passport.qtyDefect).toBe(0);

    const sew = await seamstressEntry(passportId);
    expect(sew.qty).toBe(9);
    expect(Number(sew.amount)).toBe(90);

    const cut = await cutterEntry(passportId);
    expect(cut.qty).toBe(9);

    const ev = await t.prisma.passportEvent.findFirstOrThrow({
      where: { passportId, type: 'QTY_CORRECTED' },
    });
    expect(ev.qty).toBe(9);
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.qtyBefore).toBe(10);
    expect(payload.qtyAfter).toBe(9);
    expect(payload.delta).toBe(-1);

    const row = await t.prisma.passportQtyCorrection.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe('APPROVED');
    expect(row.reviewedByEmployeeId).toBe(seed.employees.master.id);
    expect(row.reviewedAt).not.toBeNull();
  });

  test('approve «вверх» 10→12: reconcile поднимает ЗП швеи обратно', async () => {
    const { passportId } = await setup(10);
    const created = await createCorrection(passportId, { qtyAfter: 12 });
    const id = created.body.id as string;

    const res = await http()
      .post(`/api/master-qty-corrections/${id}/approve`)
      .set('Cookie', masterCookie)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.qtyCut).toBe(12);
    expect(res.body.qtyGood).toBe(12);

    const sew = await seamstressEntry(passportId);
    expect(sew.qty).toBe(12);
    expect(Number(sew.amount)).toBe(120);
    const cut = await cutterEntry(passportId);
    expect(cut.qty).toBe(12);
  });

  test('create на не-IN_PROGRESS паспорте (PACKED) → 409 NOT_EDITABLE', async () => {
    const { passportId } = await setup(10);
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED' },
    });
    const res = await createCorrection(passportId, { qtyAfter: 9 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QTY_CORRECTION_PASSPORT_NOT_EDITABLE');
  });

  test('reject: количество не меняется, заявка REJECTED', async () => {
    const { passportId } = await setup(10);
    const created = await createCorrection(passportId, { qtyAfter: 9 });
    const id = created.body.id as string;

    const res = await http()
      .post(`/api/master-qty-corrections/${id}/reject`)
      .set('Cookie', masterCookie)
      .send({ note: 'посчитали заново — 10' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('REJECTED');

    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.qtyCut).toBe(10);
    expect(passport.qtyGood).toBe(10);
    const sew = await seamstressEntry(passportId);
    expect(sew.qty).toBe(10);
  });

  test('RBAC: подтвердить корректировку роль QC не может (403)', async () => {
    const { passportId } = await setup(10);
    const created = await createCorrection(passportId, { qtyAfter: 9 });
    const id = created.body.id as string;

    const res = await http()
      .post(`/api/master-qty-corrections/${id}/approve`)
      .set('Cookie', qcCookie)
      .send({});
    expect(res.status).toBe(403);
  });

  test('мастер применяет корректировку одним запросом: сразу APPROVED, количества и ЗП сдвинуты', async () => {
    const { passportId } = await setup(10);

    const res = await http()
      .post(`/api/master-actions/passports/${passportId}/qty-correction`)
      .set('Cookie', masterCookie)
      .send({ qtyAfter: 8, reason: 'пересчитали партию' });
    expect(res.status).toBe(201);
    expect(res.body.qtyCut).toBe(8);
    expect(res.body.qtyGood).toBe(8);
    expect(res.body.correction.status).toBe('APPROVED');
    // Мастер сам и податель, и аппрувер.
    expect(res.body.correction.requestedByEmployeeId).toBe(
      seed.employees.master.id,
    );
    expect(res.body.correction.reviewedByEmployeeId).toBe(
      seed.employees.master.id,
    );
    expect(res.body.correction.reviewedAt).not.toBeNull();

    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.qtyCut).toBe(8);
    expect(passport.qtyGood).toBe(8);

    const sew = await seamstressEntry(passportId);
    expect(sew.qty).toBe(8);
    const cut = await cutterEntry(passportId);
    expect(cut.qty).toBe(8);

    const ev = await t.prisma.passportEvent.findFirstOrThrow({
      where: { passportId, type: 'QTY_CORRECTED' },
    });
    expect(ev.qty).toBe(8);

    // В БД ровно одна строка — сразу APPROVED, PENDING снаружи не видна.
    const rows = await t.prisma.passportQtyCorrection.findMany({
      where: { passportId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('APPROVED');
  });

  test('одношаговая корректировка при висящей PENDING-заявке ОТК → 409 ALREADY_PENDING', async () => {
    const { passportId } = await setup(10);
    await createCorrection(passportId, { qtyAfter: 9 });

    const res = await http()
      .post(`/api/master-actions/passports/${passportId}/qty-correction`)
      .set('Cookie', masterCookie)
      .send({ qtyAfter: 8 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QTY_CORRECTION_ALREADY_PENDING');

    // Количества не тронуты, заявка ОТК осталась PENDING.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.qtyCut).toBe(10);
    expect(passport.qtyGood).toBe(10);
  });

  test('RBAC: одношаговая корректировка мастера для роли QC → 403', async () => {
    const { passportId } = await setup(10);

    const res = await http()
      .post(`/api/master-actions/passports/${passportId}/qty-correction`)
      .set('Cookie', qcCookie)
      .send({ qtyAfter: 9 });
    expect(res.status).toBe(403);
  });
});
