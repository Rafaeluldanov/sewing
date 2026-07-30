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
 * С 29.07.2026 у окладного контура вторая ось — `SalaryRateMode`
 * (часовой / месячный оклад). Главный инвариант, который тут
 * зафиксирован: дневные и месячные начисления ВЗАИМОИСКЛЮЧАЮЩИ —
 * иначе месячник получил бы и оклад, и повременку за те же часы.
 *
 * См. также ADR-0021 §2.1 (post-cleanup секция «pure-функции»).
 */
import { describe, expect, test } from 'vitest';
import { CompensationType, SalaryRateMode } from '@prisma/client';
import {
  isDailySalaryEligible,
  isMonthlySalaryEligible,
  isPieceworkEligible,
  isSalaryEligible,
  requiresHourlyRate,
  requiresMonthlyRate,
} from '@sewing/api/modules/employees/compensation';

const ALL_TYPES = [
  CompensationType.PIECEWORK,
  CompensationType.SALARY,
  CompensationType.MIXED,
] as const;

describe('compensation helpers', () => {
  test('PIECEWORK: только сдельщина', () => {
    expect(isPieceworkEligible(CompensationType.PIECEWORK)).toBe(true);
    expect(isSalaryEligible(CompensationType.PIECEWORK)).toBe(false);
    expect(
      requiresHourlyRate(CompensationType.PIECEWORK, SalaryRateMode.HOURLY),
    ).toBe(false);
    expect(
      requiresMonthlyRate(CompensationType.PIECEWORK, SalaryRateMode.MONTHLY),
    ).toBe(false);
  });

  test('SALARY: только оклад', () => {
    expect(isPieceworkEligible(CompensationType.SALARY)).toBe(false);
    expect(isSalaryEligible(CompensationType.SALARY)).toBe(true);
  });

  test('MIXED: и сдельщина, и оклад', () => {
    expect(isPieceworkEligible(CompensationType.MIXED)).toBe(true);
    expect(isSalaryEligible(CompensationType.MIXED)).toBe(true);
  });

  test('обязательна ровно та ставка, что соответствует режиму', () => {
    for (const type of [CompensationType.SALARY, CompensationType.MIXED]) {
      expect(requiresHourlyRate(type, SalaryRateMode.HOURLY)).toBe(true);
      expect(requiresMonthlyRate(type, SalaryRateMode.HOURLY)).toBe(false);

      expect(requiresHourlyRate(type, SalaryRateMode.MONTHLY)).toBe(false);
      expect(requiresMonthlyRate(type, SalaryRateMode.MONTHLY)).toBe(true);
    }
  });

  test('дневное и месячное начисления взаимоисключающи', () => {
    for (const type of ALL_TYPES) {
      for (const mode of [SalaryRateMode.HOURLY, SalaryRateMode.MONTHLY]) {
        expect(
          isDailySalaryEligible(type, mode) && isMonthlySalaryEligible(type, mode),
        ).toBe(false);
      }
    }
  });

  test('окладник получает ровно один вид начисления', () => {
    for (const type of [CompensationType.SALARY, CompensationType.MIXED]) {
      expect(isDailySalaryEligible(type, SalaryRateMode.HOURLY)).toBe(true);
      expect(isMonthlySalaryEligible(type, SalaryRateMode.MONTHLY)).toBe(true);
    }
    // PIECEWORK не получает никаких окладных строк ни в одном режиме.
    for (const mode of [SalaryRateMode.HOURLY, SalaryRateMode.MONTHLY]) {
      expect(isDailySalaryEligible(CompensationType.PIECEWORK, mode)).toBe(
        false,
      );
      expect(isMonthlySalaryEligible(CompensationType.PIECEWORK, mode)).toBe(
        false,
      );
    }
  });
});
