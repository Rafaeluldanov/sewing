import { Prisma, SalaryRateMode } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Производная почасовая ставка окладника (29.07.2026, вместе с
 * `SalaryRateMode.MONTHLY`).
 *
 * Проблема, которую решает файл. С появлением месячного оклада
 * `Employee.salaryPerHour` перестал быть единственным ответом на
 * вопрос «сколько стоит час этого человека». У месячника он пустой,
 * но час всё равно нужно уметь считать — минимум в трёх местах:
 *
 *   - доплата за подкрой (`SalaryEntrySource.RECUT`) — почасовая по
 *     своей природе, и месячник без неё просто терял бы деньги;
 *   - ₽/минуту простоя в производственном дашборде;
 *   - разнос оклада на себестоимость (`CostsService`).
 *
 * Курс перевода — `salaryPerMonth / нормаЧасов(месяц)` из
 * производственного календаря `PayrollCalendarMonth`. Норма берётся
 * по месяцу КОНКРЕТНОЙ даты, а не «в среднем за год»: в январе и в
 * июле час месячника стоит по-разному, и в ведомости это должно быть
 * видно.
 *
 * ВАЖНО: на сумму самого месячного оклада норма не влияет —
 * `MONTH_SALARY` начисляется целиком (см. `enum SalaryRateMode`).
 */

/**
 * Норма часов, которую берём, если строки календаря на этот месяц
 * ещё нет: 21 рабочий день × 8 часов.
 *
 * Альтернатива — не считать ставку вовсе — молча съедала бы доплату
 * за подкрой и занижала себестоимость, причём незаметно: ошибка
 * всплыла бы только при сверке ведомости. Приблизительная ставка
 * заметно лучше нулевой; экран `/admin/payroll/calendar` подсвечивает
 * незаполненные месяцы, чтобы приближение не стало постоянным.
 */
export const DEFAULT_MONTH_NORM_HOURS = 168;

/** Минимальная проекция сотрудника, достаточная для расчёта ставки. */
export interface SalaryRateSource {
  salaryRateMode: SalaryRateMode;
  salaryPerHour: Prisma.Decimal | null;
  salaryPerMonth: Prisma.Decimal | null;
}

/**
 * Норма часов месяца из производственного календаря. `null` не
 * возвращаем никогда — вместо этого падаем на
 * `DEFAULT_MONTH_NORM_HOURS`, чтобы вызывающий код не разводил
 * ветвление «а если календарь не заполнен».
 */
export async function resolveMonthNormHours(
  tx: Prisma.TransactionClient | PrismaService,
  date: Date,
): Promise<Prisma.Decimal> {
  const row = await tx.payrollCalendarMonth.findUnique({
    where: {
      PayrollCalendarMonth_year_month_uniq: {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
      },
    },
    select: { normHours: true },
  });
  if (!row || row.normHours.lessThanOrEqualTo(0)) {
    return new Prisma.Decimal(DEFAULT_MONTH_NORM_HOURS);
  }
  return row.normHours;
}

/**
 * Ставка ₽/час для расчётов, которым нужен именно час:
 *   - `HOURLY`  → `salaryPerHour` как есть;
 *   - `MONTHLY` → `salaryPerMonth / нормаЧасов(месяц даты)`.
 *
 * `null` — часовую стоимость посчитать нечем (ставка не задана или
 * не положительная). Вызывающий код обязан относиться к этому как к
 * «строку не создаём», а не «ставка = 0»: нулевая сумма в ведомости
 * выглядит как честно посчитанный ноль и скрывает незаполненное поле.
 */
export async function resolveEffectiveHourlyRate(
  tx: Prisma.TransactionClient | PrismaService,
  employee: SalaryRateSource,
  date: Date,
): Promise<Prisma.Decimal | null> {
  if (employee.salaryRateMode === SalaryRateMode.MONTHLY) {
    const monthly = employee.salaryPerMonth;
    if (monthly === null || monthly.lessThanOrEqualTo(0)) return null;
    const normHours = await resolveMonthNormHours(tx, date);
    return monthly.div(normHours).toDecimalPlaces(2);
  }
  const hourly = employee.salaryPerHour;
  if (hourly === null || hourly.lessThanOrEqualTo(0)) return null;
  return hourly;
}

/**
 * Синхронный вариант для мест, где сотрудники загружены пачкой и
 * лишний запрос на календарь в цикле недопустим (дашборд, разнос
 * себестоимости): норма часов передаётся снаружи одним значением на
 * период.
 */
export function effectiveHourlyRateWithNorm(
  employee: SalaryRateSource,
  normHours: Prisma.Decimal | number,
): Prisma.Decimal | null {
  if (employee.salaryRateMode === SalaryRateMode.MONTHLY) {
    const monthly = employee.salaryPerMonth;
    if (monthly === null || monthly.lessThanOrEqualTo(0)) return null;
    const norm = new Prisma.Decimal(normHours);
    if (norm.lessThanOrEqualTo(0)) return null;
    return monthly.div(norm).toDecimalPlaces(2);
  }
  const hourly = employee.salaryPerHour;
  if (hourly === null || hourly.lessThanOrEqualTo(0)) return null;
  return hourly;
}
