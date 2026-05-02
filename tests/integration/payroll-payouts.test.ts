/**
 * Integration-тесты модуля «Выплаты зарплаты» (PHASE 3 STEP 2).
 *
 * Покрытие:
 *   1. POST /api/payroll/payouts создаёт DRAFT и собирает строки
 *      по APPROVED OperationEntry + SalaryEntry за период; pending
 *      сдельщина исключается.
 *   2. POST /…/issue переводит DRAFT → ISSUED.
 *   3. POST /…/ack доступен только владельцу, идемпотентен;
 *      менеджер за чужого работника получает 403.
 *   4. POST /…/cancel допустим из DRAFT и ISSUED; ACKNOWLEDGED
 *      нельзя отменить.
 *   5. Активный инвариант: один и тот же `OperationEntry` нельзя
 *      включить в две активные выплаты (DRAFT/ISSUED/ACKNOWLEDGED) —
 *      422 PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED. После CANCELLED
 *      строка снова доступна.
 *   6. RBAC видимости: обычный сотрудник видит только свои в GET
 *      list, чужую карточку получает 404.
 *
 * См. контракт `docs/api.md §«Payroll payouts»`,
 * `docs/events.md §3.3 «PAYROLL_PAYOUT»`,
 * `apps/api/src/modules/payroll-payouts/*`.
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

describeWithDb('integration — payroll payouts (PHASE 3 STEP 2)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  // Период выплат: фиксированный календарный диапазон, чтобы тесты
  // были детерминированными (createdAt мы не контролируем у Prisma —
  // подменяем через `update({ data: { createdAt } })` после insert).
  const PERIOD_FROM = '2026-04-01';
  const PERIOD_TO = '2026-04-30';
  const IN_PERIOD = new Date('2026-04-15T10:00:00.000Z');

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
      qc: loginAs(t, seed.employees['qc']),
      admin: t.adminCookie,
    };
  });

  // -------------------------------------------------------------------------
  // 1. CREATE DRAFT — APPROVED OperationEntry + SalaryEntry попадают,
  //    PENDING_RELEASE — нет
  // -------------------------------------------------------------------------

  test('POST /api/payroll/payouts собирает APPROVED OperationEntry и SalaryEntry; pending исключается', async () => {
    const passport = await createPassport(t, seed);

    // Approved сдельщина в периоде.
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
        approvedAt: IN_PERIOD,
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: approved.id },
      data: { createdAt: IN_PERIOD },
    });

    // Pending сдельщина — НЕ должна попасть в snapshot.
    const pending = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_2.id,
        employeeId: seed.employees.seamstress.id,
        qty: 7,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(70),
        status: 'PENDING_RELEASE',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: pending.id },
      data: { createdAt: IN_PERIOD },
    });

    // SalaryEntry в периоде — ОК.
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        date: new Date(`${PERIOD_FROM}T00:00:00.000Z`),
        amount: new Prisma.Decimal(2500),
        source: 'SHIFT_DAY',
      },
    });

    // Approved-сдельщина ВНЕ периода — не должна попасть.
    const outside = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 9,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(90),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'OPERATION_TRANSITION',
        approvedAt: new Date('2026-05-15T10:00:00.000Z'),
      },
    });
    await t.prisma.operationEntry.update({
      where: { id: outside.id },
      data: { createdAt: new Date('2026-05-15T10:00:00.000Z') },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.amountPieceworkRub).toBeCloseTo(50, 2);
    expect(res.body.amountSalaryRub).toBeCloseTo(2500, 2);
    expect(res.body.amountTotalRub).toBeCloseTo(2550, 2);
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(res.body.lines).toHaveLength(2);
    const kinds = res.body.lines.map((l: { kind: string }) => l.kind).sort();
    expect(kinds).toEqual(['PIECEWORK', 'SALARY']);

    // Проверяем audit-запись.
    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_PAYOUT', entityId: res.body.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('PAYROLL_PAYOUT_CREATED');
  });

  // -------------------------------------------------------------------------
  // 2. ISSUE DRAFT → ISSUED
  // -------------------------------------------------------------------------

  test('POST /…/issue переводит DRAFT → ISSUED и пишет AuditLog', async () => {
    await seedApprovedOperationEntry(t, seed, seed.employees.seamstress.id, 30);

    const draft = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(draft.status).toBeLessThan(300);

    const issued = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draft.body.id}/issue`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('ISSUED');
    expect(issued.body.issuedAt).toBeTruthy();
    expect(issued.body.amountTotalRub).toBeCloseTo(30, 2);

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_PAYOUT', entityId: draft.body.id },
      orderBy: { createdAt: 'asc' },
    });
    const events = audit.map((a) => a.event);
    expect(events).toContain('PAYROLL_PAYOUT_CREATED');
    expect(events).toContain('PAYROLL_PAYOUT_ISSUED');
  });

  // -------------------------------------------------------------------------
  // 3. ACK — only owner, idempotent, manager forbidden
  // -------------------------------------------------------------------------

  test('POST /…/ack: подтвердить может только владелец, идемпотентно', async () => {
    await seedApprovedOperationEntry(t, seed, seed.employees.seamstress.id, 40);

    const draft = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(draft.status).toBeLessThan(300);
    const id = draft.body.id;

    await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${id}/issue`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);

    // Менеджер не может подтвердить за чужого сотрудника.
    const forbidden = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${id}/ack`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('PAYROLL_PAYOUT_FORBIDDEN_ACK');

    // Сотрудник-владелец подтверждает.
    const ack = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${id}/ack`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('ACKNOWLEDGED');
    expect(ack.body.acknowledgedAt).toBeTruthy();

    // Идемпотентность: повторный ACK тем же владельцем не падает.
    const ack2 = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${id}/ack`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(ack2.status).toBe(200);
    expect(ack2.body.status).toBe('ACKNOWLEDGED');

    // AuditLog: ровно одно ACKNOWLEDGED-событие, без дублей.
    const ackAudit = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'PAYROLL_PAYOUT',
        entityId: id,
        event: 'PAYROLL_PAYOUT_ACKNOWLEDGED',
      },
    });
    expect(ackAudit).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 4. CANCEL: DRAFT/ISSUED → CANCELLED, ACKNOWLEDGED нельзя
  // -------------------------------------------------------------------------

  test('POST /…/cancel допустим из DRAFT и ISSUED, ACKNOWLEDGED нельзя', async () => {
    await seedApprovedOperationEntry(t, seed, seed.employees.seamstress.id, 25);

    // DRAFT → CANCELLED
    const draftA = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(draftA.status).toBeLessThan(300);
    const cancelDraft = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draftA.body.id}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'Тест' });
    expect(cancelDraft.status).toBe(200);
    expect(cancelDraft.body.status).toBe('CANCELLED');

    // ISSUED → CANCELLED
    const draftB = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(draftB.status).toBeLessThan(300);
    await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draftB.body.id}/issue`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);
    const cancelIssued = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draftB.body.id}/cancel`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(cancelIssued.status).toBe(200);
    expect(cancelIssued.body.status).toBe('CANCELLED');

    // ACKNOWLEDGED → cancel запрещён
    const draftC = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(draftC.status).toBeLessThan(300);
    await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draftC.body.id}/issue`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);
    await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draftC.body.id}/ack`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(200);
    const cancelAck = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draftC.body.id}/cancel`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(cancelAck.status).toBe(409);
    expect(cancelAck.body.code).toBe('PAYROLL_PAYOUT_INVALID_TRANSITION');
  });

  // -------------------------------------------------------------------------
  // 5. ACTIVE UNIQUENESS: same OperationEntry blocks 2nd active payout
  // -------------------------------------------------------------------------

  test('одна OperationEntry не может попасть в две активные выплаты; CANCELLED освобождает строку', async () => {
    await seedApprovedOperationEntry(t, seed, seed.employees.seamstress.id, 60);

    // Первая выплата — захватывает строку.
    const first = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(first.status).toBeLessThan(300);
    expect(first.body.amountPieceworkRub).toBeCloseTo(60, 2);

    // Вторая выплата с тем же employeeId/period — должна упасть 422.
    const second = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED');

    // Отменяем первую — строка снова доступна.
    await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${first.body.id}/cancel`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);

    const third = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(third.status).toBeLessThan(300);
    expect(third.body.amountPieceworkRub).toBeCloseTo(60, 2);
  });

  // -------------------------------------------------------------------------
  // 6. RBAC scope
  // -------------------------------------------------------------------------

  test('обычный сотрудник видит только свои выплаты в list и чужую — 404', async () => {
    await seedApprovedOperationEntry(t, seed, seed.employees.seamstress.id, 11);
    const own = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.seamstress.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(own.status).toBeLessThan(300);

    // QC создадим аналогично — на другого сотрудника.
    await seedApprovedOperationEntry(t, seed, seed.employees.qc.id, 22);
    const other = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.qc.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(other.status).toBeLessThan(300);

    // Швея в list видит только свою; явный employeeId-фильтр игнорируется.
    const list = await request(t.app.getHttpServer())
      .get('/api/payroll/payouts')
      .query({ employeeId: seed.employees.qc.id })
      .set('Cookie', cookies.seamstress);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].employeeId).toBe(seed.employees.seamstress.id);

    // Чужая карточка — 404, не 403.
    const get = await request(t.app.getHttpServer())
      .get(`/api/payroll/payouts/${other.body.id}`)
      .set('Cookie', cookies.seamstress);
    expect(get.status).toBe(404);
    expect(get.body.code).toBe('PAYROLL_PAYOUT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createPassport(t: TestApp, seed: SeedResult) {
  const order = await t.prisma.order.create({
    data: {
      number: `O-PP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
      number: `P-PP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      orderId: order.id,
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
      rollNumber: 'R-PP',
      cutDate: new Date(),
      qtyPlan: 5,
      qtyCut: 5,
      qtyGood: 5,
      qrCode: `passport:pp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      cutterId: seed.employees.cutter.id,
      creatorId: seed.employees.cutter.id,
    },
  });
}

/**
 * Создаёт одну APPROVED `OperationEntry` за фиксированную дату внутри
 * `[PERIOD_FROM, PERIOD_TO]`. `createdAt` подменяем после insert,
 * потому что Prisma в `create` заполняет его текущим временем.
 */
async function seedApprovedOperationEntry(
  t: TestApp,
  seed: SeedResult,
  employeeId: string,
  amount: number,
) {
  const passport = await createPassport(t, seed);
  const inPeriod = new Date('2026-04-15T10:00:00.000Z');
  const entry = await t.prisma.operationEntry.create({
    data: {
      passportId: passport.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId,
      qty: 1,
      ratePerUnit: new Prisma.Decimal(amount),
      amount: new Prisma.Decimal(amount),
      status: 'APPROVED',
      approvalMode: 'IMMEDIATE',
      sourceEventType: 'PASSPORT_CREATED',
      approvedAt: inPeriod,
    },
  });
  await t.prisma.operationEntry.update({
    where: { id: entry.id },
    data: { createdAt: inPeriod },
  });
  return entry;
}
