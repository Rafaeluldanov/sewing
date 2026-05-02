/**
 * Integration-тесты модуля «Документ начисления зарплаты» (PHASE 3 STEP 6.2).
 *
 * Покрытие:
 *   1. POST создаёт DRAFT и включает только APPROVED OperationEntry ≤ accrualDate.
 *   2. Pending-записи исключаются.
 *   3. Записи после accrualDate исключаются.
 *   4. Записи, уже включённые в активный PayrollPayoutLine, исключаются.
 *   5. PATCH /lines/:lineId изменяет manualAdjustRub и пересчитывает
 *      amountToPayRub и итоги документа.
 *   6. recompute сохраняет manualAdjustRub / manualComment.
 *   7. pay создаёт PayrollPayout ISSUED для каждой строки с amountToPayRub > 0.
 *   8. pay блокируется (409), если manualAdjustRub != 0 и ADJUSTMENT не поддерживается.
 *   9. Нельзя изменить строку после PAID.
 *  10. Нельзя провести документ дважды.
 *  11. cancel работает из DRAFT.
 *  12. PAID нельзя отменить.
 *  13. Audit-события создаются.
 *
 * Если БД недоступна — `describeWithDb` пропускает все тесты (skip).
 *
 * Контракт — `docs/api.md §30c`, `docs/events.md §3.4`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — payroll accrual documents (PHASE 3 STEP 6.2)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  /**
   * Дата начисления — фиксированная, чтобы тесты были детерминированными.
   * Все тестовые начисления создаются ≤ этой даты.
   */
  const ACCRUAL_DATE = '2026-04-30';
  const IN_RANGE = new Date('2026-04-15T10:00:00.000Z');
  const AFTER_RANGE = new Date('2026-05-05T10:00:00.000Z');

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      admin: t.adminCookie,
    };
  });

  // -------------------------------------------------------------------------
  // 1. CREATE — APPROVED OperationEntry ≤ accrualDate попадает
  // -------------------------------------------------------------------------

  test('POST /api/payroll/accrual-documents включает APPROVED OperationEntry ≤ accrualDate', async () => {
    const passport = await createPassport(t, seed);

    const approved = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(50),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: approved.id },
      data: { createdAt: IN_RANGE },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });

    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].amountPieceworkRub).toBeCloseTo(50, 2);
    expect(res.body.totalPieceworkRub).toBeCloseTo(50, 2);

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_ACCRUAL_DOCUMENT', entityId: res.body.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('PAYROLL_ACCRUAL_DOCUMENT_CREATED');
  });

  // -------------------------------------------------------------------------
  // 2. Pending-записи исключаются
  // -------------------------------------------------------------------------

  test('Pending OperationEntry НЕ попадает в документ', async () => {
    const passport = await createPassport(t, seed);

    const pending = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(50),
        status: 'PENDING_RELEASE',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: pending.id },
      data: { createdAt: IN_RANGE },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });

    expect(res.status).toBeLessThan(300);
    expect(res.body.lines).toHaveLength(0);
    expect(res.body.totalToPayRub).toBeCloseTo(0, 2);
  });

  // -------------------------------------------------------------------------
  // 3. Записи после accrualDate исключаются
  // -------------------------------------------------------------------------

  test('OperationEntry после accrualDate НЕ попадает', async () => {
    const passport = await createPassport(t, seed);

    const future = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 3,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(30),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: AFTER_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: future.id },
      data: { createdAt: AFTER_RANGE },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });

    expect(res.status).toBeLessThan(300);
    expect(res.body.lines).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Уже включённые в активный PayrollPayout — исключаются
  // -------------------------------------------------------------------------

  test('OperationEntry в активном PayrollPayout исключается из документа', async () => {
    const passport = await createPassport(t, seed);

    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 2,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(20),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    // Создать активный PayrollPayout с этой строкой.
    const payout = await t.prisma.payrollPayout.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        periodFrom: new Date('2026-04-01T00:00:00.000Z'),
        periodTo: new Date('2026-04-30T00:00:00.000Z'),
        status: 'DRAFT',
        amountPieceworkRub: new Prisma.Decimal(20),
        amountSalaryRub: new Prisma.Decimal(0),
        amountTotalRub: new Prisma.Decimal(20),
        createdById: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.payrollPayoutLine.create({
      data: {
        payoutId: payout.id,
        kind: 'PIECEWORK',
        operationEntryId: entry.id,
        amountRub: new Prisma.Decimal(20),
        occurredOn: new Date('2026-04-15T00:00:00.000Z'),
        snapshot: {},
      },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });

    expect(res.status).toBeLessThan(300);
    // Строка должна быть пустой — запись уже занята.
    expect(res.body.lines).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. PATCH line — изменяет amountToPayRub и итоги
  // -------------------------------------------------------------------------

  test('PATCH /lines/:lineId изменяет manualAdjustRub и пересчитывает итоги', async () => {
    const passport = await createPassport(t, seed);
    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(100),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    expect(created.status).toBeLessThan(300);
    const docId = created.body.id as string;
    const lineId = created.body.lines[0].id as string;

    const patched = await request(t.app.getHttpServer())
      .patch(`/api/payroll/accrual-documents/${docId}/lines/${lineId}`)
      .set('Cookie', cookies.manager)
      .send({ manualAdjustRub: 50, manualComment: 'Премия' });

    expect(patched.status).toBe(200);
    const updatedLine = patched.body.lines.find((l: { id: string }) => l.id === lineId);
    expect(updatedLine.manualAdjustRub).toBeCloseTo(50, 2);
    expect(updatedLine.amountToPayRub).toBeCloseTo(150, 2);
    expect(updatedLine.manualComment).toBe('Премия');
    expect(patched.body.totalAdjustRub).toBeCloseTo(50, 2);
    expect(patched.body.totalToPayRub).toBeCloseTo(150, 2);

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_ACCRUAL_DOCUMENT', entityId: docId, event: 'PAYROLL_ACCRUAL_DOCUMENT_LINE_UPDATED' },
    });
    expect(audit).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6. recompute сохраняет manualAdjustRub / manualComment
  // -------------------------------------------------------------------------

  test('recompute сохраняет manualAdjustRub и manualComment', async () => {
    const passport = await createPassport(t, seed);
    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(50),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    expect(created.status).toBeLessThan(300);
    const docId = created.body.id as string;
    const lineId = created.body.lines[0].id as string;

    await request(t.app.getHttpServer())
      .patch(`/api/payroll/accrual-documents/${docId}/lines/${lineId}`)
      .set('Cookie', cookies.manager)
      .send({ manualAdjustRub: 25, manualComment: 'Ручная корр.' });

    const recomputed = await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/recompute`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(recomputed.status).toBe(200);

    const line = recomputed.body.lines.find(
      (l: { employeeId: string }) => l.employeeId === seed.employees.seamstress.id,
    );
    expect(line).toBeDefined();
    expect(line.manualAdjustRub).toBeCloseTo(25, 2);
    expect(line.manualComment).toBe('Ручная корр.');
    expect(line.amountPieceworkRub).toBeCloseTo(50, 2);
    expect(line.amountToPayRub).toBeCloseTo(75, 2);
  });

  // -------------------------------------------------------------------------
  // 7. pay создаёт PayrollPayout ISSUED
  // -------------------------------------------------------------------------

  test('pay создаёт PayrollPayout ISSUED для каждой строки amountToPayRub > 0', async () => {
    const passport = await createPassport(t, seed);
    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(100),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    expect(created.status).toBeLessThan(300);
    const docId = created.body.id as string;

    const paid = await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/pay`)
      .set('Cookie', cookies.manager)
      .send({});

    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    expect(paid.body.paidAt).toBeTruthy();

    // Проверить, что создан PayrollPayout ISSUED.
    const payouts = await t.prisma.payrollPayout.findMany({
      where: {
        employeeId: seed.employees.seamstress.id,
        status: 'ISSUED',
      },
    });
    expect(payouts.length).toBeGreaterThanOrEqual(1);
    const payout = payouts[0]!;
    expect(Number(payout.amountPieceworkRub)).toBeCloseTo(100, 2);

    // Проверить, что строка документа получила payoutId.
    const line = paid.body.lines[0];
    expect(line.payoutId).toBe(payout.id);

    // Audit.
    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_ACCRUAL_DOCUMENT', entityId: docId, event: 'PAYROLL_ACCRUAL_DOCUMENT_PAID' },
    });
    expect(audit).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 8. pay блокируется, если manualAdjustRub != 0 и ADJUSTMENT не поддерживается
  // -------------------------------------------------------------------------

  test('pay блокируется 409 PAYROLL_ACCRUAL_MANUAL_ADJUST_NOT_SUPPORTED, если manualAdjustRub != 0', async () => {
    const { PayrollPayoutLineKind } = await import('@prisma/client');
    const kindValues = Object.values(PayrollPayoutLineKind) as string[];
    const hasAdjustment = kindValues.includes('ADJUSTMENT');

    if (hasAdjustment) {
      // Если enum расширен, тест неприменим — пропускаем.
      return;
    }

    const passport = await createPassport(t, seed);
    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(100),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    const docId = created.body.id as string;
    const lineId = created.body.lines[0].id as string;

    // Добавить корректировку.
    await request(t.app.getHttpServer())
      .patch(`/api/payroll/accrual-documents/${docId}/lines/${lineId}`)
      .set('Cookie', cookies.manager)
      .send({ manualAdjustRub: 50 });

    const paid = await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/pay`)
      .set('Cookie', cookies.manager)
      .send({});

    expect(paid.status).toBe(409);
    expect(paid.body.code).toBe('PAYROLL_ACCRUAL_MANUAL_ADJUST_NOT_SUPPORTED');
  });

  // -------------------------------------------------------------------------
  // 9. Нельзя изменить строку после PAID
  // -------------------------------------------------------------------------

  test('PATCH /lines/:lineId возвращает 409 после PAID', async () => {
    const passport = await createPassport(t, seed);
    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(100),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    const docId = created.body.id as string;
    const lineId = created.body.lines[0].id as string;

    await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/pay`)
      .set('Cookie', cookies.manager)
      .send({});

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/payroll/accrual-documents/${docId}/lines/${lineId}`)
      .set('Cookie', cookies.manager)
      .send({ manualAdjustRub: 10 });

    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe('PAYROLL_ACCRUAL_DOCUMENT_INVALID_STATE');
  });

  // -------------------------------------------------------------------------
  // 10. Нельзя провести документ дважды
  // -------------------------------------------------------------------------

  test('pay дважды возвращает 409 PAYROLL_ACCRUAL_DOCUMENT_INVALID_STATE', async () => {
    const passport = await createPassport(t, seed);
    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(50),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    const docId = created.body.id as string;

    await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/pay`)
      .set('Cookie', cookies.manager)
      .send({});

    const secondPay = await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/pay`)
      .set('Cookie', cookies.manager)
      .send({});

    expect(secondPay.status).toBe(409);
    expect(secondPay.body.code).toBe('PAYROLL_ACCRUAL_DOCUMENT_INVALID_STATE');
  });

  // -------------------------------------------------------------------------
  // 11. cancel DRAFT работает
  // -------------------------------------------------------------------------

  test('cancel DRAFT → CANCELLED, пишет audit', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    expect(created.status).toBeLessThan(300);
    const docId = created.body.id as string;

    const cancelled = await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'Ошибка при создании' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelReason).toBe('Ошибка при создании');
    expect(cancelled.body.cancelledAt).toBeTruthy();

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_ACCRUAL_DOCUMENT', entityId: docId, event: 'PAYROLL_ACCRUAL_DOCUMENT_CANCELLED' },
    });
    expect(audit).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 12. PAID нельзя отменить
  // -------------------------------------------------------------------------

  test('cancel PAID возвращает 409', async () => {
    const passport = await createPassport(t, seed);
    const entry = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(50),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: entry.id },
      data: { createdAt: IN_RANGE },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    const docId = created.body.id as string;

    await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/pay`)
      .set('Cookie', cookies.manager)
      .send({});

    const cancelRes = await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({});

    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.code).toBe('PAYROLL_ACCRUAL_DOCUMENT_INVALID_STATE');
  });

  // -------------------------------------------------------------------------
  // 13. Audit-события создаются (create + recompute)
  // -------------------------------------------------------------------------

  test('audit-события CREATED и RECOMPUTED пишутся', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate: ACCRUAL_DATE });
    expect(created.status).toBeLessThan(300);
    const docId = created.body.id as string;

    await request(t.app.getHttpServer())
      .post(`/api/payroll/accrual-documents/${docId}/recompute`)
      .set('Cookie', cookies.manager)
      .send({});

    const auditAll = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_ACCRUAL_DOCUMENT', entityId: docId },
      orderBy: { createdAt: 'asc' },
    });

    const events = auditAll.map((a) => a.event);
    expect(events).toContain('PAYROLL_ACCRUAL_DOCUMENT_CREATED');
    expect(events).toContain('PAYROLL_ACCRUAL_DOCUMENT_RECOMPUTED');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createPassport(t: TestApp, seed: SeedResult) {
  const order = await t.prisma.order.create({
    data: {
      number: `O-PAD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderDate: new Date(),
      color: seed.product.color,
      status: 'IN_PRODUCTION',
      items: {
        create: {
          productId: seed.product.id,
          sizeId: seed.sizes.M,
          qtyPlan: 5,
        },
      },
    },
  });
  return t.prisma.passport.create({
    data: {
      number: `P-PAD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderId: order.id,
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
      rollNumber: 'R-PAD',
      cutDate: new Date(),
      qtyPlan: 5,
      qtyCut: 5,
      qtyGood: 5,
      qrCode: `passport:pad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      cutterId: seed.employees.cutter.id,
      creatorId: seed.employees.cutter.id,
    },
  });
}
