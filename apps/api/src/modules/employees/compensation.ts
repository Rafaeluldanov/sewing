import { CompensationType } from '@prisma/client';

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
 * Должен ли быть задан `Employee.salaryPerHour > 0` для этого типа?
 *
 * Тождественно `isSalaryEligible`: почасовую ставку требуем ровно
 * тогда, когда сотрудник получает оклад. Заведено отдельным именем,
 * чтобы guard в `EmployeesService.create/update` читался как
 * «требуется ставка», а не как «получает оклад» — это два разных
 * вопроса с одним ответом на сегодня, и они могут разъехаться.
 */
export function requiresSalaryRate(type: CompensationType): boolean {
  return isSalaryEligible(type);
}
