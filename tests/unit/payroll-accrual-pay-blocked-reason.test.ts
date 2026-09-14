/**
 * Unit — правило «строка ведомости с начислениями и к выплате < 0»
 * (аудит движка расчёта 13.09.2026, K1) на стороне shared/web:
 *   - `isNonPositiveAccrualLine` (`packages/shared/src/payroll-accrual-documents.ts`) —
 *     то же правило, что и 422 `PAYROLL_ACCRUAL_LINE_NON_POSITIVE` сервера;
 *   - `getPayBlockedReason` (`apps/web/app/admin/payroll/accrual-documents/accrual-document-ui.ts`)
 *     — раньше всегда `null`; теперь блокирует «Выплатить» и называет сотрудников.
 *
 * Ревью K1: полный зачёт «в ноль» (нетто ровно 0) — штатный случай, сервер
 * проводит его выплатой на 0 ₽; правило и кнопка его НЕ блокируют.
 */
import { describe, expect, test } from 'vitest';
import {
  isNonPositiveAccrualLine,
  type PayrollAccrualDocumentDto,
  type PayrollAccrualDocumentLineDto,
} from '../../packages/shared/src/payroll-accrual-documents';
import {
  canPayDocument,
  getPayBlockedReason,
} from '../../apps/web/app/admin/payroll/accrual-documents/accrual-document-ui';

function line(
  over: Partial<PayrollAccrualDocumentLineDto> & {
    amountPieceworkRub: number;
    amountSalaryRub: number;
    manualAdjustRub: number;
  },
): PayrollAccrualDocumentLineDto {
  const amountToPayRub =
    over.amountToPayRub ??
    over.amountPieceworkRub + over.amountSalaryRub + over.manualAdjustRub;
  return {
    id: over.id ?? 'line',
    documentId: 'doc',
    employeeId: over.employeeId ?? 'emp',
    employee: over.employee ?? { id: over.employeeId ?? 'emp', fullName: 'Иванова А.', role: 'SEAMSTRESS' },
    manualComment: null,
    payoutId: null,
    snapshot: null,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    ...over,
    amountToPayRub,
  };
}

function doc(lines: PayrollAccrualDocumentLineDto[], status: PayrollAccrualDocumentDto['status'] = 'DRAFT'): PayrollAccrualDocumentDto {
  return {
    id: 'doc',
    accrualDate: '2026-04-30',
    status,
    employeeId: null,
    employee: null,
    totalPieceworkRub: lines.reduce((s, l) => s + l.amountPieceworkRub, 0),
    totalSalaryRub: lines.reduce((s, l) => s + l.amountSalaryRub, 0),
    totalAdjustRub: lines.reduce((s, l) => s + l.manualAdjustRub, 0),
    totalToPayRub: lines.reduce((s, l) => s + l.amountToPayRub, 0),
    managerComment: null,
    createdById: 'mgr',
    paidById: null,
    cancelledById: null,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    paidAt: null,
    cancelledAt: null,
    cancelReason: null,
    externalPaymentRef: null,
    lines,
  };
}

describe('isNonPositiveAccrualLine (K1)', () => {
  test('зачёт аванса «в ноль»: 5 000 / −5 000 → false (ревью K1: выплата на 0 ₽ закрывает начисления)', () => {
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 5000, amountSalaryRub: 0, manualAdjustRub: -5000 }))).toBe(false);
  });

  test('удержание больше начислений: 5 000 / −6 000 → true', () => {
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 5000, amountSalaryRub: 0, manualAdjustRub: -6000 }))).toBe(true);
  });

  test('удержание больше начислений на копейку: 5 000 / −5 000,01 → true', () => {
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 5000, amountSalaryRub: 0, manualAdjustRub: -5000.01 }))).toBe(true);
  });

  test('оклад тоже считается начислением: 0 + 2 000 / −2 500 → true; 0 + 2 000 / −2 000 → false', () => {
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 0, amountSalaryRub: 2000, manualAdjustRub: -2500 }))).toBe(true);
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 0, amountSalaryRub: 2000, manualAdjustRub: -2000 }))).toBe(false);
  });

  test('граница: 5 000 / −4 999 → false (нетто 1 ₽ — выплата закроет начисления)', () => {
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 5000, amountSalaryRub: 0, manualAdjustRub: -4999 }))).toBe(false);
  });

  test('строка без начислений с одним удержанием 0 / −500 → false (правило не задевает)', () => {
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 0, amountSalaryRub: 0, manualAdjustRub: -500 }))).toBe(false);
  });

  test('положительная корректировка → false', () => {
    expect(isNonPositiveAccrualLine(line({ amountPieceworkRub: 100, amountSalaryRub: 0, manualAdjustRub: 50 }))).toBe(false);
  });
});

describe('getPayBlockedReason (K1)', () => {
  test('без проблемных строк → null, кнопка доступна', () => {
    const d = doc([
      line({ amountPieceworkRub: 5000, amountSalaryRub: 0, manualAdjustRub: -4999 }),
      line({ id: 'b', employeeId: 'b', amountPieceworkRub: 3000, amountSalaryRub: 0, manualAdjustRub: 0 }),
    ]);
    expect(getPayBlockedReason(d)).toBeNull();
    expect(canPayDocument(d)).toBe(true);
  });

  test('строка без начислений с одним удержанием не блокирует (как раньше)', () => {
    expect(getPayBlockedReason(doc([line({ amountPieceworkRub: 0, amountSalaryRub: 0, manualAdjustRub: -500 })]))).toBeNull();
  });

  test('полный зачёт «в ноль» 5 000 / −5 000 не блокирует (ревью K1)', () => {
    const d = doc([line({ amountPieceworkRub: 5000, amountSalaryRub: 0, manualAdjustRub: -5000 })]);
    expect(getPayBlockedReason(d)).toBeNull();
    expect(canPayDocument(d)).toBe(true);
  });

  test('строка «начисления есть, к выплате < 0» → причина с именем сотрудника и суммами', () => {
    const reason = getPayBlockedReason(
      doc([
        line({
          employee: { id: 'a', fullName: 'Иванова А.', role: 'SEAMSTRESS' },
          amountPieceworkRub: 5000,
          amountSalaryRub: 0,
          manualAdjustRub: -6000,
        }),
        line({
          id: 'b',
          employeeId: 'b',
          employee: { id: 'b', fullName: 'Петров Б.', role: 'CUTTER' },
          amountPieceworkRub: 3000,
          amountSalaryRub: 0,
          manualAdjustRub: 0,
        }),
      ]),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('Иванова А.');
    expect(reason).toContain('следующую ведомость');
    // Соседняя строка без проблем в причине не упоминается.
    expect(reason).not.toContain('Петров Б.');
  });

  test('несколько проблемных строк перечислены все', () => {
    const reason = getPayBlockedReason(
      doc([
        line({ id: 'a', employee: { id: 'a', fullName: 'Иванова А.', role: 'SEAMSTRESS' }, amountPieceworkRub: 5000, amountSalaryRub: 0, manualAdjustRub: -6000 }),
        line({ id: 'b', employee: { id: 'b', fullName: 'Петров Б.', role: 'CUTTER' }, amountPieceworkRub: 0, amountSalaryRub: 2000, manualAdjustRub: -2500 }),
      ]),
    );
    expect(reason).toContain('Иванова А.');
    expect(reason).toContain('Петров Б.');
  });
});
