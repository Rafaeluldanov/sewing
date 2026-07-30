/**
 * Контракты производственного календаря (`PayrollCalendarMonth`,
 * 29.07.2026) — норма рабочих дней и часов на календарный месяц.
 *
 * Зачем он существует. Месячный оклад (`SalaryRateMode.MONTHLY`)
 * начисляется ЦЕЛИКОМ одной строкой за месяц, и для самой суммы норма
 * не нужна. Но система обязана уметь превращать месячный оклад в
 * ₽/час: этим курсом считаются доплата за подкрой (`SalaryEntrySource.
 * RECUT`), ₽/минуту простоя в производственном дашборде и разнос
 * оклада на себестоимость. Курс = `salaryPerMonth / normHours`, а
 * норма у каждого месяца своя (переносы праздников из даты не
 * выводятся) — отсюда справочник, который ведёт менеджер.
 *
 * Контракт — `docs/api.md §31a`. UI — `/admin/payroll/calendar`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Поля
// ---------------------------------------------------------------------------

/**
 * Год строки календаря. Границы намеренно широкие, но конечные —
 * защита от опечатки вида `20026`, которая иначе тихо создала бы
 * строку, невидимую ни в одном году на экране.
 */
const YearField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num = typeof v === 'string' ? Number(v.trim()) : v;
    if (!Number.isInteger(num)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Год — целое число' });
      return z.NEVER;
    }
    if (num < 2000 || num > 2100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Год должен быть в диапазоне 2000–2100',
      });
      return z.NEVER;
    }
    return num;
  });

/** Месяц 1..12 (январь = 1), как в человеческом календаре. */
const MonthField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num = typeof v === 'string' ? Number(v.trim()) : v;
    if (!Number.isInteger(num) || num < 1 || num > 12) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Месяц — целое число от 1 до 12',
      });
      return z.NEVER;
    }
    return num;
  });

/**
 * Норма рабочих дней месяца. Верхняя граница 31 — больше дней в
 * месяце физически нет; ноль допустим (месяц целиком нерабочий —
 * теоретический, но валидный случай).
 */
const NormDaysField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isInteger(num) || num < 0 || num > 31) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма дней — целое число от 0 до 31',
      });
      return z.NEVER;
    }
    return num;
  });

/**
 * Норма рабочих часов месяца — ЗНАМЕНАТЕЛЬ производной почасовой
 * ставки месячника. Дробная (167.4 из-за предпраздничных сокращённых
 * дней), строго положительная: ноль означал бы деление на ноль в
 * `resolveEffectiveHourlyRate`.
 */
const NormHoursField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма часов должна быть числом',
      });
      return z.NEVER;
    }
    if (num <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма часов должна быть больше нуля',
      });
      return z.NEVER;
    }
    if (num > 744) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма часов больше, чем часов в месяце',
      });
      return z.NEVER;
    }
    return Math.round(num * 100) / 100;
  });

// ---------------------------------------------------------------------------
// Query / Body
// ---------------------------------------------------------------------------

/** `GET /api/payroll-calendar?year=2026` — год опционален (все года). */
export const ListPayrollCalendarQuerySchema = z.object({
  year: YearField.optional(),
});
export type ListPayrollCalendarQuery = z.infer<
  typeof ListPayrollCalendarQuerySchema
>;

/**
 * Тело `PUT /api/payroll-calendar` — идемпотентный upsert строки
 * месяца. Отдельных POST/PATCH нет сознательно: у строки естественный
 * ключ `(year, month)`, и «создать» от «поправить» здесь ничем не
 * отличается — менеджер просто заполняет клетку календаря.
 */
export const UpsertPayrollCalendarMonthSchema = z.object({
  year: YearField,
  month: MonthField,
  normDays: NormDaysField,
  normHours: NormHoursField,
  comment: z
    .union([z.string(), z.null()])
    .transform((v) => {
      if (v === null) return null;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed.slice(0, 500);
    })
    .optional(),
});
export type UpsertPayrollCalendarMonthDto = z.infer<
  typeof UpsertPayrollCalendarMonthSchema
>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface PayrollCalendarMonthDto {
  id: string;
  year: number;
  month: number;
  normDays: number;
  normHours: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers (общие для UI и сервера)
// ---------------------------------------------------------------------------

export const MONTH_LABELS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

/** «Июль 2026» для заголовков строк календаря и ведомости. */
export function formatMonthLabel(year: number, month: number): string {
  const name = MONTH_LABELS[month - 1] ?? `Месяц ${month}`;
  return `${name} ${year}`;
}

/**
 * Длина рабочего дня, от которой считаются дефолты формы. Не
 * настройка: это подсказка «сколько примерно», менеджер правит
 * norm-часы руками, если у цеха другой график.
 */
export const STANDARD_WORK_DAY_HOURS = 8;

/**
 * Черновая норма месяца: количество будних дней (пн–пт) × 8 часов.
 *
 * Праздники и переносы НЕ учитывает — государственный календарь в
 * системе не хранится и хранить его ради двух чисел в месяц
 * несоразмерно. Используется как значение по умолчанию в форме, чтобы
 * менеджер правил одну-две цифры, а не вбивал все двенадцать месяцев
 * с нуля.
 */
export function defaultMonthNorm(
  year: number,
  month: number,
): { normDays: number; normHours: number } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let workdays = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow !== 0 && dow !== 6) workdays += 1;
  }
  return {
    normDays: workdays,
    normHours: workdays * STANDARD_WORK_DAY_HOURS,
  };
}

/**
 * Первое число месяца в UTC — канонический `SalaryEntry.date` для
 * месячного оклада (`source = MONTH_SALARY`). Общая функция, потому
 * что этой датой и пишут (сервер), и фильтруют/показывают (UI), и
 * разъехаться им нельзя: `@@unique(employeeId, date, source)`
 * молча создал бы вторую строку за тот же месяц.
 */
export function startOfMonthUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}
