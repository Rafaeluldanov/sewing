/**
 * Smoke-тесты на B2B-схему начисления закройщика
 * (см. `docs/payroll-cutter-compensation-recon.md`).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников + проверяем
 * pure-функции из shared:
 *
 *   - shared `cutter-compensation` — schemes, labels, helper;
 *   - shared `employees` — DTO содержит `cutterB2bSewingPercent`;
 *   - Prisma schema — `Employee.cutterB2bSewingPercent Decimal(5, 2)`;
 *   - миграция additive (только `ADD COLUMN`, без `DROP`/`ALTER TYPE`);
 *   - backend `EarningsService` — flow по `CompanyDivision.code`,
 *     fallback ENV `CUTTER_B2B_SEWING_PERCENT`, marketplace 1-в-1;
 *   - frontend — поле в форме сотрудника-закройщика.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CUTTER_COMPENSATION_SCHEMES,
  CUTTER_COMPENSATION_SCHEME_LABELS,
  getCutterCompensationSchemeForDivision,
} from '@sewing/shared/cutter-compensation';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('shared/cutter-compensation', () => {
  test('CUTTER_COMPENSATION_SCHEMES содержит ровно две схемы', () => {
    expect(CUTTER_COMPENSATION_SCHEMES).toEqual([
      'MARKETPLACE_FIXED',
      'B2B_SEWING_PERCENT',
    ]);
  });

  test('CUTTER_COMPENSATION_SCHEME_LABELS даёт человекочитаемые подписи', () => {
    expect(CUTTER_COMPENSATION_SCHEME_LABELS.MARKETPLACE_FIXED).toBe(
      'Фиксированная схема Marketplace',
    );
    expect(CUTTER_COMPENSATION_SCHEME_LABELS.B2B_SEWING_PERCENT).toBe(
      'Процент от операций пошива B2B',
    );
  });

  test('getCutterCompensationSchemeForDivision: MARKETPLACE → MARKETPLACE_FIXED', () => {
    expect(getCutterCompensationSchemeForDivision('MARKETPLACE')).toBe(
      'MARKETPLACE_FIXED',
    );
  });

  test('getCutterCompensationSchemeForDivision: OTHER (legacy B2B) → B2B_SEWING_PERCENT', () => {
    expect(getCutterCompensationSchemeForDivision('OTHER')).toBe(
      'B2B_SEWING_PERCENT',
    );
  });

  test('getCutterCompensationSchemeForDivision: будущий B2B → B2B_SEWING_PERCENT', () => {
    expect(getCutterCompensationSchemeForDivision('B2B')).toBe(
      'B2B_SEWING_PERCENT',
    );
  });

  test('getCutterCompensationSchemeForDivision: null/undefined/неизвестное → B2B_SEWING_PERCENT (безопасный fallback)', () => {
    expect(getCutterCompensationSchemeForDivision(null)).toBe(
      'B2B_SEWING_PERCENT',
    );
    expect(getCutterCompensationSchemeForDivision(undefined)).toBe(
      'B2B_SEWING_PERCENT',
    );
    expect(getCutterCompensationSchemeForDivision('SOMETHING_NEW')).toBe(
      'B2B_SEWING_PERCENT',
    );
  });
});

describe('shared/employees — DTO содержит cutterB2bSewingPercent', () => {
  test('CreateEmployeeSchema принимает cutterB2bSewingPercent', () => {
    const src = readSrc('packages/shared/src/employees.ts');
    expect(src).toMatch(/CreateEmployeeSchema/);
    expect(src).toMatch(/cutterB2bSewingPercent:/);
  });

  test('UpdateEmployeeSchema принимает cutterB2bSewingPercent', () => {
    const src = readSrc('packages/shared/src/employees.ts');
    expect(src).toMatch(/UpdateEmployeeSchema/);
    // В `UpdateEmployeeSchema` поле опционально — для backward-compat
    // и чтобы старые клиенты могли продолжать апдейтить только
    // compensationType/salaryPerShift/active без изменения процента.
    expect(src).toMatch(/cutterB2bSewingPercent: CutterB2bSewingPercentField\.optional/);
  });

  test('EmployeeDetailDto объявляет nullable cutterB2bSewingPercent', () => {
    const src = readSrc('packages/shared/src/employees.ts');
    expect(src).toMatch(/cutterB2bSewingPercent\?: number \| null/);
  });
});

describe('Prisma — Employee.cutterB2bSewingPercent Decimal(5, 2)', () => {
  test('schema.prisma содержит nullable cutterB2bSewingPercent Decimal(5, 2)', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(
      /cutterB2bSewingPercent\s+Decimal\?\s+@db\.Decimal\(5,\s*2\)/,
    );
  });

  test('migration 20260528100000_add_employee_cutter_b2b_sewing_percent существует и additive', () => {
    const migrationPath =
      'prisma/migrations/20260528100000_add_employee_cutter_b2b_sewing_percent/migration.sql';
    expect(existsSync(path.join(repoRoot, migrationPath))).toBe(true);

    const sql = readSrc(migrationPath);
    expect(sql).toMatch(/ALTER TABLE "Employee"/);
    expect(sql).toMatch(/ADD COLUMN "cutterB2bSewingPercent"/);
    expect(sql).toMatch(/DECIMAL\(5,\s*2\)/);
    // Никаких destructive-операций — миграция строго additive.
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER TYPE/i);
    expect(sql).not.toMatch(/RENAME/i);
  });
});

describe('backend EarningsService — две схемы по CompanyDivision.code', () => {
  const earningsSrc = readSrc(
    'apps/api/src/modules/earnings/earnings.service.ts',
  );

  test('createImmediateForCutter — единая точка входа триггера PASSPORT_CREATED не меняется', () => {
    expect(earningsSrc).toMatch(/createImmediateForCutter\(/);
    // Триггер: тот же `EarningSource.PASSPORT_CREATED`, тот же
    // `ApprovalMode.IMMEDIATE`, тот же `EntryStatus.APPROVED`.
    // См. recon §10 — переносить триггер на другой event без отдельного
    // ТЗ нельзя.
    expect(earningsSrc).toMatch(/EarningSource\.PASSPORT_CREATED/);
    expect(earningsSrc).toMatch(/ApprovalMode\.IMMEDIATE/);
    expect(earningsSrc).toMatch(/EntryStatus\.APPROVED/);
  });

  test('createImmediateForCutter использует getCutterCompensationSchemeForDivision', () => {
    expect(earningsSrc).toMatch(/getCutterCompensationSchemeForDivision/);
    expect(earningsSrc).toMatch(/from '@sewing\/shared\/cutter-compensation'/);
  });

  test('createImmediateForCutter ветвится по схеме MARKETPLACE_FIXED / B2B_SEWING_PERCENT', () => {
    expect(earningsSrc).toMatch(/createImmediateForCutterMarketplace/);
    expect(earningsSrc).toMatch(/createImmediateForCutterB2b/);
    expect(earningsSrc).toMatch(/MARKETPLACE_FIXED/);
    expect(earningsSrc).toMatch(/B2B_SEWING_PERCENT/);
  });

  test('B2B-flow читает employee.cutterB2bSewingPercent и fallback ENV', () => {
    expect(earningsSrc).toMatch(/cutterB2bSewingPercent: true/);
    expect(earningsSrc).toMatch(/CUTTER_B2B_SEWING_PERCENT/);
    expect(earningsSrc).toMatch(/process\.env\[CUTTER_B2B_SEWING_PERCENT_ENV\]/);
  });

  test('B2B-flow считает базу по операциям категории SEWING из маршрута', () => {
    expect(earningsSrc).toMatch(/calculateB2bSewingOperationBaseForPassport/);
    expect(earningsSrc).toMatch(/OperationCategory\.SEWING/);
    // Учитывает все три pricingMode-режима.
    expect(earningsSrc).toMatch(/pricingMode === 'FIXED'/);
    expect(earningsSrc).toMatch(/pricingMode === 'BY_SIZE'/);
    expect(earningsSrc).toMatch(/SALARY_ONLY/);
    // BY_SIZE-ставки берутся из OperationRateBySize по passport.sizeId.
    expect(earningsSrc).toMatch(/operationRateBySize\.findUnique/);
  });

  test('B2B-flow не падает при отсутствии процента — пишет audit warning', () => {
    expect(earningsSrc).toMatch(/CUTTER_B2B_PERCENT_MISSING/);
    expect(earningsSrc).toMatch(
      /Не задан процент начисления закройщика для B2B/,
    );
  });

  test('идемпотентность не сломана: используется тот же safeCreate с P2002 на @@unique', () => {
    // Тот же ключ идемпотентности `(passportId, operationId,
    // employeeId, sourceEventType)` — см. recon §8.
    expect(earningsSrc).toMatch(/private async safeCreate/);
    expect(earningsSrc).toMatch(/P2002/);
  });

  test('createPendingForCompletedOperation (швеи) и approvePendingForPassport остались на месте', () => {
    // Гарантия, что мы не задели payroll швей / упаковочный апрув.
    expect(earningsSrc).toMatch(/createPendingForCompletedOperation\(/);
    expect(earningsSrc).toMatch(/approvePendingForPassport\(/);
  });
});

describe('backend EmployeesService — сохраняет cutterB2bSewingPercent', () => {
  const empSrc = readSrc(
    'apps/api/src/modules/employees/employees.service.ts',
  );

  test('create записывает cutterB2bSewingPercent', () => {
    expect(empSrc).toMatch(/cutterB2bSewingPercent:\s*\n?\s*dto\.cutterB2bSewingPercent/);
  });

  test('update обновляет cutterB2bSewingPercent при наличии в DTO', () => {
    expect(empSrc).toMatch(
      /if \(dto\.cutterB2bSewingPercent !== undefined\)/,
    );
  });

  test('toDetailDto возвращает cutterB2bSewingPercent', () => {
    expect(empSrc).toMatch(/cutterB2bSewingPercent:\s*\n?\s*e\.cutterB2bSewingPercent/);
  });
});

describe('frontend — поле «Процент от операций пошива B2B» в формах сотрудника', () => {
  test('edit-form для роли CUTTER рендерит поле cutterB2bSewingPercent', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/edit-form.tsx');
    expect(src).toMatch(/name="cutterB2bSewingPercent"/);
    expect(src).toMatch(/Процент от операций пошива B2B/);
    expect(src).toMatch(/CUTTER_ROLE/);
  });

  test('create-form для роли CUTTER рендерит поле cutterB2bSewingPercent', () => {
    const src = readSrc('apps/web/app/admin/employees/create-form.tsx');
    expect(src).toMatch(/name="cutterB2bSewingPercent"/);
    expect(src).toMatch(/Процент от операций пошива B2B/);
    expect(src).toMatch(/CUTTER_ROLE/);
  });

  test('actions.ts читает cutterB2bSewingPercent из FormData', () => {
    const src = readSrc('apps/web/app/admin/employees/actions.ts');
    expect(src).toMatch(/cutterB2bSewingPercent/);
    // Update-flow различает "ключа нет" vs "пустая строка" — см.
    // комментарий в actions.ts.
    expect(src).toMatch(/form\.has\('cutterB2bSewingPercent'\)/);
  });
});

describe('frontend — admin-форма заказа использует CompanyDivision-селект', () => {
  test('admin/orders/new и admin/orders/[id]/edit рендерят select companyDivisionId', () => {
    const create = readSrc(
      'apps/web/app/admin/orders/new/admin-create-order-form.tsx',
    );
    expect(create).toMatch(/name="companyDivisionId"/);
    expect(create).toMatch(/CompanyDivisionDto/);

    const edit = readSrc(
      'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx',
    );
    expect(edit).toMatch(/name="companyDivisionId"/);
    expect(edit).toMatch(/CompanyDivisionDto/);
  });
});
