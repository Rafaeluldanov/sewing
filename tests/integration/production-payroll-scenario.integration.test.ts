/**
 * Production payroll scenario runner.
 *
 * Это **opt-in** scenario test: vitest сам по себе его НЕ запускает,
 * пока не выставлен `RUN_PAYROLL_SCENARIO=1` (или
 * `PAYROLL_SCENARIO_CLEANUP_PREFIX=...`). При обычном
 * `npm run test:integration` сценарий тихо `describe.skip`-ается, чтобы
 * не плодить тестовые заказы и паспорта в test DB.
 *
 * Что делает запуск:
 *
 *   1. Проверяет жёсткие safety-гарды на `TEST_DATABASE_URL`
 *      (см. `assertSafeTestDatabaseUrl` ниже): без TEST_DATABASE_URL,
 *      совпадение с DATABASE_URL, prod/production/teeon_prod в URL
 *      или имя БД без `sewing_test`/`sewing_ci`/`test` — fatal.
 *   2. Поднимает Nest через `startTestApp` (тот же AppModule, что и
 *      production-flow тесты), идемпотентно прогоняет `seedMinimal`
 *      для reference-data (sizes, операции, equipment, cells,
 *      `MARKETPLACE`/`OTHER` divisions).
 *   3. Создаёт «уникально-префиксированные» entities (`payroll-flow-
 *      test-<timestamp>-...`): Product, Employees (cutter/seamstress/
 *      qc/ironing/packer/manager), Order (привязан к MARKETPLACE),
 *      Passport.
 *   4. Прогоняет паспорт через production flow, точно как
 *      `tests/integration/production-flow.test.ts §E+F`:
 *      seamstress shift → issue → scan → stop;
 *      qc shift → scan → complete;
 *      ironing shift → scan → complete;
 *      packer shift → создать box → addPassport → close box.
 *      Не использует `completeOperationByEmployee` для seamstress —
 *      см. RECON `docs/passport-piecework-payroll-recon.md §5`:
 *      complete снимает `currentEmployeeId`, и следующий scan теряет
 *      `previousEmployeeId`, что ломает создание сдельщины.
 *   5. Проверяет инварианты сдельщины и оклада, формирует
 *      классификацию (`OK_FULL_FLOW`/`MISSING_CUTTER_PIECEWORK`/...)
 *      и печатает stdout report.
 *   6. Если не выставлен `PAYROLL_SCENARIO_KEEP=1` — удаляет ровно
 *      свои записи по `prefix` (employees + product → cascade) в
 *      правильном порядке зависимостей.
 *
 * Если выставлен `PAYROLL_SCENARIO_CLEANUP_PREFIX=<prefix>` — сценарий
 * НЕ запускается, выполняется только cleanup того prefix-а и тест
 * сразу заканчивается. Это и есть «cleanup-only» режим.
 *
 * Никакого `TRUNCATE` сценарий не делает (в отличие от `resetDatabase`
 * в обычных integration-тестах) — он не имеет права уничтожать
 * чужие записи.
 */
// !!! IMPORTANT IMPORT ORDER !!!
// We snapshot ORIGINAL DATABASE_URL and set DATABASE_URL = TEST_DATABASE_URL
// in this module's TOP-LEVEL **before** importing anything that triggers
// AppModule/Nest DI. tests/utils/db.ts ALSO mutates process.env.DATABASE_URL
// at module-load time, so we deliberately DO NOT import from it — otherwise
// our snapshot would race the mutation and the equality guard would
// always trip in dev environments where DATABASE_URL=TEST_DATABASE_URL.
const __ORIG_DATABASE_URL__ = process.env.DATABASE_URL ?? '';
const __TEST_DATABASE_URL__ = process.env.TEST_DATABASE_URL ?? '';
if (__TEST_DATABASE_URL__) {
  process.env.DATABASE_URL = __TEST_DATABASE_URL__;
  process.env.JWT_SECRET ??= 'test-secret-please-do-not-use-in-prod';
  process.env.JWT_EXPIRES_IN ??= '1h';
}

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { seedMinimal, type SeedResult } from '../utils/seed';

const TEST_DATABASE_URL = __TEST_DATABASE_URL__ || undefined;

// ---------------------------------------------------------------------------
// Opt-in / cleanup-only gating
// ---------------------------------------------------------------------------

const SCENARIO_FLAG = process.env.RUN_PAYROLL_SCENARIO === '1';
const CLEANUP_PREFIX = process.env.PAYROLL_SCENARIO_CLEANUP_PREFIX?.trim();
const SCENARIO_ENABLED =
  Boolean(TEST_DATABASE_URL) && (SCENARIO_FLAG || Boolean(CLEANUP_PREFIX));

const describeFn = SCENARIO_ENABLED ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Safety guards
// ---------------------------------------------------------------------------

/**
 * Жёсткие гарды на TEST_DATABASE_URL:
 *
 *   1. `TEST_DATABASE_URL` обязателен.
 *   2. Не совпадает с _оригинальным_ `DATABASE_URL` процесса
 *      (`__ORIG_DATABASE_URL__`, snapshot снят до side-effect-импортов
 *      выше). Это страхует от случая «забыл обнулить DATABASE_URL,
 *      оба указывают на прод». Если у разработчика локально
 *      `DATABASE_URL = TEST_DATABASE_URL = sewing_test`, нужно
 *      явно обнулить:
 *        `DATABASE_URL='' TEST_DATABASE_URL=... npm run ...`.
 *   3. URL не содержит токенов `prod` / `production` / `teeon_prod`
 *      (case-insensitive).
 *   4. Имя БД содержит `sewing_test` / `sewing_ci` / `test`.
 *
 * Любая проверка падает — `throw`, без выполнения сценария.
 */
function assertSafeTestDatabaseUrl(): { url: string; dbName: string } {
  const url = TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'FATAL: TEST_DATABASE_URL is required for production-payroll-scenario.',
    );
  }
  if (__ORIG_DATABASE_URL__ && url === __ORIG_DATABASE_URL__) {
    throw new Error(
      'FATAL: TEST_DATABASE_URL === DATABASE_URL (refusing to run on prod/dev DB). ' +
        'Run with `DATABASE_URL="" TEST_DATABASE_URL=... npm run ...` to opt in.',
    );
  }
  const lower = url.toLowerCase();
  for (const banned of ['prod', 'production', 'teeon_prod']) {
    if (lower.includes(banned)) {
      throw new Error(
        `FATAL: TEST_DATABASE_URL contains banned token "${banned}".`,
      );
    }
  }
  const match = url.match(/\/([^/?]+)(\?|$)/);
  const dbName = match?.[1] ?? '';
  const dbLower = dbName.toLowerCase();
  if (
    !dbLower.includes('sewing_test') &&
    !dbLower.includes('sewing_ci') &&
    !dbLower.includes('test')
  ) {
    throw new Error(
      `FATAL: DB name "${dbName}" must contain "sewing_test", "sewing_ci", or "test".`,
    );
  }
  return { url, dbName };
}

// ---------------------------------------------------------------------------
// Prefix
// ---------------------------------------------------------------------------

function buildPrefix(): string {
  // ISO timestamp, безопасный для login/code (без `:`/`.`).
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `payroll-flow-test-${ts}`;
}

// ---------------------------------------------------------------------------
// Scenario data shapes
// ---------------------------------------------------------------------------

interface ReportEmployee {
  id: string;
  login: string;
  role: string;
  compensationType: string;
  salaryPerShift: number | null;
}

interface ScenarioReport {
  prefix: string;
  testDatabase: { url: string; dbName: string };
  product: { id: string; name: string };
  order: { id: string; number: string; companyDivisionCode: string | null };
  passport: { id: string; number: string; status: string; qtyCut: number; qtyGood: number };
  box: { id: string; number: string; closedAt: string | null };
  employees: {
    manager: ReportEmployee;
    cutter: ReportEmployee;
    seamstress: ReportEmployee;
    qc: ReportEmployee;
    ironing: ReportEmployee;
    packer: ReportEmployee;
  };
  operations: {
    CUT_CUT: { id: string; pricingMode: string; fixedRate: number | null };
    SEW_OVERLOCK_1: { id: string; pricingMode: string; rateForSize: number | null };
    QC: { id: string; pricingMode: string };
    IRONING: { id: string; pricingMode: string };
    PACKING: { id: string; pricingMode: string };
  };
  invariants: {
    cutterEntryCreatedBeforeAnyScan: boolean;
    sewingEntryPendingBeforeClose: boolean;
    sewingEntryApprovedAfterClose: boolean;
  };
  operationEntries: Array<{
    id: string;
    sourceEventType: string;
    employeeId: string;
    employeeRole: string;
    operationCode: string;
    status: string;
    approvalMode: string;
    qty: number;
    ratePerUnit: number;
    amount: number;
    approvedAt: string | null;
  }>;
  salaryEntries: Array<{
    id: string;
    employeeId: string;
    employeeRole: string;
    source: string;
    date: string;
    amount: number;
  }>;
  payroll: {
    period: { dateFrom: string; dateTo: string };
    rows: Array<{
      employeeId: string;
      role: string;
      pieceworkApprovedRub: number;
      pieceworkPendingRub: number;
      salaryRub: number;
      totalApprovedRub: number;
      totalPendingRub: number;
      totalRub: number;
      payoutCoveredRub: number;
    }>;
    summary: {
      totalApprovedRub: number;
      totalPendingRub: number;
      pieceworkRub: number;
      salaryRub: number;
      totalPayoutCoveredRub: number;
    };
  };
  classification: ScenarioClassification;
}

type ScenarioClassification =
  | 'OK_FULL_FLOW'
  | 'MISSING_CUTTER_PIECEWORK'
  | 'MISSING_SEWING_PIECEWORK'
  | 'EXPECTED_PENDING_BEFORE_CLOSE'
  | 'PAYROLL_FILTER_BUG'
  | 'RATE_SETUP_PROBLEM'
  | 'COMPENSATION_SETUP_PROBLEM';

// ---------------------------------------------------------------------------
// Helpers — actor creation
// ---------------------------------------------------------------------------

const SCENARIO_PIN = 'TestPass!1';

type ActorKey = 'manager' | 'cutter' | 'seamstress' | 'qc' | 'ironing' | 'packer';

async function createScenarioEmployees(
  t: TestApp,
  prefix: string,
): Promise<Record<ActorKey, ReportEmployee>> {
  const pinHash = await bcrypt.hash(SCENARIO_PIN, 4);
  type Spec = {
    key: ActorKey;
    role: Role;
    compensationType: 'PIECEWORK' | 'SALARY' | 'MIXED';
    salaryPerShift: number | null;
  };
  const specs: Spec[] = [
    { key: 'manager', role: 'SHOP_MANAGER', compensationType: 'SALARY', salaryPerShift: 1500 },
    { key: 'cutter', role: 'CUTTER', compensationType: 'PIECEWORK', salaryPerShift: null },
    { key: 'seamstress', role: 'SEAMSTRESS', compensationType: 'MIXED', salaryPerShift: 1000 },
    { key: 'qc', role: 'QC', compensationType: 'SALARY', salaryPerShift: 900 },
    { key: 'ironing', role: 'IRONING', compensationType: 'SALARY', salaryPerShift: 900 },
    { key: 'packer', role: 'PACKING', compensationType: 'SALARY', salaryPerShift: 900 },
  ];
  const out = {} as Record<ActorKey, ReportEmployee>;
  for (const s of specs) {
    const login = `${prefix}-${s.key}`;
    const fullName = `${prefix} ${s.key}`;
    const created = await t.prisma.employee.create({
      data: {
        login,
        fullName,
        role: s.role,
        compensationType: s.compensationType,
        salaryPerShift:
          s.salaryPerShift === null ? null : new Prisma.Decimal(s.salaryPerShift),
        active: true,
        pinHash,
      },
    });
    out[s.key] = {
      id: created.id,
      login: created.login,
      role: created.role,
      compensationType: created.compensationType,
      salaryPerShift: s.salaryPerShift,
    };
  }
  return out;
}

function actorAuth(emp: ReportEmployee): {
  id: string;
  role: Role;
  login: string;
  fullName: string;
} {
  return {
    id: emp.id,
    role: emp.role as Role,
    login: emp.login,
    fullName: emp.login,
  };
}

// ---------------------------------------------------------------------------
// Helpers — flow steps via HTTP (matching production-flow.test.ts §E+F)
// ---------------------------------------------------------------------------

async function startShift(
  t: TestApp,
  cookie: string,
  equipmentId: string,
  operationId: string,
): Promise<void> {
  await request(t.app.getHttpServer())
    .post('/api/shifts/start')
    .set('Cookie', cookie)
    .send({ equipmentId, operationId })
    .expect(201);
}

async function stopShift(t: TestApp, cookie: string): Promise<void> {
  await request(t.app.getHttpServer())
    .post('/api/shifts/stop')
    .set('Cookie', cookie)
    .send({})
    .expect(201);
}

async function scan(t: TestApp, cookie: string, passportId: string): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/passports/${passportId}/scan`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
}

async function issue(t: TestApp, cookie: string, passportId: string): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/passports/${passportId}/issue`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
}

async function place(
  t: TestApp,
  cookie: string,
  passportId: string,
  cellId: string,
): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/passports/${passportId}/place`)
    .set('Cookie', cookie)
    .send({ cellId })
    .expect(201);
}

// ---------------------------------------------------------------------------
// Helpers — db queries
// ---------------------------------------------------------------------------

async function fetchOperationEntries(
  prisma: PrismaClient,
  passportId: string,
  employees: Map<string, string>,
): Promise<ScenarioReport['operationEntries']> {
  const rows = await prisma.operationEntry.findMany({
    where: { passportId },
    orderBy: { createdAt: 'asc' },
    include: {
      operation: { select: { code: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    sourceEventType: r.sourceEventType,
    employeeId: r.employeeId,
    employeeRole: employees.get(r.employeeId) ?? 'UNKNOWN',
    operationCode: r.operation.code,
    status: r.status,
    approvalMode: r.approvalMode,
    qty: r.qty,
    ratePerUnit: Number(r.ratePerUnit.toFixed(2)),
    amount: Number(r.amount.toFixed(2)),
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
  }));
}

async function fetchSalaryEntries(
  prisma: PrismaClient,
  employeeIds: string[],
  employees: Map<string, string>,
): Promise<ScenarioReport['salaryEntries']> {
  const rows = await prisma.salaryEntry.findMany({
    where: { employeeId: { in: employeeIds } },
    orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeRole: employees.get(r.employeeId) ?? 'UNKNOWN',
    source: r.source,
    date: r.date.toISOString().slice(0, 10),
    amount: Number(r.amount.toFixed(2)),
  }));
}

// ---------------------------------------------------------------------------
// Helpers — cleanup
// ---------------------------------------------------------------------------

interface CleanupCounts {
  AuditLog: number;
  PayrollPayoutLine: number;
  PayrollPayout: number;
  OperationEntry: number;
  SalaryEntry: number;
  BoxItem: number;
  Box: number;
  PassportEvent: number;
  PassportDefect: number;
  Passport: number;
  ShiftSession: number;
  Order: number;
  Product: number;
  Employee: number;
}

/**
 * Удаляет ровно записи, созданные сценарием с этим `prefix`. Найден
 * через:
 *   - `Employee.login` startsWith `${prefix}-`,
 *   - `Product.name` startsWith `${prefix} `.
 * Дальше идём вверх по зависимостям (Order через OrderItem.productId,
 * Passport через productId, Box через BoxItem.passportId, и т.д.) и
 * удаляем в обратном порядке. Если ни одной записи нет — вернёт нули.
 */
async function cleanupByPrefix(
  prisma: PrismaClient,
  prefix: string,
): Promise<CleanupCounts> {
  const employees = await prisma.employee.findMany({
    where: { login: { startsWith: `${prefix}-` } },
    select: { id: true },
  });
  const employeeIds = employees.map((e) => e.id);

  const products = await prisma.product.findMany({
    where: { name: { startsWith: `${prefix} ` } },
    select: { id: true },
  });
  const productIds = products.map((p) => p.id);

  const passports = productIds.length
    ? await prisma.passport.findMany({
        where: { productId: { in: productIds } },
        select: { id: true },
      })
    : [];
  const passportIds = passports.map((p) => p.id);

  const orderItems = productIds.length
    ? await prisma.orderItem.findMany({
        where: { productId: { in: productIds } },
        select: { orderId: true },
      })
    : [];
  const orderIds = Array.from(new Set(orderItems.map((it) => it.orderId)));

  const boxItems = passportIds.length
    ? await prisma.boxItem.findMany({
        where: { passportId: { in: passportIds } },
        select: { boxId: true },
      })
    : [];
  const boxIds = Array.from(new Set(boxItems.map((b) => b.boxId)));

  const counts: CleanupCounts = {
    AuditLog: 0,
    PayrollPayoutLine: 0,
    PayrollPayout: 0,
    OperationEntry: 0,
    SalaryEntry: 0,
    BoxItem: 0,
    Box: 0,
    PassportEvent: 0,
    PassportDefect: 0,
    Passport: 0,
    ShiftSession: 0,
    Order: 0,
    Product: 0,
    Employee: 0,
  };

  await prisma.$transaction(async (tx) => {
    // PayrollPayout(Line): по employeeId сценария.
    if (employeeIds.length) {
      const ppls = await tx.payrollPayoutLine.deleteMany({
        where: { payout: { employeeId: { in: employeeIds } } },
      });
      counts.PayrollPayoutLine += ppls.count;
      const pps = await tx.payrollPayout.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      counts.PayrollPayout += pps.count;
    }
    // OperationEntry: по passportId или employeeId.
    if (passportIds.length || employeeIds.length) {
      const oes = await tx.operationEntry.deleteMany({
        where: {
          OR: [
            passportIds.length ? { passportId: { in: passportIds } } : undefined,
            employeeIds.length ? { employeeId: { in: employeeIds } } : undefined,
          ].filter(Boolean) as Prisma.OperationEntryWhereInput[],
        },
      });
      counts.OperationEntry += oes.count;
    }
    // SalaryEntry: по employeeId.
    if (employeeIds.length) {
      const ses = await tx.salaryEntry.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      counts.SalaryEntry += ses.count;
    }
    // Box / BoxItem.
    if (boxIds.length) {
      const bis = await tx.boxItem.deleteMany({
        where: { boxId: { in: boxIds } },
      });
      counts.BoxItem += bis.count;
      const bxs = await tx.box.deleteMany({
        where: { id: { in: boxIds } },
      });
      counts.Box += bxs.count;
    }
    // PassportEvent / PassportDefect / Passport.
    if (passportIds.length) {
      const pds = await tx.passportDefect.deleteMany({
        where: { passportId: { in: passportIds } },
      });
      counts.PassportDefect += pds.count;
      const pes = await tx.passportEvent.deleteMany({
        where: { passportId: { in: passportIds } },
      });
      counts.PassportEvent += pes.count;
      const pas = await tx.passport.deleteMany({
        where: { id: { in: passportIds } },
      });
      counts.Passport += pas.count;
    }
    // ShiftSession: по employeeId.
    if (employeeIds.length) {
      const shs = await tx.shiftSession.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      counts.ShiftSession += shs.count;
    }
    // Order — каскад снесёт OrderItem / OrderRouteStep / WorkshopNeed
    // и т.п. (см. `prisma/schema.prisma` ON DELETE CASCADE).
    if (orderIds.length) {
      const ords = await tx.order.deleteMany({
        where: { id: { in: orderIds } },
      });
      counts.Order += ords.count;
    }
    // Product.
    if (productIds.length) {
      const prods = await tx.product.deleteMany({
        where: { id: { in: productIds } },
      });
      counts.Product += prods.count;
    }
    // AuditLog: best-effort по entityId (free-form String, без FK) и
    // employeeId. Делаем последним — после удаления сущностей, на
    // которые ссылается audit, его уже не на что чистить «ничего».
    if (employeeIds.length || passportIds.length || orderIds.length || boxIds.length || productIds.length) {
      const orFilter: Prisma.AuditLogWhereInput[] = [];
      if (employeeIds.length) {
        orFilter.push({ entityId: { in: employeeIds } });
        orFilter.push({ employeeId: { in: employeeIds } });
      }
      if (passportIds.length) orFilter.push({ entityId: { in: passportIds } });
      if (orderIds.length) orFilter.push({ entityId: { in: orderIds } });
      if (boxIds.length) orFilter.push({ entityId: { in: boxIds } });
      if (productIds.length) orFilter.push({ entityId: { in: productIds } });
      const al = await tx.auditLog.deleteMany({ where: { OR: orFilter } });
      counts.AuditLog += al.count;
    }
    // Employee — последним (passport/cutter FK уже снят).
    if (employeeIds.length) {
      const emps = await tx.employee.deleteMany({
        where: { id: { in: employeeIds } },
      });
      counts.Employee += emps.count;
    }
  });

  return counts;
}

// ---------------------------------------------------------------------------
// Helpers — report classification + printing
// ---------------------------------------------------------------------------

function classify(report: Omit<ScenarioReport, 'classification'>): ScenarioClassification {
  const { invariants, operationEntries } = report;
  const cutterEntry = operationEntries.find(
    (e) => e.sourceEventType === 'PASSPORT_CREATED' && e.operationCode === 'CUT_CUT',
  );
  const sewingEntry = operationEntries.find(
    (e) => e.sourceEventType === 'OPERATION_TRANSITION' && e.operationCode === 'SEW_OVERLOCK_1',
  );
  if (!cutterEntry) return 'MISSING_CUTTER_PIECEWORK';
  if (!sewingEntry) return 'MISSING_SEWING_PIECEWORK';
  if (cutterEntry.amount === 0 || sewingEntry.amount === 0) return 'RATE_SETUP_PROBLEM';
  if (!invariants.cutterEntryCreatedBeforeAnyScan) return 'MISSING_CUTTER_PIECEWORK';
  if (!invariants.sewingEntryPendingBeforeClose) return 'COMPENSATION_SETUP_PROBLEM';
  if (!invariants.sewingEntryApprovedAfterClose) return 'EXPECTED_PENDING_BEFORE_CLOSE';
  // Payroll: cutter approved + sewing approved должны попасть в approved.
  const cutterRow = report.payroll.rows.find((r) => r.employeeId === cutterEntry.employeeId);
  const sewingRow = report.payroll.rows.find((r) => r.employeeId === sewingEntry.employeeId);
  if (!cutterRow || cutterRow.pieceworkApprovedRub <= 0) return 'PAYROLL_FILTER_BUG';
  if (!sewingRow || sewingRow.pieceworkApprovedRub <= 0) return 'PAYROLL_FILTER_BUG';
  return 'OK_FULL_FLOW';
}

function printReport(r: ScenarioReport): void {
  const lines: string[] = [];
  const sep = '='.repeat(70);
  lines.push(sep);
  lines.push('PAYROLL FLOW TEST SCENARIO — REPORT');
  lines.push(sep);
  lines.push(`testPrefix:       ${r.prefix}`);
  lines.push(`TEST_DATABASE_URL: <redacted>`);
  lines.push(`db name:          ${r.testDatabase.dbName}`);
  lines.push('');
  lines.push('CREATED ENTITIES');
  lines.push(`  product:   ${r.product.id}  (name="${r.product.name}")`);
  lines.push(
    `  order:     ${r.order.id}  number=${r.order.number} division=${r.order.companyDivisionCode ?? '<null>'}`,
  );
  lines.push(
    `  passport:  ${r.passport.id}  number=${r.passport.number} status=${r.passport.status} qtyCut=${r.passport.qtyCut} qtyGood=${r.passport.qtyGood}`,
  );
  lines.push(
    `  box:       ${r.box.id}  number=${r.box.number} closedAt=${r.box.closedAt ?? '<null>'}`,
  );
  lines.push('');
  lines.push('EMPLOYEES (prefixed)');
  for (const key of ['manager', 'cutter', 'seamstress', 'qc', 'ironing', 'packer'] as const) {
    const e = r.employees[key];
    const sps =
      e.salaryPerShift !== null && e.salaryPerShift !== undefined
        ? ` salaryPerShift=${e.salaryPerShift}`
        : '';
    lines.push(
      `  ${key.padEnd(11)} ${e.id}  login=${e.login} role=${e.role} comp=${e.compensationType}${sps}`,
    );
  }
  lines.push('');
  lines.push('OPERATIONS (existing seed-reference, not created)');
  lines.push(
    `  CUT_CUT          ${r.operations.CUT_CUT.id}  ${r.operations.CUT_CUT.pricingMode} fixedRate=${r.operations.CUT_CUT.fixedRate}`,
  );
  lines.push(
    `  SEW_OVERLOCK_1   ${r.operations.SEW_OVERLOCK_1.id}  ${r.operations.SEW_OVERLOCK_1.pricingMode} rate(M)=${r.operations.SEW_OVERLOCK_1.rateForSize}`,
  );
  lines.push(`  QC               ${r.operations.QC.id}  ${r.operations.QC.pricingMode}`);
  lines.push(`  IRONING          ${r.operations.IRONING.id}  ${r.operations.IRONING.pricingMode}`);
  lines.push(`  PACKING          ${r.operations.PACKING.id}  ${r.operations.PACKING.pricingMode}`);
  lines.push('');
  lines.push('INVARIANTS');
  lines.push(`  cutterEntryCreatedBeforeAnyScan: ${r.invariants.cutterEntryCreatedBeforeAnyScan}`);
  lines.push(`  sewingEntryPendingBeforeClose:   ${r.invariants.sewingEntryPendingBeforeClose}`);
  lines.push(`  sewingEntryApprovedAfterClose:   ${r.invariants.sewingEntryApprovedAfterClose}`);
  lines.push('');
  lines.push(`OPERATION_ENTRIES (${r.operationEntries.length})`);
  if (r.operationEntries.length === 0) {
    lines.push('  <none>');
  } else {
    lines.push(
      '  source                | role         | op                | status          | qty | rate | amount | approvedAt',
    );
    for (const e of r.operationEntries) {
      lines.push(
        `  ${e.sourceEventType.padEnd(20)} | ${e.employeeRole.padEnd(12)} | ${e.operationCode.padEnd(17)} | ${e.status.padEnd(15)} | ${String(
          e.qty,
        ).padStart(3)} | ${String(e.ratePerUnit).padStart(4)} | ${String(e.amount).padStart(6)} | ${e.approvedAt ?? '<null>'}`,
      );
    }
  }
  lines.push('');
  lines.push(`SALARY_ENTRIES (${r.salaryEntries.length})`);
  if (r.salaryEntries.length === 0) {
    lines.push('  <none>');
  } else {
    lines.push('  role         | source     | date       | amount');
    for (const s of r.salaryEntries) {
      lines.push(
        `  ${s.employeeRole.padEnd(12)} | ${s.source.padEnd(10)} | ${s.date} | ${s.amount}`,
      );
    }
  }
  lines.push('');
  lines.push(`PAYROLL period ${r.payroll.period.dateFrom}..${r.payroll.period.dateTo}`);
  if (r.payroll.rows.length === 0) {
    lines.push('  <no rows>');
  } else {
    lines.push(
      '  role         | piecework_approved | pending | salary | total_approved | total | covered',
    );
    for (const row of r.payroll.rows) {
      lines.push(
        `  ${row.role.padEnd(12)} | ${String(row.pieceworkApprovedRub).padStart(18)} | ${String(
          row.pieceworkPendingRub,
        ).padStart(7)} | ${String(row.salaryRub).padStart(6)} | ${String(row.totalApprovedRub).padStart(14)} | ${String(
          row.totalRub,
        ).padStart(5)} | ${String(row.payoutCoveredRub).padStart(7)}`,
      );
    }
  }
  lines.push('');
  lines.push('PAYROLL summary');
  lines.push(`  totalApprovedRub:      ${r.payroll.summary.totalApprovedRub}`);
  lines.push(`  totalPendingRub:       ${r.payroll.summary.totalPendingRub}`);
  lines.push(`  pieceworkRub:          ${r.payroll.summary.pieceworkRub}`);
  lines.push(`  salaryRub:             ${r.payroll.summary.salaryRub}`);
  lines.push(`  totalPayoutCoveredRub: ${r.payroll.summary.totalPayoutCoveredRub}`);
  lines.push('');
  lines.push(`CLASSIFICATION: ${r.classification}`);
  lines.push(sep);
  // Один блок stdout — vitest сохраняет console.log целиком.
  // eslint-disable-next-line no-console
  console.log(`\n${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Scenario itself
// ---------------------------------------------------------------------------

async function runScenario(t: TestApp, prefix: string, dbName: string): Promise<ScenarioReport> {
  // 1. Идемпотентный seed reference-data.
  const seed: SeedResult = await seedMinimal(t.prisma);
  await refreshAdminCookie(t);

  // 2. Префиксированные actors.
  const employees = await createScenarioEmployees(t, prefix);
  const cookies = {
    manager: loginAs(t, actorAuth(employees.manager)),
    seamstress: loginAs(t, actorAuth(employees.seamstress)),
    qc: loginAs(t, actorAuth(employees.qc)),
    ironing: loginAs(t, actorAuth(employees.ironing)),
    packer: loginAs(t, actorAuth(employees.packer)),
  };
  const employeeRoleById = new Map<string, string>([
    [employees.manager.id, 'manager'],
    [employees.cutter.id, 'cutter'],
    [employees.seamstress.id, 'seamstress'],
    [employees.qc.id, 'qc'],
    [employees.ironing.id, 'ironing'],
    [employees.packer.id, 'packer'],
  ]);

  // 3. Префиксированный продукт.
  const product = await t.prisma.product.create({
    data: { name: `${prefix} Test Tee`, color: 'Белая', active: true },
  });

  // 4. Заказ привязываем к MARKETPLACE division — нужен MARKETPLACE_FIXED
  // schema, чтобы cutter сразу получил APPROVED по CUT_CUT.fixedRate=10
  // (см. `EarningsService.createImmediateForCutterMarketplace`).
  const orderRes = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookies.manager)
    .send({
      orderDate: new Date().toISOString(),
      productId: product.id,
      companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
    });
  expect(orderRes.status).toBe(201);
  const orderId: string = orderRes.body.id;
  const orderNumber: string = orderRes.body.number;

  await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/start`)
    .set('Cookie', cookies.manager)
    .expect(201);

  // 5. Паспорт через API под manager-сессией с явным cutterId
  // (PHASE 2 STEP 3: для не-CUTTER ролей `cutterId` обязателен).
  const passportRes = await request(t.app.getHttpServer())
    .post('/api/passports')
    .set('Cookie', cookies.manager)
    .send({
      orderId,
      sizeId: seed.sizes.M,
      rollNumber: `${prefix}-R-1`,
      cutDate: new Date().toISOString(),
      qtyCut: 3,
      cutterId: employees.cutter.id,
    });
  expect(passportRes.status).toBe(201);
  const passportId: string = passportRes.body.id;
  const passportNumber: string = passportRes.body.number;

  // Снимок «до scan-ов»: cutter immediate-entry должна уже быть APPROVED.
  const cutterEntriesBefore = await t.prisma.operationEntry.findMany({
    where: { passportId, employeeId: employees.cutter.id },
  });
  const cutterEntryCreatedBeforeAnyScan = cutterEntriesBefore.length === 1
    && cutterEntriesBefore[0]!.status === 'APPROVED'
    && cutterEntriesBefore[0]!.sourceEventType === 'PASSPORT_CREATED';

  // 6. Place в seed cell.
  await place(t, cookies.manager, passportId, seed.cells.A1.id);

  // 7. Seamstress: shift → issue → scan → stop. Не используем
  // completeOperationByEmployee (см. recon §5).
  await startShift(
    t,
    cookies.seamstress,
    seed.equipment['overlock-01'].id,
    seed.operations.SEW_OVERLOCK_1.id,
  );
  await issue(t, cookies.seamstress, passportId);
  await scan(t, cookies.seamstress, passportId);
  await stopShift(t, cookies.seamstress);

  // 8. QC: scan + complete.
  await startShift(
    t,
    cookies.qc,
    seed.equipment['qc-station-01'].id,
    seed.operations.QC.id,
  );
  await scan(t, cookies.qc, passportId);
  await request(t.app.getHttpServer())
    .post(`/api/qc/passports/${passportId}/complete`)
    .set('Cookie', cookies.qc)
    .send({})
    .expect(201);
  await stopShift(t, cookies.qc);

  // 9. IRONING: scan + complete.
  await startShift(
    t,
    cookies.ironing,
    seed.equipment['ironing-station-01'].id,
    seed.operations.IRONING.id,
  );
  await scan(t, cookies.ironing, passportId);
  await request(t.app.getHttpServer())
    .post(`/api/wto/passports/${passportId}/complete`)
    .set('Cookie', cookies.ironing)
    .send({})
    .expect(201);
  await stopShift(t, cookies.ironing);

  // 10. PACKING: shift, box create, addPassport, close.
  await startShift(
    t,
    cookies.packer,
    seed.equipment['packing-station-01'].id,
    seed.operations.PACKING.id,
  );
  const boxRes = await request(t.app.getHttpServer())
    .post('/api/packing/boxes')
    .set('Cookie', cookies.packer)
    .send({})
    .expect(201);
  const boxId: string = boxRes.body.id;
  const boxNumber: string = boxRes.body.number;
  await request(t.app.getHttpServer())
    .post(`/api/packing/boxes/${boxId}/add-passport`)
    .set('Cookie', cookies.packer)
    .send({ code: passportId })
    .expect(201);

  // Снимок «до close»: sewing-entry должна быть PENDING_RELEASE.
  const sewingEntriesBeforeClose = await t.prisma.operationEntry.findMany({
    where: {
      passportId,
      employeeId: employees.seamstress.id,
      sourceEventType: 'OPERATION_TRANSITION',
    },
  });
  const sewingEntryPendingBeforeClose =
    sewingEntriesBeforeClose.length === 1 &&
    (sewingEntriesBeforeClose[0]!.status === 'PENDING_RELEASE' ||
      sewingEntriesBeforeClose[0]!.status === 'PENDING') &&
    sewingEntriesBeforeClose[0]!.approvedAt === null;

  // close box → approvePendingForPassport.
  const closeRes = await request(t.app.getHttpServer())
    .post(`/api/packing/boxes/${boxId}/close`)
    .set('Cookie', cookies.packer)
    .send({})
    .expect(201);
  await stopShift(t, cookies.packer);

  // Снимок «после close»: sewing-entry APPROVED.
  const sewingEntriesAfterClose = await t.prisma.operationEntry.findMany({
    where: {
      passportId,
      employeeId: employees.seamstress.id,
      sourceEventType: 'OPERATION_TRANSITION',
    },
  });
  const sewingEntryApprovedAfterClose =
    sewingEntriesAfterClose.length === 1 &&
    sewingEntriesAfterClose[0]!.status === 'APPROVED' &&
    sewingEntriesAfterClose[0]!.approvedAt !== null;

  // 11. Финальные снимки.
  const finalPassport = await t.prisma.passport.findUnique({
    where: { id: passportId },
    select: { id: true, number: true, status: true, qtyCut: true, qtyGood: true },
  });
  if (!finalPassport) throw new Error('passport disappeared after close');

  const opEntries = await fetchOperationEntries(t.prisma, passportId, employeeRoleById);
  const allEmployeeIds = Object.values(employees).map((e) => e.id);
  const salEntries = await fetchSalaryEntries(t.prisma, allEmployeeIds, employeeRoleById);

  // 12. Payroll: вызываем тот же `/api/payroll/period`, который видит UI.
  // Период — текущий день +/- 7 дней, чтобы на любых таймзонах захватить
  // только что созданные начисления.
  const today = new Date();
  const dateFrom = new Date(today.getTime() - 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const dateTo = new Date(today.getTime() + 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const periodRes = await request(t.app.getHttpServer())
    .get('/api/payroll/period')
    .query({ dateFrom, dateTo, page: 1, pageSize: 100 })
    .set('Cookie', cookies.manager)
    .expect(200);

  const periodRows: ScenarioReport['payroll']['rows'] = (periodRes.body.items ?? [])
    .filter((it: { employeeId: string }) => allEmployeeIds.includes(it.employeeId))
    .map((it: {
      employeeId: string;
      role: string;
      pieceworkApprovedRub: number;
      pieceworkPendingRub: number;
      salaryRub: number;
      totalApprovedRub: number;
      totalPendingRub: number;
      totalRub: number;
      payoutCoveredRub: number;
    }) => ({
      employeeId: it.employeeId,
      role: employeeRoleById.get(it.employeeId) ?? it.role,
      pieceworkApprovedRub: it.pieceworkApprovedRub,
      pieceworkPendingRub: it.pieceworkPendingRub,
      salaryRub: it.salaryRub,
      totalApprovedRub: it.totalApprovedRub,
      totalPendingRub: it.totalPendingRub,
      totalRub: it.totalRub,
      payoutCoveredRub: it.payoutCoveredRub,
    }));
  const periodSummary = {
    totalApprovedRub: periodRows.reduce((s, r) => s + r.totalApprovedRub, 0),
    totalPendingRub: periodRows.reduce((s, r) => s + r.totalPendingRub, 0),
    pieceworkRub: periodRows.reduce(
      (s, r) => s + r.pieceworkApprovedRub + r.pieceworkPendingRub,
      0,
    ),
    salaryRub: periodRows.reduce((s, r) => s + r.salaryRub, 0),
    totalPayoutCoveredRub: periodRows.reduce((s, r) => s + r.payoutCoveredRub, 0),
  };

  // 13. Operation rate snapshot for report.
  const cutCut = await t.prisma.operation.findUnique({
    where: { id: seed.operations.CUT_CUT.id },
    select: { id: true, pricingMode: true, fixedRate: true },
  });
  const sewing = await t.prisma.operation.findUnique({
    where: { id: seed.operations.SEW_OVERLOCK_1.id },
    select: { id: true, pricingMode: true },
  });
  const sewingRate = await t.prisma.operationRateBySize.findUnique({
    where: {
      OperationRateBySize_operation_size_uniq: {
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        sizeId: seed.sizes.M,
      },
    },
    select: { rate: true },
  });
  const qcOp = await t.prisma.operation.findUnique({
    where: { id: seed.operations.QC.id },
    select: { id: true, pricingMode: true },
  });
  const ironOp = await t.prisma.operation.findUnique({
    where: { id: seed.operations.IRONING.id },
    select: { id: true, pricingMode: true },
  });
  const packOp = await t.prisma.operation.findUnique({
    where: { id: seed.operations.PACKING.id },
    select: { id: true, pricingMode: true },
  });

  const reportShell: Omit<ScenarioReport, 'classification'> = {
    prefix,
    testDatabase: { url: '<redacted>', dbName },
    product: { id: product.id, name: product.name },
    order: {
      id: orderId,
      number: orderNumber,
      companyDivisionCode: 'MARKETPLACE',
    },
    passport: {
      id: finalPassport.id,
      number: finalPassport.number,
      status: finalPassport.status,
      qtyCut: finalPassport.qtyCut,
      qtyGood: finalPassport.qtyGood,
    },
    box: {
      id: boxId,
      number: boxNumber,
      closedAt: closeRes.body.closedAt ?? null,
    },
    employees: {
      manager: employees.manager,
      cutter: employees.cutter,
      seamstress: employees.seamstress,
      qc: employees.qc,
      ironing: employees.ironing,
      packer: employees.packer,
    },
    operations: {
      CUT_CUT: {
        id: cutCut?.id ?? seed.operations.CUT_CUT.id,
        pricingMode: cutCut?.pricingMode ?? 'UNKNOWN',
        fixedRate: cutCut?.fixedRate ? Number(cutCut.fixedRate.toFixed(2)) : null,
      },
      SEW_OVERLOCK_1: {
        id: sewing?.id ?? seed.operations.SEW_OVERLOCK_1.id,
        pricingMode: sewing?.pricingMode ?? 'UNKNOWN',
        rateForSize: sewingRate?.rate ? Number(sewingRate.rate.toFixed(2)) : null,
      },
      QC: { id: qcOp?.id ?? seed.operations.QC.id, pricingMode: qcOp?.pricingMode ?? 'UNKNOWN' },
      IRONING: {
        id: ironOp?.id ?? seed.operations.IRONING.id,
        pricingMode: ironOp?.pricingMode ?? 'UNKNOWN',
      },
      PACKING: {
        id: packOp?.id ?? seed.operations.PACKING.id,
        pricingMode: packOp?.pricingMode ?? 'UNKNOWN',
      },
    },
    invariants: {
      cutterEntryCreatedBeforeAnyScan,
      sewingEntryPendingBeforeClose,
      sewingEntryApprovedAfterClose,
    },
    operationEntries: opEntries,
    salaryEntries: salEntries,
    payroll: {
      period: { dateFrom, dateTo },
      rows: periodRows,
      summary: periodSummary,
    },
  };
  const classification = classify(reportShell);
  return { ...reportShell, classification };
}

// ---------------------------------------------------------------------------
// Test entrypoint
// ---------------------------------------------------------------------------

describeFn('production payroll scenario', () => {
  let t: TestApp;
  let safety: { url: string; dbName: string };

  beforeAll(async () => {
    safety = assertSafeTestDatabaseUrl();
    t = await startTestApp();
  }, 60_000);

  afterAll(async () => {
    if (t) await stopTestApp(t);
  });

  test('drives a production passport through CUT→SEW→QC→WTO→PACK and verifies payroll', async () => {
    if (CLEANUP_PREFIX) {
      // Cleanup-only mode: ничего не запускаем, удаляем по prefix и
      // сразу выходим. По смыслу = scripts/<cleanup>.
      const counts = await cleanupByPrefix(t.prisma, CLEANUP_PREFIX);
      // eslint-disable-next-line no-console
      console.log(
        `\n[cleanup-only] prefix=${CLEANUP_PREFIX} db=${safety.dbName}\n` +
          Object.entries(counts)
            .map(([k, v]) => `  ${k.padEnd(20)} ${v}`)
            .join('\n') +
          '\n',
      );
      // Гарантируем, что вызов сценария не происходит. Тест засчитывается
      // как passed (cleanup завершился без ошибок).
      expect(typeof counts).toBe('object');
      return;
    }

    const prefix = buildPrefix();
    let report: ScenarioReport | undefined;
    try {
      report = await runScenario(t, prefix, safety.dbName);
      printReport(report);

      // Инварианты — собственно «show where piecework is created or lost».
      expect(report.classification).toBe('OK_FULL_FLOW');
      expect(report.invariants.cutterEntryCreatedBeforeAnyScan).toBe(true);
      expect(report.invariants.sewingEntryPendingBeforeClose).toBe(true);
      expect(report.invariants.sewingEntryApprovedAfterClose).toBe(true);

      const cutterEntry = report.operationEntries.find(
        (e) => e.sourceEventType === 'PASSPORT_CREATED' && e.operationCode === 'CUT_CUT',
      );
      const sewingEntry = report.operationEntries.find(
        (e) => e.sourceEventType === 'OPERATION_TRANSITION' && e.operationCode === 'SEW_OVERLOCK_1',
      );
      expect(cutterEntry).toBeDefined();
      expect(cutterEntry?.status).toBe('APPROVED');
      expect(cutterEntry?.amount).toBeGreaterThan(0);
      expect(sewingEntry).toBeDefined();
      expect(sewingEntry?.status).toBe('APPROVED');
      expect(sewingEntry?.amount).toBeGreaterThan(0);

      // Окладные SHIFT_DAY: только SALARY/MIXED. Cutter (PIECEWORK) НЕ должен
      // получить SalaryEntry; manager/seamstress/qc/ironing/packer — должны.
      const cutterSalary = report.salaryEntries.filter(
        (s) => s.employeeRole === 'cutter',
      );
      expect(cutterSalary).toHaveLength(0);
      const seamstressSalary = report.salaryEntries.filter(
        (s) => s.employeeRole === 'seamstress',
      );
      expect(seamstressSalary.length).toBeGreaterThan(0);
      const qcSalary = report.salaryEntries.filter((s) => s.employeeRole === 'qc');
      expect(qcSalary.length).toBeGreaterThan(0);

      // Payroll period summary должен содержать оба контура.
      expect(report.payroll.summary.pieceworkRub).toBeGreaterThan(0);
      expect(report.payroll.summary.salaryRub).toBeGreaterThan(0);
    } finally {
      if (!process.env.PAYROLL_SCENARIO_KEEP) {
        try {
          const counts = await cleanupByPrefix(t.prisma, prefix);
          // eslint-disable-next-line no-console
          console.log(
            `[cleanup-after-run] prefix=${prefix}\n` +
              Object.entries(counts)
                .map(([k, v]) => `  ${k.padEnd(20)} ${v}`)
                .join('\n'),
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(
            `[cleanup-after-run] FAILED for prefix=${prefix}: ${(e as Error).message}\n` +
              `Run again with PAYROLL_SCENARIO_CLEANUP_PREFIX=${prefix} to retry.`,
          );
          throw e;
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[cleanup-after-run] PAYROLL_SCENARIO_KEEP=1 — оставляем записи. ` +
            `Чистить вручную: PAYROLL_SCENARIO_CLEANUP_PREFIX=${prefix} npm run test:payroll-scenario`,
        );
      }
    }
  }, 180_000);
});
