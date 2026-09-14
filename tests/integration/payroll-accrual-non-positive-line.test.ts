/**
 * Integration — ведомость начисления ЗП: строка «начисления есть, к выплате ≤ 0».
 *
 * Аудит движка расчёта 13.09.2026, K1 (регрессия; пробный тест —
 * `tests/scratch/calc_K/K1.test.ts`). Раньше `pay()` такую строку молча
 * пропускал: PayrollPayout/PayrollPayoutLine не создавались, payoutId оставался
 * null, документ становился PAID — и следующая ведомость брала те же
 * OperationEntry снова (5 000 начислено, −5 000 аванс → вторая ведомость опять
 * платит 5 000), а удержание сгорало.
 *
 * Ревью K1: полный зачёт «в ноль» — штатный случай ведомости и НЕ должен её
 * запирать: по строке с нетто 0 создаётся выплата на 0 ₽ (PIECEWORK закрывает
 * начисления, ADJUSTMENT = −Σ начислений). 422 остаётся только для нетто < 0.
 *
 * Ожидаемое поведение (закреплено здесь):
 *   1. PATCH строки с удержанием больше начислений (−6 000 при 5 000) → 422
 *      PAYROLL_ACCRUAL_LINE_NON_POSITIVE; строка и итоги не меняются.
 *   1b. PATCH −5 000 (зачёт «в ноль») → 200, нетто 0; pay → 200, PayrollPayout
 *      на 0 ₽ с PIECEWORK 5 000 + ADJUSTMENT −5 000; entry А закрыт; ведомость
 *      №2 его не берёт; заявки казначейства нет; аудит PAID: adjustmentsCount=1,
 *      totalAdjustRub=−5 000, skippedLineIds=[].
 *   2. Контроль границы: −4 999 → нетто 1 ₽ проходит, pay создаёт PIECEWORK 5 000 +
 *      ADJUSTMENT −4 999, следующая ведомость entry А не содержит.
 *   3. Строка стала «< 0» уже после PATCH (начисления уменьшились, recompute) →
 *      pay → 422, документ остаётся DRAFT, ни одной выплаты (и по соседней
 *      строке тоже — транзакция откатывается).
 *   4. Строка без начислений с одним удержанием (0 / −500) — как раньше:
 *      pay проходит, строка пропускается без выплаты, соседняя строка выплачена;
 *      аудит PAID не приписывает ей корректировку (adjustmentsCount=0,
 *      skippedLineIds=[её id]).
 *
 * Контракт — `docs/api.md §30c`, `docs/domain.md §10.9`.
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

describeWithDb('integration — payroll accrual documents: строка с нетто ≤ 0 (K1)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  const ACCRUAL_DATE_1 = '2026-04-30';
  const ACCRUAL_DATE_2 = '2026-05-31';
  const IN_RANGE = new Date('2026-04-15T10:00:00.000Z');
  const ACTIVE_STATUSES = ['DRAFT', 'ISSUED', 'ACKNOWLEDGED'] as const;

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
    // resetDatabase не трогает настройки — отсечку выставляем явно в историческое
    // WORK_DATE, чтобы состав документа зависел только от createdAt ≤ accrualDate.
    await t.prisma.payrollAccrualSchedule.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        cutoffBasis: 'WORK_DATE',
        appliesToSewing: false,
        appliesToCutting: false,
        autoCreateDraft: false,
      },
      update: {
        cutoffBasis: 'WORK_DATE',
        appliesToSewing: false,
        appliesToCutting: false,
        autoCreateDraft: false,
      },
    });
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      admin: t.adminCookie,
    };
  });

  const http = () => request(t.app.getHttpServer());

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  type DocBody = {
    id: string;
    status: string;
    totalPieceworkRub: number;
    totalAdjustRub: number;
    totalToPayRub: number;
    lines: Array<{
      id: string;
      employeeId: string;
      amountPieceworkRub: number;
      amountSalaryRub: number;
      manualAdjustRub: number;
      amountToPayRub: number;
      payoutId: string | null;
    }>;
  };

  async function createPassport() {
    const order = await t.prisma.order.create({
      data: {
        number: `O-K1R-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        items: {
          create: { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 500 },
        },
      },
    });
    return t.prisma.passport.create({
      data: {
        number: `P-K1R-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-K1R',
        cutDate: new Date(),
        qtyPlan: 500,
        qtyCut: 500,
        qtyGood: 500,
        qrCode: `passport:k1r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
  }

  /** APPROVED сдельное начисление qty × rate, createdAt внутри периода ведомости №1. */
  async function createApprovedEntry(employeeId: string, qty: number, rate: number) {
    const passport = await createPassport();
    const e = await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId,
        qty,
        ratePerUnit: new Prisma.Decimal(rate),
        amount: new Prisma.Decimal(qty * rate),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: IN_RANGE,
      },
    });
    await t.prisma.operationEntry.update({ where: { id: e.id }, data: { createdAt: IN_RANGE } });
    return e;
  }

  /**
   * Начисление «уехало» в другую активную выплату (например, ручная выплата
   * менеджера) — следующий recompute его из строки исключит.
   */
  async function coverEntryByOtherPayout(employeeId: string, entryId: string, amount: number) {
    const payout = await t.prisma.payrollPayout.create({
      data: {
        employeeId,
        periodFrom: new Date('2026-04-01T00:00:00.000Z'),
        periodTo: new Date('2026-04-30T00:00:00.000Z'),
        status: 'ISSUED',
        amountPieceworkRub: new Prisma.Decimal(amount),
        amountSalaryRub: new Prisma.Decimal(0),
        amountTotalRub: new Prisma.Decimal(amount),
        createdById: seed.employees['shop-chief'].id,
        issuedAt: new Date(),
        issuedById: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.payrollPayoutLine.create({
      data: {
        payoutId: payout.id,
        kind: 'PIECEWORK',
        operationEntryId: entryId,
        amountRub: new Prisma.Decimal(amount),
        occurredOn: IN_RANGE,
        snapshot: {},
      },
    });
    return payout;
  }

  async function createDoc(accrualDate: string): Promise<DocBody> {
    const res = await http()
      .post('/api/payroll/accrual-documents')
      .set('Cookie', cookies.manager)
      .send({ accrualDate });
    expect(res.status, `create doc ${accrualDate}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    return res.body as DocBody;
  }

  async function getDoc(id: string): Promise<DocBody> {
    const res = await http()
      .get(`/api/payroll/accrual-documents/${id}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    return res.body as DocBody;
  }

  async function patchLine(docId: string, lineId: string, manualAdjustRub: number, comment: string) {
    return http()
      .patch(`/api/payroll/accrual-documents/${docId}/lines/${lineId}`)
      .set('Cookie', cookies.manager)
      .send({ manualAdjustRub, manualComment: comment });
  }

  async function pay(docId: string) {
    return http()
      .post(`/api/payroll/accrual-documents/${docId}/pay`)
      .set('Cookie', cookies.manager)
      .send({});
  }

  async function activeLinesForEntry(entryId: string) {
    return t.prisma.payrollPayoutLine.findMany({
      where: {
        operationEntryId: entryId,
        payout: { status: { in: [...ACTIVE_STATUSES] } },
      },
    });
  }

  /** Ведомость №1: А +5 000 (500 × 10 ₽), Б +3 000 (300 × 10 ₽). */
  async function seedTwoLines() {
    const A = seed.employees.seamstress.id;
    const B = seed.employees.cutter.id;
    const entryA = await createApprovedEntry(A, 500, 10);
    const entryB = await createApprovedEntry(B, 300, 10);
    const doc1 = await createDoc(ACCRUAL_DATE_1);
    expect(doc1.lines).toHaveLength(2);
    const lineA = doc1.lines.find((l) => l.employeeId === A)!;
    const lineB = doc1.lines.find((l) => l.employeeId === B)!;
    expect(lineA.amountPieceworkRub).toBeCloseTo(5000, 2);
    expect(lineB.amountPieceworkRub).toBeCloseTo(3000, 2);
    expect(doc1.totalToPayRub).toBeCloseTo(8000, 2);
    return { A, B, entryA, entryB, doc1, lineA, lineB };
  }

  async function paidAuditPayload(docId: string) {
    const rows = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_ACCRUAL_DOCUMENT', entityId: docId, event: 'PAYROLL_ACCRUAL_DOCUMENT_PAID' },
    });
    expect(rows).toHaveLength(1);
    return rows[0]!.payload as {
      payoutsCreated: number;
      adjustmentsCount: number;
      totalAdjustRub: number;
      skippedLineIds: string[];
    };
  }

  // ---------------------------------------------------------------------------
  // 1. PATCH: удержание БОЛЬШЕ начислений отбивается 422, строка не меняется
  // ---------------------------------------------------------------------------

  for (const [label, adjust] of [
    ['удержание больше начислений (+5 000 / −6 000)', -6000],
    ['удержание больше начислений на копейку (+5 000 / −5 000,01)', -5000.01],
  ] as const) {
    test(`PATCH строки: ${label} → 422 PAYROLL_ACCRUAL_LINE_NON_POSITIVE, строка и итоги без изменений`, async () => {
      const s = await seedTwoLines();

      const patched = await patchLine(s.doc1.id, s.lineA.id, adjust, 'аванс/удержание');
      expect(patched.status, JSON.stringify(patched.body)).toBe(422);
      expect(patched.body.code).toBe('PAYROLL_ACCRUAL_LINE_NON_POSITIVE');
      // Подсказка: удержать можно не больше суммы начислений.
      expect(String(patched.body.message)).toContain('5000.00');

      // Строка и итоги документа — как до запроса.
      const after = await getDoc(s.doc1.id);
      expect(after.status).toBe('DRAFT');
      const lineA = after.lines.find((l) => l.employeeId === s.A)!;
      expect(lineA.manualAdjustRub).toBeCloseTo(0, 2);
      expect(lineA.amountToPayRub).toBeCloseTo(5000, 2);
      expect(after.totalAdjustRub).toBeCloseTo(0, 2);
      expect(after.totalToPayRub).toBeCloseTo(8000, 2);

      // Аудит LINE_UPDATED не пишется — правка отвергнута.
      const audit = await t.prisma.auditLog.findMany({
        where: {
          entityType: 'PAYROLL_ACCRUAL_DOCUMENT',
          entityId: s.doc1.id,
          event: 'PAYROLL_ACCRUAL_DOCUMENT_LINE_UPDATED',
        },
      });
      expect(audit).toHaveLength(0);
    });
  }

  // ---------------------------------------------------------------------------
  // 1b. Полный зачёт «в ноль» — штатный случай: выплата на 0 ₽ закрывает начисления
  // ---------------------------------------------------------------------------

  test('зачёт аванса «в ноль» (+5 000 / −5 000): PATCH 200, pay 200 → выплата 0 ₽ (PIECEWORK 5 000 + ADJUSTMENT −5 000), ведомость №2 без entry А', async () => {
    const s = await seedTwoLines();

    const patched = await patchLine(s.doc1.id, s.lineA.id, -5000, 'аванс зачтён целиком');
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const lineA1 = (patched.body as DocBody).lines.find((l) => l.employeeId === s.A)!;
    expect(lineA1.amountToPayRub).toBeCloseTo(0, 2);
    expect((patched.body as DocBody).totalToPayRub).toBeCloseTo(3000, 2);

    const paid = await pay(s.doc1.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe('PAID');
    const paidLines = (paid.body as DocBody).lines;
    const paidLineA = paidLines.find((l) => l.employeeId === s.A)!;
    expect(paidLineA.payoutId, 'строка с нетто 0 привязана к выплате').not.toBeNull();
    expect(paidLines.find((l) => l.employeeId === s.B)!.payoutId).not.toBeNull();

    // Выплата на 0 ₽: PIECEWORK 5 000 закрывает entry А, ADJUSTMENT −5 000 фиксирует зачёт.
    const coveredA = await activeLinesForEntry(s.entryA.id);
    expect(coveredA, 'entry А закрыт ровно одной активной PayrollPayoutLine').toHaveLength(1);
    expect(coveredA[0]!.payoutId).toBe(paidLineA.payoutId);
    const payoutA = await t.prisma.payrollPayout.findUniqueOrThrow({
      where: { id: paidLineA.payoutId! },
      include: { lines: true },
    });
    expect(payoutA.status).toBe('ISSUED');
    expect(Number(payoutA.amountTotalRub)).toBeCloseTo(0, 2);
    expect(Number(payoutA.amountPieceworkRub)).toBeCloseTo(5000, 2);
    const piecework = payoutA.lines.filter((l) => l.kind === 'PIECEWORK');
    expect(piecework).toHaveLength(1);
    expect(Number(piecework[0]!.amountRub)).toBeCloseTo(5000, 2);
    const adj = payoutA.lines.filter((l) => l.kind === 'ADJUSTMENT');
    expect(adj).toHaveLength(1);
    expect(Number(adj[0]!.amountRub)).toBeCloseTo(-5000, 2);
    expect(payoutA.lines).toHaveLength(2);

    // Заявка казначейства на 0 ₽ не создаётся.
    const salaryRequests = await t.prisma.supplierPayment.findMany({
      where: { payrollPayoutId: payoutA.id },
    });
    expect(salaryRequests).toHaveLength(0);

    // Аудит PAID: корректировка засчитана ровно один раз, пропущенных строк нет.
    const payload = await paidAuditPayload(s.doc1.id);
    expect(payload.payoutsCreated).toBe(2);
    expect(payload.adjustmentsCount).toBe(1);
    expect(payload.totalAdjustRub).toBeCloseTo(-5000, 2);
    expect(payload.skippedLineIds).toEqual([]);

    // Ведомость №2 на позднюю дату: начисления обоих закрыты — А не появляется снова.
    const doc2 = await createDoc(ACCRUAL_DATE_2);
    expect(doc2.lines.find((l) => l.employeeId === s.A)).toBeUndefined();
    expect(doc2.lines.find((l) => l.employeeId === s.B)).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 2. Контроль границы: −4 999 → нетто 1 ₽ проходит и закрывает начисления
  // ---------------------------------------------------------------------------

  test('граница: +5 000 / −4 999 → PATCH 200, pay создаёт PIECEWORK 5 000 + ADJUSTMENT −4 999, ведомость №2 без entry А', async () => {
    const s = await seedTwoLines();

    const patched = await patchLine(s.doc1.id, s.lineA.id, -4999, 'удержание за брак');
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const lineA1 = (patched.body as DocBody).lines.find((l) => l.employeeId === s.A)!;
    expect(lineA1.amountToPayRub).toBeCloseTo(1, 2);

    const paid = await pay(s.doc1.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe('PAID');

    const coveredA = await activeLinesForEntry(s.entryA.id);
    expect(coveredA, 'entry А закрыт ровно одной активной PayrollPayoutLine').toHaveLength(1);
    const payoutLines = await t.prisma.payrollPayoutLine.findMany({
      where: { payoutId: coveredA[0]!.payoutId },
    });
    const adj = payoutLines.find((l) => l.kind === 'ADJUSTMENT');
    expect(Number(adj?.amountRub ?? 0)).toBeCloseTo(-4999, 2);
    const payoutA = await t.prisma.payrollPayout.findUniqueOrThrow({
      where: { id: coveredA[0]!.payoutId },
    });
    expect(Number(payoutA.amountTotalRub)).toBeCloseTo(1, 2);

    // Ведомость №2 на позднюю дату: начисления обоих закрыты — документ пуст.
    const doc2 = await createDoc(ACCRUAL_DATE_2);
    expect(doc2.lines.find((l) => l.employeeId === s.A)).toBeUndefined();
    expect(doc2.lines.find((l) => l.employeeId === s.B)).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 3. Строка стала «< 0» после PATCH (начисления уменьшились) → pay 422, DRAFT
  // ---------------------------------------------------------------------------

  test('pay: строка «начисления есть, к выплате < 0» (после recompute) → 422, документ DRAFT, выплат нет ни по одной строке', async () => {
    const A = seed.employees.seamstress.id;
    const B = seed.employees.cutter.id;
    // А: два начисления 3 000 + 2 000; Б: 3 000.
    const entryA1 = await createApprovedEntry(A, 300, 10);
    const entryA2 = await createApprovedEntry(A, 200, 10);
    const entryB = await createApprovedEntry(B, 300, 10);

    const doc1 = await createDoc(ACCRUAL_DATE_1);
    const lineA = doc1.lines.find((l) => l.employeeId === A)!;
    expect(lineA.amountPieceworkRub).toBeCloseTo(5000, 2);

    // Удержание 4 000 при 5 000 начислений — допустимо (нетто 1 000).
    const patched = await patchLine(doc1.id, lineA.id, -4000, 'аванс 4 000');
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    // Начисление 2 000 уехало в другую выплату → recompute оставляет А 3 000 / −4 000 / −1 000.
    await coverEntryByOtherPayout(A, entryA2.id, 2000);
    const recomputed = await http()
      .post(`/api/payroll/accrual-documents/${doc1.id}/recompute`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(recomputed.status, JSON.stringify(recomputed.body)).toBe(200);
    const lineA2 = (recomputed.body as DocBody).lines.find((l) => l.employeeId === A)!;
    expect(lineA2.amountPieceworkRub).toBeCloseTo(3000, 2);
    expect(lineA2.manualAdjustRub).toBeCloseTo(-4000, 2);
    expect(lineA2.amountToPayRub).toBeCloseTo(-1000, 2);

    // Проведение отбивается целиком.
    const paid = await pay(doc1.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(422);
    expect(paid.body.code).toBe('PAYROLL_ACCRUAL_LINE_NON_POSITIVE');

    const after = await t.prisma.payrollAccrualDocument.findUniqueOrThrow({
      where: { id: doc1.id },
      include: { lines: true },
    });
    expect(after.status).toBe('DRAFT');
    expect(after.paidAt).toBeNull();
    for (const l of after.lines) expect(l.payoutId).toBeNull();

    // Ни одной выплаты из этого документа: ни по А, ни по Б (Б — транзакция откатилась).
    const payoutsB = await t.prisma.payrollPayout.findMany({ where: { employeeId: B } });
    expect(payoutsB).toHaveLength(0);
    expect(await activeLinesForEntry(entryB.id)).toHaveLength(0);
    expect(await activeLinesForEntry(entryA1.id)).toHaveLength(0);
    const paidAudit = await t.prisma.auditLog.findMany({
      where: { entityType: 'PAYROLL_ACCRUAL_DOCUMENT', entityId: doc1.id, event: 'PAYROLL_ACCRUAL_DOCUMENT_PAID' },
    });
    expect(paidAudit).toHaveLength(0);

    // Менеджер уменьшает удержание до суммы начислений (зачёт «в ноль») — документ
    // проводится: выплата А на 0 ₽ закрывает entry А1, 1 000 уходит в следующую ведомость.
    const lineAAfter = after.lines.find((l) => l.employeeId === A)!;
    const fixed = await patchLine(doc1.id, lineAAfter.id, -3000, 'аванс: 3 000 сейчас, 1 000 — в следующую ведомость');
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect((fixed.body as DocBody).lines.find((l) => l.employeeId === A)!.amountToPayRub).toBeCloseTo(0, 2);
    const paid2 = await pay(doc1.id);
    expect(paid2.status, JSON.stringify(paid2.body)).toBe(200);
    expect(paid2.body.status).toBe('PAID');
    expect(await activeLinesForEntry(entryA1.id)).toHaveLength(1);
    expect(await activeLinesForEntry(entryB.id)).toHaveLength(1);
    const payoutA = await t.prisma.payrollPayout.findUniqueOrThrow({
      where: { id: (paid2.body as DocBody).lines.find((l) => l.employeeId === A)!.payoutId! },
    });
    expect(Number(payoutA.amountTotalRub)).toBeCloseTo(0, 2);
  });

  // ---------------------------------------------------------------------------
  // 4. Строка без начислений с одним удержанием — как раньше (пропуск при pay)
  // ---------------------------------------------------------------------------

  test('строка без начислений с одним удержанием (0 / −500): pay проходит, строка пропущена без выплаты, соседняя выплачена', async () => {
    const s = await seedTwoLines();

    // Удержание 500 при 5 000 — допустимо.
    const patched = await patchLine(s.doc1.id, s.lineA.id, -500, 'удержание');
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    // Все начисления А уехали в другую выплату → recompute оставляет А 0 / −500 / −500.
    await coverEntryByOtherPayout(s.A, s.entryA.id, 5000);
    const recomputed = await http()
      .post(`/api/payroll/accrual-documents/${s.doc1.id}/recompute`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(recomputed.status, JSON.stringify(recomputed.body)).toBe(200);
    const lineA2 = (recomputed.body as DocBody).lines.find((l) => l.employeeId === s.A)!;
    expect(lineA2.amountPieceworkRub).toBeCloseTo(0, 2);
    expect(lineA2.amountToPayRub).toBeCloseTo(-500, 2);

    // Повторно брать у такой строки нечего — правило K1 её не задевает, pay проходит.
    const paid = await pay(s.doc1.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe('PAID');
    const lines = (paid.body as DocBody).lines;
    expect(lines.find((l) => l.employeeId === s.A)!.payoutId).toBeNull();
    expect(lines.find((l) => l.employeeId === s.B)!.payoutId).not.toBeNull();
    expect(await activeLinesForEntry(s.entryB.id)).toHaveLength(1);

    // Ревью K1: аудит PAID не приписывает пропущенной строке корректировку —
    // ADJUSTMENT-строка по ней не создана, удержание −500 в выплату не попало.
    const payload = await paidAuditPayload(s.doc1.id);
    expect(payload.payoutsCreated).toBe(1);
    expect(payload.adjustmentsCount).toBe(0);
    expect(payload.totalAdjustRub).toBeCloseTo(0, 2);
    expect(payload.skippedLineIds).toEqual([lineA2.id]);
    const adjustments = await t.prisma.payrollPayoutLine.findMany({
      where: { kind: 'ADJUSTMENT', payout: { employeeId: s.A } },
    });
    expect(adjustments).toHaveLength(0);
  });
});
