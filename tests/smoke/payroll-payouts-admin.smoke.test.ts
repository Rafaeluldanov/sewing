/**
 * Source-level smoke-тесты PHASE 3 STEP 4 — admin UI выплат зарплаты.
 *
 * Проверяем структуру исходников (routes, actions, api client),
 * не требуя рендера React (vitest + Node, без jsdom).
 *
 * Парные тесты — `tests/smoke/payroll-admin.smoke.test.ts` (PHASE 1),
 * `tests/integration/payroll-payouts-lock.test.ts` (STEP 3 lock logic).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function srcExists(relativePath: string): boolean {
  return existsSync(path.join(repoRoot, relativePath));
}

// ---------------------------------------------------------------------------
// 1. Все три страницы существуют и используют AdminPageShell
// ---------------------------------------------------------------------------

const PAYOUT_ROUTE_FILES = [
  'apps/web/app/admin/payroll/payouts/page.tsx',
  'apps/web/app/admin/payroll/payouts/new/page.tsx',
  'apps/web/app/admin/payroll/payouts/[id]/page.tsx',
] as const;

describe('PHASE 3 payout admin UI — страницы существуют', () => {
  test.each(PAYOUT_ROUTE_FILES)('%s существует', (file) => {
    expect(srcExists(file)).toBe(true);
  });

  test.each(PAYOUT_ROUTE_FILES)(
    '%s использует AdminPageShell',
    (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/AdminPageShell/);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. API client
// ---------------------------------------------------------------------------

describe('payroll-payouts-api.ts — клиент', () => {
  test('файл существует', () => {
    expect(srcExists('apps/web/lib/payroll-payouts-api.ts')).toBe(true);
  });

  test('экспортирует все шесть функций', () => {
    const src = readSrc('apps/web/lib/payroll-payouts-api.ts');
    expect(src).toMatch(/export\s+function\s+listPayrollPayouts\b/);
    expect(src).toMatch(/export\s+function\s+getPayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+createPayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+recomputePayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+issuePayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+cancelPayrollPayout\b/);
  });

  test('НЕ содержит ack-эндпоинт (это действие сотрудника)', () => {
    const src = readSrc('apps/web/lib/payroll-payouts-api.ts');
    expect(src).not.toMatch(/ackPayrollPayout/);
    expect(src).not.toMatch(/\/ack/);
  });

  test('использует apiFetch из ./api', () => {
    const src = readSrc('apps/web/lib/payroll-payouts-api.ts');
    expect(src).toMatch(/from\s+['"]\.\/api['"]/);
    expect(src).toMatch(/apiFetch/);
  });
});

// ---------------------------------------------------------------------------
// 3. Server actions
// ---------------------------------------------------------------------------

describe('payroll payouts actions.ts', () => {
  test('файл существует и имеет "use server"', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/actions.ts',
    );
    expect(src).toMatch(/'use server'/);
  });

  test('экспортирует create / recompute / issue / cancel actions', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/actions.ts',
    );
    expect(src).toMatch(/createPayrollPayoutAction/);
    expect(src).toMatch(/recomputePayrollPayoutAction/);
    expect(src).toMatch(/issuePayrollPayoutAction/);
    expect(src).toMatch(/cancelPayrollPayoutAction/);
  });

  test('НЕ содержит acknowledgePayrollPayoutAction (только сотрудник)', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/actions.ts',
    );
    expect(src).not.toMatch(/acknowledgePayrollPayoutAction/);
    expect(src).not.toMatch(/ackPayrollPayout/);
  });

  test('после создания делает redirect на /admin/payroll/payouts/:id', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/actions.ts',
    );
    expect(src).toMatch(/redirect\(/);
    expect(src).toMatch(/\/admin\/payroll\/payouts\//);
  });

  test('делает revalidatePath для списка и detail', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/actions.ts',
    );
    expect(src).toMatch(/revalidatePath/);
    expect(src).toMatch(/\/admin\/payroll\/payouts/);
  });
});

// ---------------------------------------------------------------------------
// 4. Detail page — НЕТ кнопки «Подтвердить получение»
// ---------------------------------------------------------------------------

describe('/admin/payroll/payouts/[id] — нет кнопки ACK для менеджера', () => {
  test('detail page не содержит текст «Подтвердить получение»', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/[id]/page.tsx',
    );
    expect(src).not.toMatch(/Подтвердить получение/);
  });

  test('payout-actions.tsx не содержит текст «Подтвердить получение»', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/[id]/payout-actions.tsx',
    );
    expect(src).not.toMatch(/Подтвердить получение/);
  });

  test('payout-actions.tsx содержит кнопки issue / recompute / cancel', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/[id]/payout-actions.tsx',
    );
    expect(src).toMatch(/Передать сотруднику/);
    expect(src).toMatch(/Пересчитать/);
    expect(src).toMatch(/Отменить/);
  });
});

// ---------------------------------------------------------------------------
// 5. List page — фильтры и таблица
// ---------------------------------------------------------------------------

describe('/admin/payroll/payouts — список', () => {
  test('страница использует listPayrollPayouts из payroll-payouts-api', () => {
    const src = readSrc('apps/web/app/admin/payroll/payouts/page.tsx');
    expect(src).toMatch(/listPayrollPayouts/);
    expect(src).toMatch(/payroll-payouts-api/);
  });

  test('страница содержит фильтры employeeId / status / periodFrom / periodTo', () => {
    const src = readSrc('apps/web/app/admin/payroll/payouts/page.tsx');
    expect(src).toMatch(/name="employeeId"/);
    expect(src).toMatch(/name="status"/);
    expect(src).toMatch(/name="periodFrom"/);
    expect(src).toMatch(/name="periodTo"/);
  });

  test('страница содержит кнопку «Создать выплату»', () => {
    const src = readSrc('apps/web/app/admin/payroll/payouts/page.tsx');
    expect(src).toMatch(/Создать выплату/);
    expect(src).toMatch(/\/admin\/payroll\/payouts\/new/);
  });
});

// ---------------------------------------------------------------------------
// 6. New page — форма создания
// ---------------------------------------------------------------------------

describe('/admin/payroll/payouts/new — форма создания', () => {
  test('страница загружает список сотрудников (listEmployees)', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/new/page.tsx',
    );
    expect(src).toMatch(/listEmployees/);
  });

  test('create-form.tsx — "use client" и createPayrollPayoutAction', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/new/create-form.tsx',
    );
    expect(src).toMatch(/'use client'/);
    expect(src).toMatch(/createPayrollPayoutAction/);
    expect(src).toMatch(/useFormState/);
  });
});

// ---------------------------------------------------------------------------
// 7. Payroll hub (/admin/payroll) — ссылка на /admin/payroll/payouts
// ---------------------------------------------------------------------------

describe('/admin/payroll — hub ссылается на /admin/payroll/payouts', () => {
  test('payroll page.tsx содержит ссылку на /admin/payroll/payouts', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/\/admin\/payroll\/payouts/);
  });
});

// ---------------------------------------------------------------------------
// 8. payout-ui.ts — хелперы существуют
// ---------------------------------------------------------------------------

describe('payout-ui.ts — форматтеры', () => {
  test('экспортирует все требуемые хелперы', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/payout-ui.ts',
    );
    expect(src).toMatch(/export\s+function\s+formatRub\b/);
    expect(src).toMatch(/export\s+function\s+formatDate\b/);
    expect(src).toMatch(/export\s+function\s+formatDateTime\b/);
    expect(src).toMatch(/export\s+function\s+getPayoutStatusLabel\b/);
    expect(src).toMatch(/export\s+function\s+getPayoutStatusTone\b/);
    expect(src).toMatch(/export\s+function\s+getLineKindLabel\b/);
    expect(src).toMatch(/export\s+function\s+summarizePayoutLineSnapshot\b/);
  });

  test('getPayoutStatusLabel покрывает все четыре статуса', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/payouts/payout-ui.ts',
    );
    expect(src).toMatch(/Черновик/);
    expect(src).toMatch(/Выдано/);
    expect(src).toMatch(/Получено/);
    expect(src).toMatch(/Отменено/);
  });
});
