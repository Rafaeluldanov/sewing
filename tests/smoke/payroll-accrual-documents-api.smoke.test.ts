/**
 * Source-level smoke-тесты PHASE 3 STEP 6.2 — backend API документа
 * начисления зарплаты.
 *
 * Проверяем структуру исходников (module/controller/service, маршруты,
 * импорты), не требуя запуска БД или приложения.
 *
 * Парные тесты (data model) —
 * `tests/smoke/payroll-accrual-documents-model.smoke.test.ts`.
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

const MODULE_DIR =
  'apps/api/src/modules/payroll-accrual-documents';

// ---------------------------------------------------------------------------
// 1. Все три файла существуют
// ---------------------------------------------------------------------------

describe('PHASE 3 STEP 6.2 — module files exist', () => {
  const FILES = [
    `${MODULE_DIR}/payroll-accrual-documents.module.ts`,
    `${MODULE_DIR}/payroll-accrual-documents.controller.ts`,
    `${MODULE_DIR}/payroll-accrual-documents.service.ts`,
  ] as const;

  test.each(FILES)('%s существует', (file) => {
    expect(srcExists(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. app.module.ts импортирует PayrollAccrualDocumentsModule
// ---------------------------------------------------------------------------

describe('app.module.ts — подключён PayrollAccrualDocumentsModule', () => {
  test('импортирует PayrollAccrualDocumentsModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/PayrollAccrualDocumentsModule/);
    expect(src).toMatch(/payroll-accrual-documents/);
  });
});

// ---------------------------------------------------------------------------
// 3. Controller — все 7 маршрутов
// ---------------------------------------------------------------------------

describe('payroll-accrual-documents.controller.ts — маршруты', () => {
  const src = () =>
    readSrc(
      `${MODULE_DIR}/payroll-accrual-documents.controller.ts`,
    );

  test('@Controller("payroll/accrual-documents")', () => {
    expect(src()).toMatch(/@Controller\(['"]payroll\/accrual-documents['"]\)/);
  });

  test('GET  list', () => {
    expect(src()).toMatch(/@Get\(\)/);
  });

  test('POST create', () => {
    expect(src()).toMatch(/@Post\(\)/);
  });

  test('GET  get :id', () => {
    expect(src()).toMatch(/@Get\(['"]:id['"]\)/);
  });

  test('POST recompute :id/recompute', () => {
    expect(src()).toMatch(/@Post\(['"]:id\/recompute['"]\)/);
  });

  test('PATCH updateLine :id/lines/:lineId', () => {
    expect(src()).toMatch(/@Patch\(['"]:id\/lines\/:lineId['"]\)/);
  });

  test('POST pay :id/pay', () => {
    expect(src()).toMatch(/@Post\(['"]:id\/pay['"]\)/);
  });

  test('POST cancel :id/cancel', () => {
    expect(src()).toMatch(/@Post\(['"]:id\/cancel['"]\)/);
  });

  test('@Roles("SHOP_MANAGER", "ADMIN") на уровне класса', () => {
    expect(src()).toMatch(/@Roles\(['"]SHOP_MANAGER['"],\s*['"]ADMIN['"]\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. Service — все ключевые методы
// ---------------------------------------------------------------------------

describe('payroll-accrual-documents.service.ts — методы', () => {
  const src = () =>
    readSrc(
      `${MODULE_DIR}/payroll-accrual-documents.service.ts`,
    );

  const METHODS = ['list', 'get', 'create', 'recompute', 'updateLine', 'pay', 'cancel'] as const;

  test.each(METHODS)('имеет метод %s', (method) => {
    expect(src()).toMatch(new RegExp(`async\\s+${method}\\b`));
  });

  test('использует AuditService.log', () => {
    expect(src()).toMatch(/this\.audit\.log/);
  });

  test('использует prisma.$transaction', () => {
    expect(src()).toMatch(/this\.prisma\.\$transaction/);
  });

  test('содержит endOfDayUtc (cutoff accrualDate)', () => {
    expect(src()).toMatch(/endOfDayUtc/);
  });
});

// ---------------------------------------------------------------------------
// 5. docs/api.md содержит /api/payroll/accrual-documents
// ---------------------------------------------------------------------------

describe('docs/api.md — endpoint present', () => {
  test('содержит /api/payroll/accrual-documents', () => {
    const src = readSrc('docs/api.md');
    expect(src).toMatch(/\/api\/payroll\/accrual-documents/);
  });

  test('содержит payroll-accrual-documents.controller.ts', () => {
    const src = readSrc('docs/api.md');
    expect(src).toMatch(/payroll-accrual-documents\.controller\.ts/);
  });
});

// ---------------------------------------------------------------------------
// 6. docs/events.md содержит PAYROLL_ACCRUAL_DOCUMENT
// ---------------------------------------------------------------------------

describe('docs/events.md — audit entity present', () => {
  test('содержит PAYROLL_ACCRUAL_DOCUMENT', () => {
    const src = readSrc('docs/events.md');
    expect(src).toMatch(/PAYROLL_ACCRUAL_DOCUMENT/);
  });

  test('содержит PAYROLL_ACCRUAL_DOCUMENT_CREATED', () => {
    const src = readSrc('docs/events.md');
    expect(src).toMatch(/PAYROLL_ACCRUAL_DOCUMENT_CREATED/);
  });

  test('содержит PAYROLL_ACCRUAL_DOCUMENT_PAID', () => {
    const src = readSrc('docs/events.md');
    expect(src).toMatch(/PAYROLL_ACCRUAL_DOCUMENT_PAID/);
  });
});

// ---------------------------------------------------------------------------
// 7. audit.service.ts содержит PAYROLL_ACCRUAL_DOCUMENT в AuditEntityType
// ---------------------------------------------------------------------------

describe('audit.service.ts — AuditEntityType расширен', () => {
  test('содержит PAYROLL_ACCRUAL_DOCUMENT', () => {
    const src = readSrc(
      'apps/api/src/modules/audit/audit.service.ts',
    );
    expect(src).toMatch(/'PAYROLL_ACCRUAL_DOCUMENT'/);
  });
});

// ---------------------------------------------------------------------------
// 8. errors.ts содержит новые классы
// ---------------------------------------------------------------------------

describe('errors.ts — новые классы ошибок', () => {
  const src = () => readSrc('apps/api/src/common/errors.ts');

  const CLASSES = [
    'PayrollAccrualDocumentNotFoundException',
    'PayrollAccrualDocumentInvalidStateException',
    'PayrollAccrualDocumentLineNotFoundException',
    'PayrollAccrualLineAlreadyPaidException',
    'PayrollAccrualManualAdjustNotSupportedException',
  ] as const;

  test.each(CLASSES)('содержит класс %s', (cls) => {
    expect(src()).toMatch(new RegExp(`class\\s+${cls}\\b`));
  });

  test('PAYROLL_ACCRUAL_DOCUMENT_NOT_FOUND (404)', () => {
    expect(src()).toMatch(/PAYROLL_ACCRUAL_DOCUMENT_NOT_FOUND/);
    expect(src()).toMatch(/HttpStatus\.NOT_FOUND/);
  });

  test('PAYROLL_ACCRUAL_MANUAL_ADJUST_NOT_SUPPORTED (409)', () => {
    expect(src()).toMatch(/PAYROLL_ACCRUAL_MANUAL_ADJUST_NOT_SUPPORTED/);
  });
});
