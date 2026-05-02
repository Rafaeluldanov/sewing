/**
 * Source-level smoke-тесты PHASE 3 STEP 5 — employee UI выплат зарплаты.
 *
 * Проверяем структуру исходников (routes, actions, api client),
 * не требуя рендера React (vitest + Node, без jsdom).
 *
 * Парный тест — `tests/smoke/payroll-payouts-admin.smoke.test.ts` (STEP 4).
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
// 1. Страницы существуют
// ---------------------------------------------------------------------------

const EMPLOYEE_PAYOUT_FILES = [
  'apps/web/app/earnings/payouts/page.tsx',
  'apps/web/app/earnings/payouts/[id]/page.tsx',
] as const;

describe('PHASE 3 STEP 5 — employee payout pages существуют', () => {
  test.each(EMPLOYEE_PAYOUT_FILES)('%s существует', (file) => {
    expect(srcExists(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. API client — acknowledgePayrollPayout добавлен
// ---------------------------------------------------------------------------

describe('payroll-payouts-api.ts — acknowledge функция', () => {
  test('экспортирует acknowledgePayrollPayout', () => {
    const src = readSrc('apps/web/lib/payroll-payouts-api.ts');
    expect(src).toMatch(/export\s+function\s+acknowledgePayrollPayout\b/);
  });

  test('acknowledgePayrollPayout вызывает эндпоинт /acknowledge', () => {
    const src = readSrc('apps/web/lib/payroll-payouts-api.ts');
    expect(src).toMatch(/\/acknowledge/);
  });

  test('по-прежнему экспортирует все прежние 6 функций', () => {
    const src = readSrc('apps/web/lib/payroll-payouts-api.ts');
    expect(src).toMatch(/export\s+function\s+listPayrollPayouts\b/);
    expect(src).toMatch(/export\s+function\s+getPayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+createPayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+recomputePayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+issuePayrollPayout\b/);
    expect(src).toMatch(/export\s+function\s+cancelPayrollPayout\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. Server actions — acknowledgePayrollPayoutAction
// ---------------------------------------------------------------------------

describe('earnings/payouts/actions.ts', () => {
  test('файл существует', () => {
    expect(srcExists('apps/web/app/earnings/payouts/actions.ts')).toBe(true);
  });

  test('имеет "use server"', () => {
    const src = readSrc('apps/web/app/earnings/payouts/actions.ts');
    expect(src).toMatch(/'use server'/);
  });

  test('экспортирует acknowledgePayrollPayoutAction', () => {
    const src = readSrc('apps/web/app/earnings/payouts/actions.ts');
    expect(src).toMatch(/acknowledgePayrollPayoutAction/);
  });

  test('делает revalidatePath для /earnings/payouts и /earnings/payouts/:id', () => {
    const src = readSrc('apps/web/app/earnings/payouts/actions.ts');
    expect(src).toMatch(/revalidatePath/);
    expect(src).toMatch(/\/earnings\/payouts/);
  });

  test('НЕ содержит cancel / issue / recompute actions', () => {
    const src = readSrc('apps/web/app/earnings/payouts/actions.ts');
    expect(src).not.toMatch(/cancelPayrollPayout/);
    expect(src).not.toMatch(/issuePayrollPayout/);
    expect(src).not.toMatch(/recomputePayrollPayout/);
  });
});

// ---------------------------------------------------------------------------
// 4. Кнопка ACK — только для ISSUED
// ---------------------------------------------------------------------------

describe('/earnings/payouts/[id] — кнопка «Деньги получил»', () => {
  test('detail page содержит текст «Деньги получил»', () => {
    const src = readSrc('apps/web/app/earnings/payouts/[id]/page.tsx');
    expect(src).toMatch(/Деньги получил/);
  });

  test('кнопка ACK показывается только при status === ISSUED', () => {
    const src = readSrc('apps/web/app/earnings/payouts/[id]/page.tsx');
    expect(src).toMatch(/status.*===.*['"]ISSUED['"]/);
  });

  test('ack-button.tsx существует и имеет "use client"', () => {
    expect(
      srcExists('apps/web/app/earnings/payouts/[id]/ack-button.tsx'),
    ).toBe(true);
    const src = readSrc('apps/web/app/earnings/payouts/[id]/ack-button.tsx');
    expect(src).toMatch(/'use client'/);
  });

  test('ack-button.tsx использует useFormState и useFormStatus', () => {
    const src = readSrc('apps/web/app/earnings/payouts/[id]/ack-button.tsx');
    expect(src).toMatch(/useFormState/);
    expect(src).toMatch(/useFormStatus/);
  });
});

// ---------------------------------------------------------------------------
// 5. Отсутствуют manager actions в employee UI
// ---------------------------------------------------------------------------

describe('/earnings/payouts — нет manager actions', () => {
  test('list page не содержит Отменить / Пересчитать / Передать сотруднику', () => {
    const src = readSrc('apps/web/app/earnings/payouts/page.tsx');
    expect(src).not.toMatch(/Отменить/);
    expect(src).not.toMatch(/Пересчитать/);
    expect(src).not.toMatch(/Передать сотруднику/);
  });

  test('detail page не содержит Отменить / Пересчитать / Передать сотруднику', () => {
    const src = readSrc('apps/web/app/earnings/payouts/[id]/page.tsx');
    expect(src).not.toMatch(/Отменить/);
    expect(src).not.toMatch(/Пересчитать/);
    expect(src).not.toMatch(/Передать сотруднику/);
  });

  test('actions.ts не содержит cancel / recompute / issue', () => {
    const src = readSrc('apps/web/app/earnings/payouts/actions.ts');
    expect(src).not.toMatch(/cancelPayrollPayoutAction/);
    expect(src).not.toMatch(/recomputePayrollPayoutAction/);
    expect(src).not.toMatch(/issuePayrollPayoutAction/);
  });
});

// ---------------------------------------------------------------------------
// 6. /earnings/payouts — список с баннером
// ---------------------------------------------------------------------------

describe('/earnings/payouts — список выплат', () => {
  test('страница загружает listPayrollPayouts', () => {
    const src = readSrc('apps/web/app/earnings/payouts/page.tsx');
    expect(src).toMatch(/listPayrollPayouts/);
  });

  test('страница показывает баннер при наличии ISSUED', () => {
    const src = readSrc('apps/web/app/earnings/payouts/page.tsx');
    expect(src).toMatch(/ожидающие подтверждения/);
    expect(src).toMatch(/hasIssued/);
  });

  test('список содержит заголовок «Мои выплаты»', () => {
    const src = readSrc('apps/web/app/earnings/payouts/page.tsx');
    expect(src).toMatch(/Мои выплаты/);
  });
});

// ---------------------------------------------------------------------------
// 7. /earnings — баннер для неподтверждённых выплат
// ---------------------------------------------------------------------------

describe('/earnings — баннер неподтверждённых выплат', () => {
  test('страница импортирует listPayrollPayouts', () => {
    const src = readSrc('apps/web/app/earnings/page.tsx');
    expect(src).toMatch(/listPayrollPayouts/);
  });

  test('страница содержит текст «неподтверждённые выплаты»', () => {
    const src = readSrc('apps/web/app/earnings/page.tsx');
    expect(src).toMatch(/неподтверждённые выплаты/);
  });

  test('страница содержит ссылку на /earnings/payouts', () => {
    const src = readSrc('apps/web/app/earnings/page.tsx');
    expect(src).toMatch(/\/earnings\/payouts/);
  });
});

// ---------------------------------------------------------------------------
// 8. Docs — экраны задокументированы
// ---------------------------------------------------------------------------

describe('docs/screens.md — STEP 5 задокументирован', () => {
  test('screens.md упоминает /earnings/payouts', () => {
    const src = readSrc('docs/screens.md');
    expect(src).toMatch(/\/earnings\/payouts/);
  });

  test('screens.md упоминает PHASE 3 STEP 5', () => {
    const src = readSrc('docs/screens.md');
    expect(src).toMatch(/PHASE 3 STEP 5/);
  });

  test('screens.md упоминает кнопку «Деньги получил»', () => {
    const src = readSrc('docs/screens.md');
    expect(src).toMatch(/Деньги получил/);
  });
});
