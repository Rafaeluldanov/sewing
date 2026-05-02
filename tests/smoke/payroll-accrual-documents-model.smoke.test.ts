/**
 * Source-level smoke-тесты PHASE 3 STEP 6.1 «PayrollAccrualDocument
 * data model».
 *
 * Проверяем:
 *   1. `prisma/schema.prisma` содержит enum и обе модели.
 *   2. `Employee` содержит обратные relation-поля.
 *   3. `PayrollPayout` содержит `accrualDocumentLines`.
 *   4. Shared contract-файл существует и экспортирует ключевые символы.
 *   5. `packages/shared/src/index.ts` реэкспортирует контракты.
 *   6. `docs/erd.md` содержит упоминание `PayrollAccrualDocument`.
 *
 * Тест НЕ требует базы данных (`TEST_DATABASE_URL`): только fs-чтение.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Prisma schema — enum
// ---------------------------------------------------------------------------

describe('prisma/schema.prisma — enum PayrollAccrualDocumentStatus', () => {
  test('схема содержит enum PayrollAccrualDocumentStatus', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/enum\s+PayrollAccrualDocumentStatus\s*\{/);
  });

  test('enum содержит все три статуса: DRAFT, PAID, CANCELLED', () => {
    const schema = readSrc('prisma/schema.prisma');
    const enumBlock = schema.match(
      /enum\s+PayrollAccrualDocumentStatus\s*\{([^}]+)\}/,
    );
    expect(enumBlock).not.toBeNull();
    const block = enumBlock![1];
    expect(block).toMatch(/\bDRAFT\b/);
    expect(block).toMatch(/\bPAID\b/);
    expect(block).toMatch(/\bCANCELLED\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. Prisma schema — model PayrollAccrualDocument
// ---------------------------------------------------------------------------

describe('prisma/schema.prisma — model PayrollAccrualDocument', () => {
  test('схема содержит model PayrollAccrualDocument', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/model\s+PayrollAccrualDocument\s*\{/);
  });

  test('модель имеет поле accrualDate @db.Date', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/accrualDate\s+DateTime\s+@db\.Date/);
  });

  test('модель имеет поле status с дефолтом DRAFT', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(
      /status\s+PayrollAccrualDocumentStatus\s+@default\(DRAFT\)/,
    );
  });

  test('модель имеет snapshot-итоги (totalPieceworkRub, totalSalaryRub, totalAdjustRub, totalToPayRub)', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/totalPieceworkRub/);
    expect(schema).toMatch(/totalSalaryRub/);
    expect(schema).toMatch(/totalAdjustRub/);
    expect(schema).toMatch(/totalToPayRub/);
  });

  test('модель ссылается на lines PayrollAccrualDocumentLine[]', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/lines\s+PayrollAccrualDocumentLine\[\]/);
  });

  test('модель имеет составные индексы @@index([status, accrualDate])', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/@@index\(\[status,\s*accrualDate\]\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Prisma schema — model PayrollAccrualDocumentLine
// ---------------------------------------------------------------------------

describe('prisma/schema.prisma — model PayrollAccrualDocumentLine', () => {
  test('схема содержит model PayrollAccrualDocumentLine', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/model\s+PayrollAccrualDocumentLine\s*\{/);
  });

  test('модель имеет поле payoutId (nullable, связь с PayrollPayout)', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/payoutId\s+String\?/);
  });

  test('модель имеет snapshot Json', () => {
    const schema = readSrc('prisma/schema.prisma');
    // Ищем именно в блоке PayrollAccrualDocumentLine
    const modelBlock = schema.match(
      /model\s+PayrollAccrualDocumentLine\s*\{([^}]+)\}/,
    );
    expect(modelBlock).not.toBeNull();
    expect(modelBlock![1]).toMatch(/\bsnapshot\s+Json\b/);
  });

  test('модель имеет @@unique([documentId, employeeId])', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/@@unique\(\[documentId,\s*employeeId\]\)/);
  });

  test('relation на PayrollAccrualDocument с onDelete: Cascade', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(
      /document\s+PayrollAccrualDocument\s+@relation\(.*onDelete:\s*Cascade/,
    );
  });

  test('relation на Employee с onDelete: Restrict', () => {
    const schema = readSrc('prisma/schema.prisma');
    // В блоке PayrollAccrualDocumentLine
    const modelBlock = schema.match(
      /model\s+PayrollAccrualDocumentLine\s*\{([\s\S]*?)\n\}/,
    );
    expect(modelBlock).not.toBeNull();
    expect(modelBlock![1]).toMatch(
      /Employee.*onDelete:\s*Restrict/,
    );
  });

  test('relation на PayrollPayout с onDelete: SetNull', () => {
    const schema = readSrc('prisma/schema.prisma');
    const modelBlock = schema.match(
      /model\s+PayrollAccrualDocumentLine\s*\{([\s\S]*?)\n\}/,
    );
    expect(modelBlock).not.toBeNull();
    expect(modelBlock![1]).toMatch(
      /PayrollPayout.*onDelete:\s*SetNull/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Employee — обратные relation-поля
// ---------------------------------------------------------------------------

describe('prisma/schema.prisma — Employee обратные связи', () => {
  test('Employee содержит payrollAccrualDocumentsCreated', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(
      /payrollAccrualDocumentsCreated\s+PayrollAccrualDocument\[\]\s+@relation\("PayrollAccrualDocumentCreatedBy"\)/,
    );
  });

  test('Employee содержит payrollAccrualDocumentsPaid', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(
      /payrollAccrualDocumentsPaid\s+PayrollAccrualDocument\[\]\s+@relation\("PayrollAccrualDocumentPaidBy"\)/,
    );
  });

  test('Employee содержит payrollAccrualDocumentsCancelled', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(
      /payrollAccrualDocumentsCancelled\s+PayrollAccrualDocument\[\]\s+@relation\("PayrollAccrualDocumentCancelledBy"\)/,
    );
  });

  test('Employee содержит payrollAccrualDocumentLines PayrollAccrualDocumentLine[]', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(
      /payrollAccrualDocumentLines\s+PayrollAccrualDocumentLine\[\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. PayrollPayout — обратная связь accrualDocumentLines
// ---------------------------------------------------------------------------

describe('prisma/schema.prisma — PayrollPayout.accrualDocumentLines', () => {
  test('PayrollPayout содержит accrualDocumentLines PayrollAccrualDocumentLine[]', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(
      /accrualDocumentLines\s+PayrollAccrualDocumentLine\[\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Shared contract — файл существует и содержит ключевые экспорты
// ---------------------------------------------------------------------------

describe('packages/shared/src/payroll-accrual-documents.ts', () => {
  test('файл существует', () => {
    expect(() =>
      readSrc('packages/shared/src/payroll-accrual-documents.ts'),
    ).not.toThrow();
  });

  test('экспортирует PayrollAccrualDocumentStatusSchema', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(/export\s+const\s+PayrollAccrualDocumentStatusSchema/);
  });

  test('экспортирует CreatePayrollAccrualDocumentSchema', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+const\s+CreatePayrollAccrualDocumentSchema/,
    );
  });

  test('экспортирует PayrollAccrualDocumentListQuerySchema', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+const\s+PayrollAccrualDocumentListQuerySchema/,
    );
  });

  test('экспортирует UpdatePayrollAccrualDocumentLineSchema', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+const\s+UpdatePayrollAccrualDocumentLineSchema/,
    );
  });

  test('экспортирует PayPayrollAccrualDocumentSchema', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(/export\s+const\s+PayPayrollAccrualDocumentSchema/);
  });

  test('экспортирует CancelPayrollAccrualDocumentSchema', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+const\s+CancelPayrollAccrualDocumentSchema/,
    );
  });

  test('содержит интерфейс PayrollAccrualDocumentDto', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+interface\s+PayrollAccrualDocumentDto\b/,
    );
  });

  test('содержит интерфейс PayrollAccrualDocumentLineDto', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+interface\s+PayrollAccrualDocumentLineDto\b/,
    );
  });

  test('содержит интерфейс PayrollAccrualDocumentListItemDto', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+interface\s+PayrollAccrualDocumentListItemDto\b/,
    );
  });

  test('содержит интерфейс PayrollAccrualDocumentPageDto', () => {
    const src = readSrc(
      'packages/shared/src/payroll-accrual-documents.ts',
    );
    expect(src).toMatch(
      /export\s+interface\s+PayrollAccrualDocumentPageDto\b/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Shared index.ts реэкспортирует payroll-accrual-documents
// ---------------------------------------------------------------------------

describe('packages/shared/src/index.ts', () => {
  test('index.ts содержит export * from ./payroll-accrual-documents', () => {
    const src = readSrc('packages/shared/src/index.ts');
    expect(src).toMatch(
      /export\s+\*\s+from\s+['"]\.\/payroll-accrual-documents['"]/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. docs/erd.md содержит PayrollAccrualDocument
// ---------------------------------------------------------------------------

describe('docs/erd.md — PayrollAccrualDocument', () => {
  test('erd.md содержит PayrollAccrualDocument', () => {
    const doc = readSrc('docs/erd.md');
    expect(doc).toMatch(/PayrollAccrualDocument/);
  });

  test('erd.md содержит PayrollAccrualDocumentLine', () => {
    const doc = readSrc('docs/erd.md');
    expect(doc).toMatch(/PayrollAccrualDocumentLine/);
  });

  test('erd.md содержит PayrollAccrualDocumentStatus в таблице enum-ов', () => {
    const doc = readSrc('docs/erd.md');
    expect(doc).toMatch(/PayrollAccrualDocumentStatus/);
  });
});
