/**
 * Source-level smoke-тесты PHASE 3 STEP 6.3 payroll accrual document admin UI
 * (см. `apps/web/app/admin/payroll/accrual-documents/*`,
 * `apps/web/lib/payroll-accrual-documents-api.ts`).
 *
 * Зачем: рендера React в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников. Этого достаточно,
 * чтобы поймать регресс «убрали страницу» или «удалили кнопку».
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. API client
// ---------------------------------------------------------------------------

describe('payroll-accrual-documents-api.ts', () => {
  test('файл существует', () => {
    expect(() =>
      readSrc('apps/web/lib/payroll-accrual-documents-api.ts'),
    ).not.toThrow();
  });

  test('использует base path /payroll/accrual-documents', () => {
    const src = readSrc('apps/web/lib/payroll-accrual-documents-api.ts');
    expect(src).toMatch(/\/payroll\/accrual-documents/);
  });

  test('экспортирует все 7 функций', () => {
    const src = readSrc('apps/web/lib/payroll-accrual-documents-api.ts');
    expect(src).toMatch(/listPayrollAccrualDocuments/);
    expect(src).toMatch(/createPayrollAccrualDocument/);
    expect(src).toMatch(/getPayrollAccrualDocument/);
    expect(src).toMatch(/recomputePayrollAccrualDocument/);
    expect(src).toMatch(/updatePayrollAccrualDocumentLine/);
    expect(src).toMatch(/payPayrollAccrualDocument/);
    expect(src).toMatch(/cancelPayrollAccrualDocument/);
  });
});

// ---------------------------------------------------------------------------
// 2. Server actions
// ---------------------------------------------------------------------------

describe('accrual-documents actions.ts', () => {
  test('файл существует', () => {
    expect(() =>
      readSrc(
        'apps/web/app/admin/payroll/accrual-documents/actions.ts',
      ),
    ).not.toThrow();
  });

  test("имеет 'use server'", () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/accrual-documents/actions.ts',
    );
    expect(src).toMatch(/'use server'/);
  });

  test('экспортирует все 5 actions', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/accrual-documents/actions.ts',
    );
    expect(src).toMatch(/createPayrollAccrualDocumentAction/);
    expect(src).toMatch(/recomputePayrollAccrualDocumentAction/);
    expect(src).toMatch(/updatePayrollAccrualDocumentLineAction/);
    expect(src).toMatch(/payPayrollAccrualDocumentAction/);
    expect(src).toMatch(/cancelPayrollAccrualDocumentAction/);
  });
});

// ---------------------------------------------------------------------------
// 3. Routes exist
// ---------------------------------------------------------------------------

const ROUTE_FILES = [
  'apps/web/app/admin/payroll/accrual-documents/page.tsx',
  'apps/web/app/admin/payroll/accrual-documents/new/page.tsx',
  'apps/web/app/admin/payroll/accrual-documents/[id]/page.tsx',
] as const;

describe('accrual-documents маршруты существуют', () => {
  test.each(ROUTE_FILES)('%s существует', (file) => {
    expect(() => readSrc(file)).not.toThrow();
  });

  test.each(ROUTE_FILES)(
    '%s использует AdminPageShell',
    (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/AdminPageShell/);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. /admin/payroll hub содержит «Начислить зарплату»
// ---------------------------------------------------------------------------

describe('/admin/payroll hub', () => {
  test('содержит кнопку «Начислить зарплату»', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/Начислить зарплату/);
  });

  test('содержит ссылку на /admin/payroll/accrual-documents', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/\/admin\/payroll\/accrual-documents/);
  });
});

// ---------------------------------------------------------------------------
// 5. Detail page содержит ключевые элементы
// ---------------------------------------------------------------------------

describe('/admin/payroll/accrual-documents/[id] page', () => {
  const src = readSrc(
    'apps/web/app/admin/payroll/accrual-documents/[id]/page.tsx',
  );
  const actionsSrc = readSrc(
    'apps/web/app/admin/payroll/accrual-documents/[id]/document-actions.tsx',
  );

  test('содержит DocumentActions (включает Выплатить / Пересчитать)', () => {
    expect(src).toMatch(/DocumentActions/);
  });

  test('document-actions.tsx содержит «Выплатить»', () => {
    expect(actionsSrc).toMatch(/Выплатить/);
  });

  test('document-actions.tsx содержит «Пересчитать»', () => {
    expect(actionsSrc).toMatch(/Пересчитать/);
  });

  test('содержит LineAdjustmentForm (manual adjust fields)', () => {
    expect(src).toMatch(/LineAdjustmentForm/);
  });

  test('импортирует getPayrollAccrualDocument', () => {
    expect(src).toMatch(/getPayrollAccrualDocument/);
  });
});

// ---------------------------------------------------------------------------
// 6. DocumentActions содержит informational note для manualAdjustRub (STEP 6.4)
// ---------------------------------------------------------------------------

describe('document-actions.tsx (STEP 6.4)', () => {
  const src = readSrc(
    'apps/web/app/admin/payroll/accrual-documents/[id]/document-actions.tsx',
  );

  test('содержит информационную заметку о корректировках', () => {
    expect(src).toMatch(/Корректировки будут перенесены в выплату/);
  });

  test('кнопка «Выплатить» не блокируется из-за корректировок (нет блокировки payBlockedReason через adjustments)', () => {
    // getPayBlockedReason всегда возвращает null в STEP 6.4
    const uiSrc = readSrc(
      'apps/web/app/admin/payroll/accrual-documents/accrual-document-ui.ts',
    );
    expect(uiSrc).toMatch(/return null/);
    expect(uiSrc).not.toMatch(/hasManualAdjustments\(doc\)/);
  });

  test('enum PAYROLL_PAYOUT_LINE_KINDS содержит ADJUSTMENT', () => {
    const sharedSrc = readSrc('packages/shared/src/payroll-payouts.ts');
    expect(sharedSrc).toMatch(/ADJUSTMENT/);
    expect(sharedSrc).toMatch(/BONUS/);
    expect(sharedSrc).toMatch(/DEDUCTION/);
    expect(sharedSrc).toMatch(/ADVANCE/);
  });
});

// ---------------------------------------------------------------------------
// 7. docs/screens.md содержит все маршруты
// ---------------------------------------------------------------------------

describe('docs/screens.md', () => {
  const src = readSrc('docs/screens.md');

  test('содержит /admin/payroll/accrual-documents', () => {
    expect(src).toMatch(/\/admin\/payroll\/accrual-documents/);
  });

  test('содержит /admin/payroll/accrual-documents/new', () => {
    expect(src).toMatch(/\/admin\/payroll\/accrual-documents\/new/);
  });

  test('содержит /admin/payroll/accrual-documents/[id]', () => {
    expect(src).toMatch(/accrual-documents\/\[id\]/);
  });

  test('упоминает accrualDate cutoff', () => {
    expect(src).toMatch(/accrualDate/);
  });

  test('упоминает корректировки документа начисления', () => {
    expect(src).toMatch(/manualAdjustRub/);
  });
});
