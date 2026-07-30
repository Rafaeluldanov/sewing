import { CompensationType, SalaryRateMode } from '@prisma/client';

/**
 * Доменные правила payroll-eligibility (ADR-0021 + post-задача
 * «remove `paymentType`»).
 *
 * Со Шага 19 единственная ось «как платим» — `Employee.compensationType`.
 * Он одновременно гейтит два контура:
 *
 *   - сдельный (`OperationEntry`, `EarningsService`) — `PIECEWORK` и
 *     `MIXED` участвуют, `SALARY` тихо пропускается;
 *   - окладной (`SalaryEntry`, `SalaryService`) — `SALARY` и `MIXED`
 *     получают дневной оклад, `PIECEWORK` — нет.
 *
 * До этого cleanup-а ровно те же сравнения были размазаны прямыми
 * `if (compensationType === 'SALARY')` / `(=== 'SALARY' || === 'MIXED')`
 * по `EarningsService` / `SalaryService` / `CostsService` /
 * `DashboardService` / `EmployeesService`. Каждое такое место — место,
 * где легко однажды забыть про `MIXED` и сломать инвариант. Эти три
 * pure-функции собирают правило в одну точку, чтобы изменить семантику
 * (если когда-нибудь придётся) можно было ровно здесь, а не охотиться
 * по сервисам.
 *
 * Семантика — таблица из `docs/domain.md §9a`:
 *
 *   | compensationType | piecework eligible | salary eligible |
 *   | ---------------- | ------------------ | --------------- |
 *   | PIECEWORK        | да                 | нет             |
 *   | SALARY           | нет                | да              |
 *   | MIXED            | да                 | да              |
 */

/**
 * Получает ли сотрудник сдельные `OperationEntry`?
 *
 * `true` для `PIECEWORK` и `MIXED`, `false` только для `SALARY`.
 * Используется в `EarningsService` как gate перед созданием
 * `OperationEntry` (и в любых местах, которые повторяют то же
 * правило — например, аналитика/cost).
 */
export function isPieceworkEligible(type: CompensationType): boolean {
  return type !== CompensationType.SALARY;
}

/**
 * Получает ли сотрудник окладной `SalaryEntry` за день со сменой?
 *
 * `true` для `SALARY` и `MIXED`, `false` только для `PIECEWORK`.
 * Используется в `SalaryService.syncDailySalary` и в местах, которые
 * считают «у этого человека есть оплачиваемая ставка за день» —
 * `CostsService.minuteRate`, `DashboardService.roleLoad`/idle.
 */
export function isSalaryEligible(type: CompensationType): boolean {
  return (
    type === CompensationType.SALARY || type === CompensationType.MIXED
  );
}

/**
 * Должен ли быть задан `Employee.salaryPerHour > 0`?
 *
 * С появлением месячного оклада (29.07.2026) ответ зависит уже от
 * ДВУХ полей: человек получает оклад (`isSalaryEligible`) И ставка
 * назначена в часах (`salaryRateMode = HOURLY`). У месячника
 * `salaryPerHour` пустой законно — его ₽/час производные от нормы
 * часов месяца (`salary-rate.ts`).
 */
export function requiresHourlyRate(
  type: CompensationType,
  mode: SalaryRateMode,
): boolean {
  return isSalaryEligible(type) && mode === SalaryRateMode.HOURLY;
}

/**
 * Должен ли быть задан `Employee.salaryPerMonth > 0`? Зеркало
 * `requiresHourlyRate` для режима `MONTHLY`.
 */
export function requiresMonthlyRate(
  type: CompensationType,
  mode: SalaryRateMode,
): boolean {
  return isSalaryEligible(type) && mode === SalaryRateMode.MONTHLY;
}

/**
 * Получает ли сотрудник ДНЕВНЫЕ окладные строки
 * (`SalaryEntrySource.SHIFT_DAY`)?
 *
 * Ровно почасовые окладники. Месячник получает одну строку
 * `MONTH_SALARY` на месяц, и дневные строки ему создавать нельзя —
 * это было бы двойной оплатой тех же часов. Правило вынесено сюда,
 * чтобы у `SalaryService.syncDailySalary` и у любых будущих
 * пересчётов ведомости был один источник истины.
 */
export function isDailySalaryEligible(
  type: CompensationType,
  mode: SalaryRateMode,
): boolean {
  return isSalaryEligible(type) && mode === SalaryRateMode.HOURLY;
}

/**
 * Получает ли сотрудник МЕСЯЧНУЮ окладную строку
 * (`SalaryEntrySource.MONTH_SALARY`)? Зеркало
 * `isDailySalaryEligible`.
 */
export function isMonthlySalaryEligible(
  type: CompensationType,
  mode: SalaryRateMode,
): boolean {
  return isSalaryEligible(type) && mode === SalaryRateMode.MONTHLY;
}
