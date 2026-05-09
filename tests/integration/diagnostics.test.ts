/**
 * Integration-тест: diagnostic consistency report.
 *
 * Контракт — `docs/ops.md §«Diagnostics»`,
 * `apps/api/src/modules/diagnostics/diagnostics.service.ts`.
 *
 * Эти тесты создают «невозможные» состояния через прямой Prisma-write
 * (потому что обычные сервисные API такие состояния не позволяют — в
 * этом и смысл диагностики), потом дёргают endpoint и проверяют, что
 * соответствующие коды действительно появились в отчёте.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import type {
  DiagnosticConsistencyReportDto,
  DiagnosticIssueDto,
} from '@sewing/shared/diagnostics';

const ENDPOINT = '/api/admin/diagnostics/consistency';

async function fetchReport(
  t: TestApp,
): Promise<DiagnosticConsistencyReportDto> {
  const res = await request(t.app.getHttpServer())
    .get(ENDPOINT)
    .set('Cookie', t.adminCookie);
  expect(res.status).toBe(200);
  return res.body as DiagnosticConsistencyReportDto;
}

function findIssue(
  report: DiagnosticConsistencyReportDto,
  code: string,
  entityId?: string,
): DiagnosticIssueDto | undefined {
  return report.issues.find(
    (i) => i.code === code && (entityId === undefined || i.entityId === entityId),
  );
}

async function makePassport(
  t: TestApp,
  seed: SeedResult,
  override: Partial<{
    status: 'CREATED' | 'IN_PROGRESS' | 'PACKED' | 'CANCELLED';
    currentEmployeeId: string | null;
    currentCellId: string | null;
    currentRouteStepIndex: number | null;
    currentOperationId: string | null;
    qtyCut: number;
    qtyGood: number;
  }> = {},
): Promise<{ id: string; orderId: string }> {
  const order = await t.prisma.order.create({
    data: {
      number: `INV-${Math.random().toString(36).slice(2, 8)}`,
      orderDate: new Date(),
      color: seed.product.color,
      status: 'IN_PRODUCTION',
      items: {
        create: {
          productId: seed.product.id,
          sizeId: seed.sizes.M!,
          qtyPlan: 5,
        },
      },
    },
  });
  const passport = await t.prisma.passport.create({
    data: {
      number: `P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      qrCode: `passport:test-${Math.random().toString(36).slice(2, 10)}`,
      orderId: order.id,
      productId: seed.product.id,
      sizeId: seed.sizes.M!,
      color: seed.product.color,
      rollNumber: 'R-X',
      cutDate: new Date(),
      qtyPlan: 5,
      qtyCut: override.qtyCut ?? 5,
      qtyGood: override.qtyGood ?? 5,
      status: override.status ?? 'CREATED',
      currentEmployeeId: override.currentEmployeeId ?? null,
      currentCellId: override.currentCellId ?? null,
      currentRouteStepIndex: override.currentRouteStepIndex ?? null,
      currentOperationId: override.currentOperationId ?? null,
      cutterId: seed.employees['cutter']!.id,
      creatorId: seed.employees['cutter']!.id,
    },
  });
  return { id: passport.id, orderId: order.id };
}

describeWithDb('integration — diagnostic consistency report', () => {
  let t: TestApp;
  let seed: SeedResult;

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
  });

  // ---------------------------------------------------------------------------
  // Базовая форма ответа
  // ---------------------------------------------------------------------------

  test('A. Минимальный seed → отчёт пустой и форма корректная', async () => {
    const report = await fetchReport(t);
    expect(report.summary.total).toBe(0);
    expect(report.summary.critical).toBe(0);
    expect(report.summary.warning).toBe(0);
    expect(report.issues).toEqual([]);
    expect(typeof report.generatedAt).toBe('string');
    expect(new Date(report.generatedAt).toString()).not.toBe('Invalid Date');
  });

  // ---------------------------------------------------------------------------
  // PASSPORT_IN_PROGRESS_WITHOUT_EMPLOYEE
  // ---------------------------------------------------------------------------

  test('B. IN_PROGRESS без employee и без буфера → CRITICAL', async () => {
    const { id } = await makePassport(t, seed, {
      status: 'IN_PROGRESS',
      currentEmployeeId: null,
      currentCellId: null,
      currentRouteStepIndex: null,
    });
    const report = await fetchReport(t);
    const issue = findIssue(report, 'PASSPORT_IN_PROGRESS_WITHOUT_EMPLOYEE', id);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('CRITICAL');
    expect(issue?.entityType).toBe('PASSPORT');
    expect(report.summary.critical).toBeGreaterThanOrEqual(1);
  });

  test('B-bis. IN_PROGRESS без employee, но с currentCellId → WARNING (буфер)', async () => {
    const { id } = await makePassport(t, seed, {
      status: 'IN_PROGRESS',
      currentEmployeeId: null,
      currentCellId: seed.cells.A1!.id,
      currentRouteStepIndex: null,
    });
    const report = await fetchReport(t);
    const issue = findIssue(report, 'PASSPORT_IN_PROGRESS_WITHOUT_EMPLOYEE', id);
    expect(issue?.severity).toBe('WARNING');
  });

  // ---------------------------------------------------------------------------
  // EMPLOYEE_MULTIPLE_ACTIVE_SHIFTS
  //
  // Partial unique индекс не даст создать вторую активную смену через
  // обычный insert (см. ADR-0015) — но `groupBy` всё равно должен это
  // ловить в случае ручной правки. Тут мы создаём вторую смену в обход:
  // делаем активной уже существующую сразу после первой через
  // `update` на `endedAt = null`.
  // ---------------------------------------------------------------------------

  test('C. Несколько активных смен у одного сотрудника → CRITICAL', async () => {
    const employeeId = seed.employees['seamstress']!.id;
    const equipmentId = seed.equipment['overlock-01']!.id;
    const operationId = seed.operations.SEW_OVERLOCK_1!.id;

    // partial unique `shift_session_active_employee_uniq` (см.
    // ADR-0015) защищает БД от двух активных смен на одного человека.
    // Чтобы воспроизвести ручную SQL-правку, временно сносим индекс,
    // создаём второй активной смены, проверяем отчёт, потом
    // возвращаем индекс. Это ровно тот сценарий, ради которого
    // проверка `EMPLOYEE_MULTIPLE_ACTIVE_SHIFTS` и существует.
    await t.prisma.$executeRawUnsafe(
      'DROP INDEX IF EXISTS shift_session_active_employee_uniq',
    );
    try {
      await t.prisma.shiftSession.create({
        data: { employeeId, equipmentId, operationId, startedAt: new Date() },
      });
      await t.prisma.shiftSession.create({
        data: { employeeId, equipmentId, operationId, startedAt: new Date() },
      });

      const report = await fetchReport(t);
      const issue = findIssue(
        report,
        'EMPLOYEE_MULTIPLE_ACTIVE_SHIFTS',
        employeeId,
      );
      expect(issue, JSON.stringify(report.issues, null, 2)).toBeDefined();
      expect(issue?.severity).toBe('CRITICAL');
      expect(
        (issue?.context as { activeShiftCount: number }).activeShiftCount,
      ).toBe(2);
    } finally {
      // Возвращаем partial unique, чтобы следующий beforeEach смог
      // нормально применить TRUNCATE без конфликта индексов.
      await t.prisma.shiftSession.deleteMany({ where: { employeeId } });
      await t.prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS shift_session_active_employee_uniq ON "ShiftSession" ("employeeId") WHERE "endedAt" IS NULL',
      );
    }
  });

  // ---------------------------------------------------------------------------
  // ORDER_DONE_WITH_ACTIVE_PASSPORTS
  // ---------------------------------------------------------------------------

  test('D. Order DONE с активным паспортом → CRITICAL', async () => {
    const { id: passportId, orderId } = await makePassport(t, seed, {
      status: 'IN_PROGRESS',
      currentEmployeeId: seed.employees['seamstress']!.id,
    });
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'DONE' },
    });

    const report = await fetchReport(t);
    const issue = findIssue(report, 'ORDER_DONE_WITH_ACTIVE_PASSPORTS', orderId);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('CRITICAL');
    expect((issue?.context as { activePassports: number }).activePassports).toBeGreaterThanOrEqual(1);
    // А ещё на этот passport запишется PASSPORT_HAS_EMPLOYEE_BUT_NOT_IN_PROGRESS
    // не попадёт (он IN_PROGRESS), но C/D-проверки ловят оба угла.
    void passportId;
  });

  // ---------------------------------------------------------------------------
  // WORK_IN_PROGRESS_NEGATIVE
  // ---------------------------------------------------------------------------

  test('E. WorkInProgressBalance.qty < 0 → CRITICAL', async () => {
    // Создаём отрицательный баланс напрямую — нормальный flow его не
    // допускает (`applyMovementInTx` бросает `WIP_INSUFFICIENT_BALANCE`).
    // Тест ловит ситуацию ручной правки SQL / повреждённой миграции.
    const { orderId } = await makePassport(t, seed, {});
    const balance = await t.prisma.workInProgressBalance.create({
      data: {
        balanceKey: `${orderId}:${seed.product.id}:${seed.sizes.M!}:${seed.product.color}:NO_WAREHOUSE:${seed.cells.A1!.id}`,
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M!,
        color: seed.product.color,
        cellId: seed.cells.A1!.id,
        qty: -3,
      },
    });
    const report = await fetchReport(t);
    const issue = findIssue(report, 'WORK_IN_PROGRESS_NEGATIVE', balance.id);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('CRITICAL');
    expect((issue?.context as { qty: number }).qty).toBe(-3);
  });

  // ---------------------------------------------------------------------------
  // RBAC
  // ---------------------------------------------------------------------------

  test('F. RBAC: ADMIN и SHOP_MANAGER → 200', async () => {
    // ADMIN уже покрыт всеми тестами выше через t.adminCookie. Здесь —
    // SHOP_MANAGER из seed (роль `shop-chief`).
    const managerCookie = loginAs(t, seed.employees['shop-chief']!);
    const res = await request(t.app.getHttpServer())
      .get(ENDPOINT)
      .set('Cookie', managerCookie);
    expect(res.status).toBe(200);
  });

  test('F. RBAC: SEAMSTRESS / QC / IRONING / PACKING → 403', async () => {
    for (const login of ['seamstress', 'qc', 'ironing', 'packer'] as const) {
      const cookie = loginAs(t, seed.employees[login]!);
      const res = await request(t.app.getHttpServer())
        .get(ENDPOINT)
        .set('Cookie', cookie);
      expect(res.status, `role=${login}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  test('F. RBAC: DISPLAY → 403', async () => {
    const pinHash = await bcrypt.hash('display-pass', 4);
    const display = await t.prisma.employee.create({
      data: {
        login: 'rbac-display',
        fullName: 'RBAC Display',
        role: 'DISPLAY',
        active: true,
        pinHash,
      },
    });
    const cookie = loginAs(t, {
      id: display.id,
      login: display.login,
      role: display.role,
      fullName: display.fullName,
    });
    const res = await request(t.app.getHttpServer())
      .get(ENDPOINT)
      .set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  test('F. RBAC: без cookie → 401', async () => {
    const res = await request(t.app.getHttpServer()).get(ENDPOINT);
    expect(res.status).toBe(401);
  });
});
