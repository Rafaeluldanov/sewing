/**
 * Smoke-тесты PHASE 3 STEP 7 — payroll debts report.
 *
 * Проверяем структуру исходников без рендера React.
 * Парный пример — `tests/smoke/payroll-admin.smoke.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Controller содержит /debts endpoint
// ---------------------------------------------------------------------------

describe('PayrollController — GET /debts', () => {
  test('контроллер содержит @Get("debts") и вызывает payroll.debts', () => {
    const src = readSrc('apps/api/src/modules/payroll/payroll.controller.ts');
    expect(src).toMatch(/@Get\(['"]debts['"]\)/);
    expect(src).toMatch(/this\.payroll\.debts\(/);
  });

  test('контроллер импортирует PayrollDebtsQuerySchema и PayrollDebtsQuery', () => {
    const src = readSrc('apps/api/src/modules/payroll/payroll.controller.ts');
    expect(src).toMatch(/PayrollDebtsQuerySchema/);
    expect(src).toMatch(/PayrollDebtsQuery/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared DTO содержит обязательные поля
// ---------------------------------------------------------------------------

describe('shared payroll.ts — PayrollDebtEmployeeRowDto', () => {
  test('содержит debtRub / payoutCoveredRub / payoutAdjustRub', () => {
    const src = readSrc('packages/shared/src/payroll.ts');
    expect(src).toMatch(/debtRub/);
    expect(src).toMatch(/payoutCoveredRub/);
    expect(src).toMatch(/payoutAdjustRub/);
  });

  test('содержит cashBalanceRub и pendingPieceworkRub', () => {
    const src = readSrc('packages/shared/src/payroll.ts');
    expect(src).toMatch(/cashBalanceRub/);
    expect(src).toMatch(/pendingPieceworkRub/);
  });

  test('содержит PayrollDebtsQuerySchema с asOfDate', () => {
    const src = readSrc('packages/shared/src/payroll.ts');
    expect(src).toMatch(/PayrollDebtsQuerySchema/);
    expect(src).toMatch(/asOfDate/);
  });

  test('содержит PayrollDebtsPageDto', () => {
    const src = readSrc('packages/shared/src/payroll.ts');
    expect(src).toMatch(/PayrollDebtsPageDto/);
  });

  test('содержит PayrollDebtsSummaryDto с employeesWithDebt', () => {
    const src = readSrc('packages/shared/src/payroll.ts');
    expect(src).toMatch(/PayrollDebtsSummaryDto/);
    expect(src).toMatch(/employeesWithDebt/);
  });
});

// ---------------------------------------------------------------------------
// 3. Frontend page существует и содержит ключевые элементы
// ---------------------------------------------------------------------------

describe('/admin/payroll/debts — страница задолженности', () => {
  test('страница существует', () => {
    expect(() =>
      readSrc('apps/web/app/admin/payroll/debts/page.tsx'),
    ).not.toThrow();
  });

  test('страница использует AdminPageShell', () => {
    const src = readSrc('apps/web/app/admin/payroll/debts/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
  });

  test('страница вызывает getPayrollDebts из @/lib/payroll-api', () => {
    const src = readSrc('apps/web/app/admin/payroll/debts/page.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/payroll-api['"]/);
    expect(src).toMatch(/getPayrollDebts/);
  });

  test('страница содержит фильтры asOfDate/employeeId/role/divisionCode', () => {
    const src = readSrc('apps/web/app/admin/payroll/debts/page.tsx');
    expect(src).toMatch(/name="asOfDate"/);
    expect(src).toMatch(/name="employeeId"/);
    expect(src).toMatch(/name="role"/);
    expect(src).toMatch(/name="divisionCode"/);
  });

  test('страница содержит kpi-grid', () => {
    const src = readSrc('apps/web/app/admin/payroll/debts/page.tsx');
    expect(src).toMatch(/kpi-grid/);
  });

  test('страница содержит заголовок «Задолженность»', () => {
    const src = readSrc('apps/web/app/admin/payroll/debts/page.tsx');
    expect(src).toMatch(/Задолженность/);
  });

  test('строка таблицы ссылается на /admin/payroll/employees/:employeeId', () => {
    const src = readSrc('apps/web/app/admin/payroll/debts/page.tsx');
    expect(src).toMatch(/\/admin\/payroll\/employees\//);
  });

  test('строка таблицы ссылается на /admin/payroll/accrual-documents/new', () => {
    const src = readSrc('apps/web/app/admin/payroll/debts/page.tsx');
    expect(src).toMatch(/\/admin\/payroll\/accrual-documents\/new/);
  });
});

// ---------------------------------------------------------------------------
// 4. /admin/payroll содержит ссылку «Задолженность»
// ---------------------------------------------------------------------------

describe('/admin/payroll — навигация к задолженности', () => {
  test('страница /admin/payroll содержит ссылку на /admin/payroll/debts', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/\/admin\/payroll\/debts/);
    expect(src).toMatch(/Задолженность/);
  });
});

// ---------------------------------------------------------------------------
// 5. payroll-api.ts экспортирует getPayrollDebts
// ---------------------------------------------------------------------------

describe('payroll-api.ts — клиент задолженности', () => {
  test('экспортирует getPayrollDebts', () => {
    const src = readSrc('apps/web/lib/payroll-api.ts');
    expect(src).toMatch(/export\s+function\s+getPayrollDebts\b/);
  });

  test('getPayrollDebts вызывает /payroll/debts', () => {
    const src = readSrc('apps/web/lib/payroll-api.ts');
    expect(src).toMatch(/\/payroll\/debts/);
  });
});

// ---------------------------------------------------------------------------
// 6. docs/screens.md содержит /admin/payroll/debts
// ---------------------------------------------------------------------------

describe('docs/screens.md — описание экрана задолженности', () => {
  test('содержит /admin/payroll/debts', () => {
    const src = readSrc('docs/screens.md');
    expect(src).toMatch(/\/admin\/payroll\/debts/);
  });

  test('содержит раздел 12d', () => {
    const src = readSrc('docs/screens.md');
    expect(src).toMatch(/12d/);
  });
});

// ---------------------------------------------------------------------------
// 7. docs/api.md содержит GET /api/payroll/debts
// ---------------------------------------------------------------------------

describe('docs/api.md — описание endpoint', () => {
  test('содержит /api/payroll/debts', () => {
    const src = readSrc('docs/api.md');
    expect(src).toMatch(/\/api\/payroll\/debts/);
  });

  test('содержит формулу debtRub', () => {
    const src = readSrc('docs/api.md');
    expect(src).toMatch(/debtRub/);
  });
});
