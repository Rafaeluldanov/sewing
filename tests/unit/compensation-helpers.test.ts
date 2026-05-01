/**
 * Unit-тесты payroll-eligibility helper-ов
 * (`apps/api/src/modules/employees/compensation.ts`).
 *
 * Эти функции — единственное место в backend, где правило «кто
 * получает сдельщину / кто получает оклад» выражается прямыми
 * сравнениями со значениями `CompensationType`. Вся остальная логика
 * (`EarningsService`, `SalaryService`, `CostsService`, `DashboardService`,
 * `EmployeesService`) обращается к этим helper-ам — поэтому здесь же
 * закрепляем таблицу из `docs/domain.md §9a` маленьким unit-кейсом,
 * чтобы случайный refactor не перекосил поведение всех сервисов сразу.
 *
 * См. также ADR-0021 §2.1 (post-cleanup секция «pure-функции»).
 */
import { describe, expect, test } from 'vitest';
import { CompensationType } from '@prisma/client';
import {
  isPieceworkEligible,
  isSalaryEligible,
  requiresSalaryRate,
} from '@sewing/api/modules/employees/compensation';

describe('compensation helpers', () => {
  test('PIECEWORK: только сдельщина', () => {
    expect(isPieceworkEligible(CompensationType.PIECEWORK)).toBe(true);
    expect(isSalaryEligible(CompensationType.PIECEWORK)).toBe(false);
    expect(requiresSalaryRate(CompensationType.PIECEWORK)).toBe(false);
  });

  test('SALARY: только оклад', () => {
    expect(isPieceworkEligible(CompensationType.SALARY)).toBe(false);
    expect(isSalaryEligible(CompensationType.SALARY)).toBe(true);
    expect(requiresSalaryRate(CompensationType.SALARY)).toBe(true);
  });

  test('MIXED: и сдельщина, и оклад', () => {
    expect(isPieceworkEligible(CompensationType.MIXED)).toBe(true);
    expect(isSalaryEligible(CompensationType.MIXED)).toBe(true);
    expect(requiresSalaryRate(CompensationType.MIXED)).toBe(true);
  });

  test('requiresSalaryRate тождествен isSalaryEligible (на сегодня)', () => {
    for (const type of [
      CompensationType.PIECEWORK,
      CompensationType.SALARY,
      CompensationType.MIXED,
    ]) {
      expect(requiresSalaryRate(type)).toBe(isSalaryEligible(type));
    }
  });
});
