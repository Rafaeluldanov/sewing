/**
 * Smoke-тесты «Месячный оклад» (29.07.2026).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем регрессы прямо в исходниках — тот же паттерн, что
 * у остальных smoke-наборов.
 *
 * Что охраняем:
 *
 *   1. ДВОЙНАЯ ОПЛАТА. У сотрудника с `salaryRateMode = MONTHLY` не
 *      должно появляться дневных строк `SHIFT_DAY` — иначе он получит
 *      и месячный оклад, и повременку за те же часы. Диспетчер живёт
 *      в `SalaryService.syncDailySalary`.
 *   2. ПОЛНАЯ СУММА. Месячная строка = `salaryPerMonth` целиком, без
 *      деления на отработанные дни (пропорцию по табелю считать нечем:
 *      отпусков и больничных в системе нет).
 *   3. ПОТЕРЯННЫЕ ДОПЛАТЫ. Всё, что считает ₽/час, должно ходить через
 *      `resolveEffectiveHourlyRate` — у месячника `salaryPerHour`
 *      пустой, и прямое чтение колонки молча обнуляет доплату за
 *      подкрой, простой в дашборде и разнос оклада на себестоимость.
 *   4. ОБЯЗАТЕЛЬНОСТЬ СТАВКИ. Правило «какая из двух ставок
 *      обязательна» живёт в shared и переиспользуется формой и
 *      backend-ом, а не дублируется сравнениями строк.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Схема и миграция
// ---------------------------------------------------------------------------

describe('Месячный оклад — схема', () => {
  test('enum SalaryRateMode и поля Employee заведены', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/enum SalaryRateMode \{\s*\n\s*HOURLY\s*\n\s*MONTHLY/);
    expect(schema).toMatch(/salaryRateMode\s+SalaryRateMode\s+@default\(HOURLY\)/);
    expect(schema).toMatch(/salaryPerMonth\s+Decimal\?\s+@db\.Decimal\(12, 2\)/);
  });

  test('SalaryEntrySource знает MONTH_SALARY', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/enum SalaryEntrySource[\s\S]*MONTH_SALARY[\s\S]*\n\}/);
  });

  test('производственный календарь: (year, month) уникальны', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/model PayrollCalendarMonth \{/);
    expect(schema).toMatch(
      /@@unique\(\[year, month\], name: "PayrollCalendarMonth_year_month_uniq"\)/,
    );
  });

  test('дефолт HOURLY в миграции — бэкфилл не меняет расчёт существующим', () => {
    const sql = readSrc(
      'prisma/migrations/20261004100000_salary_rate_mode_monthly/migration.sql',
    );
    expect(sql).toMatch(/"SalaryRateMode" NOT NULL DEFAULT 'HOURLY'/);
    expect(sql).toMatch(/ALTER TYPE "SalaryEntrySource" ADD VALUE 'MONTH_SALARY'/);
    expect(sql).toMatch(/CREATE TABLE "PayrollCalendarMonth"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Начисление: месячник не получает дневных строк
// ---------------------------------------------------------------------------

describe('Месячный оклад — начисление', () => {
  const service = readSrc('apps/api/src/modules/salary/salary.service.ts');

  test('syncDailySalary уводит месячника в syncMonthlySalary', () => {
    expect(service).toMatch(/isMonthlySalaryEligible\(/);
    expect(service).toMatch(/return this\.syncMonthlySalary\(/);
  });

  test('месячная строка = полный salaryPerMonth, без деления на дни', () => {
    expect(service).toMatch(/const amount = roundMoney\(employee\.salaryPerMonth\)/);
    // Никаких «оклад / дни» в месячной ветке.
    expect(service).not.toMatch(/salaryPerMonth[\s\S]{0,80}\.div\(/);
  });

  test('ключ месячной строки — 1-е число месяца + MONTH_SALARY', () => {
    expect(service).toMatch(/startOfMonthUtc\(/);
    expect(service).toMatch(/source: SalaryEntrySource\.MONTH_SALARY/);
  });

  test('reset пересчитывает месячную строку месячной же формулой', () => {
    expect(service).toMatch(
      /entry\.source === SalaryEntrySource\.MONTH_SALARY/,
    );
  });

  test('eligibility-правила не дублируются сравнениями строк в сервисе', () => {
    const compensation = readSrc(
      'apps/api/src/modules/employees/compensation.ts',
    );
    expect(compensation).toMatch(/export function isDailySalaryEligible/);
    expect(compensation).toMatch(/export function isMonthlySalaryEligible/);
    expect(service).not.toMatch(/salaryRateMode === 'MONTHLY'/);
  });
});

// ---------------------------------------------------------------------------
// 3. Производный ₽/час — потребители
// ---------------------------------------------------------------------------

describe('Месячный оклад — производная ставка ₽/час', () => {
  test('единая точка расчёта с fallback-нормой', () => {
    const rate = readSrc('apps/api/src/modules/salary/salary-rate.ts');
    expect(rate).toMatch(/export const DEFAULT_MONTH_NORM_HOURS = 168/);
    expect(rate).toMatch(/export async function resolveEffectiveHourlyRate/);
    expect(rate).toMatch(/export function effectiveHourlyRateWithNorm/);
    // Норма читается из производственного календаря.
    expect(rate).toMatch(/payrollCalendarMonth\.findUnique/);
  });

  test('доплата за подкрой не читает salaryPerHour напрямую', () => {
    const salary = readSrc('apps/api/src/modules/salary/salary.service.ts');
    const recut = readSrc('apps/api/src/modules/recut/recut.service.ts');
    expect(salary).toMatch(/resolveEffectiveHourlyRate\(/);
    expect(recut).toMatch(/resolveEffectiveHourlyRate\(/);
    expect(recut).not.toMatch(/employee\?\.salaryPerHour \?\? null/);
  });

  test('дашборд и себестоимость считают минуту через ставку месяца', () => {
    for (const file of [
      'apps/api/src/modules/dashboard/dashboard.service.ts',
      'apps/api/src/modules/costs/costs.service.ts',
      'apps/api/src/modules/costs/passport-real-cost.service.ts',
    ]) {
      const src = readSrc(file);
      expect(src).toMatch(/effectiveHourlyRateWithNorm\(/);
      expect(src).toMatch(/resolveMonthNormHours\(/);
      expect(src).not.toMatch(/computeMinuteRate\(e\.salaryPerHour\)/);
    }
  });

  test('дашборд считает «был на смене» по сменам, а не только по SalaryEntry', () => {
    const src = readSrc('apps/api/src/modules/dashboard/dashboard.service.ts');
    // У месячника дневных SalaryEntry нет — по старому признаку он
    // пропал бы из загрузки ролей во все дни, кроме первого.
    expect(src).toMatch(/presentEmployeeIds/);
    expect(src).toMatch(/shiftSession\.findMany/);
  });
});

// ---------------------------------------------------------------------------
// 4. Контракт и формы
// ---------------------------------------------------------------------------

describe('Месячный оклад — контракт и UI', () => {
  test('правило обязательности ставки живёт в shared', () => {
    const shared = readSrc('packages/shared/src/employees.ts');
    expect(shared).toMatch(/export function requiresHourlySalaryRate/);
    expect(shared).toMatch(/export function requiresMonthlySalaryRate/);
    expect(shared).toMatch(/SALARY_RATE_MODE_LABELS/);
  });

  test('backend проверяет ставку по итоговой паре (тип, режим)', () => {
    const src = readSrc('apps/api/src/modules/employees/employees.service.ts');
    expect(src).toMatch(/requiresHourlyRate\(next\.compensationType, next\.salaryRateMode\)/);
    expect(src).toMatch(/requiresMonthlyRate\(next\.compensationType, next\.salaryRateMode\)/);
  });

  test('обе формы сотрудника переиспользуют shared-правило', () => {
    for (const file of [
      'apps/web/app/admin/employees/create-form.tsx',
      'apps/web/app/admin/employees/[id]/edit-form.tsx',
    ]) {
      const src = readSrc(file);
      expect(src).toMatch(/requiresHourlySalaryRate\(/);
      expect(src).toMatch(/requiresMonthlySalaryRate\(/);
      expect(src).toMatch(/name="salaryRateMode"/);
      expect(src).toMatch(/name="salaryPerMonth"/);
    }
  });

  test('server actions шлют режим и обе ставки', () => {
    const src = readSrc('apps/web/app/admin/employees/actions.ts');
    expect(src).toMatch(/salaryRateMode: rateModeRaw/);
    expect(src).toMatch(/dto\.salaryPerMonth = monthly\.value/);
  });

  test('экран производственного календаря подключён к настройкам зарплаты', () => {
    const settings = readSrc('apps/web/app/admin/payroll/settings/page.tsx');
    expect(settings).toMatch(/\/admin\/payroll\/calendar/);
    const page = readSrc('apps/web/app/admin/payroll/calendar/page.tsx');
    expect(page).toMatch(/listPayrollCalendarSafe/);
    expect(page).toMatch(/PayrollCalendarYearForm/);
  });

  test('initial state формы календаря вынесен из use server-модуля', () => {
    const actions = readSrc('apps/web/app/admin/payroll/calendar/actions.ts');
    expect(actions).toMatch(/^'use server';/);
    // `'use server'` разрешает экспортировать только async-функции —
    // константа состояния обязана жить в соседнем модуле.
    expect(actions).not.toMatch(/export const /);
    const formState = readSrc(
      'apps/web/app/admin/payroll/calendar/form-state.ts',
    );
    expect(formState).toMatch(/export const initialPayrollCalendarState/);
  });

  test('«Мой день» не показывает месячнику нулевое дневное начисление', () => {
    const panel = readSrc('apps/web/components/me/daily-earnings-panel.tsx');
    expect(panel).toMatch(/sal\.rateMode === 'MONTHLY'/);
    expect(panel).toMatch(/Оклад за месяц/);
  });
});
