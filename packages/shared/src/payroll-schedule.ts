/**
 * Контракты «Расписание начисления зарплаты».
 *
 * Отвечает на два вопроса, которых в системе не было: КОГДА считаем
 * зарплату (дни месяца) и ЧТО попадает в расчёт (правило отсечки).
 * Источник истины — backend (`/api/payroll/schedule`), доменная модель
 * — `prisma/schema.prisma::PayrollAccrualSchedule`.
 *
 * Здесь же живут ЧИСТЫЕ функции календаря (`nextAccrualDate`,
 * `accrualPeriodFor`, ...) — их одинаково зовут и API (отбор строк,
 * автосоздание черновика), и веб (подстановка даты, «ближайшие
 * начисления»). Считать одно и то же двумя реализациями в двух местах
 * — верный способ разъехаться на границе месяца.
 *
 * Все даты в этих функциях — «календарные», без времени: работаем в
 * терминах год-месяц-число по Москве, а не в UTC-таймстампах, иначе
 * ночная смена и день начисления разъезжаются на сутки.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enum (зеркало Prisma)
// ---------------------------------------------------------------------------

export const PAYROLL_CUTOFF_BASES = [
  'ORDER_COMPLETED',
  'PASSPORT_PACKED',
  'WORK_DATE',
] as const;
export const PayrollCutoffBasisSchema = z.enum(PAYROLL_CUTOFF_BASES);
export type PayrollCutoffBasis = z.infer<typeof PayrollCutoffBasisSchema>;

export const PAYROLL_CUTOFF_BASIS_LABELS: Record<PayrollCutoffBasis, string> = {
  ORDER_COMPLETED: 'Заказ закрыт целиком',
  PASSPORT_PACKED: 'Паспорт упакован',
  WORK_DATE: 'День выполнения работы',
};

export const PAYROLL_CUTOFF_BASIS_HINTS: Record<PayrollCutoffBasis, string> = {
  ORDER_COMPLETED:
    'В расчёт входит сдельщина по заказам, закрытым до дня начисления. Заказ в производстве не оплачивается, даже если операции по нему давно завершены.',
  PASSPORT_PACKED:
    'Платим по подтверждённой работе, не дожидаясь закрытия всего заказа: сдельщина подтверждается в момент закрытия коробки.',
  WORK_DATE:
    'Входит всё начисленное до даты, независимо от упаковки и статуса заказа.',
};

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const DayOfMonth = z.coerce.number().int().min(1).max(31);

/** `HH:mm`, 24 часа. */
const LocalTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Время в формате ЧЧ:ММ');

/**
 * Тело `PUT /api/payroll/schedule`.
 *
 * `daysOfMonth` нормализуется: дубли убираются, порядок — по
 * возрастанию. Пустой массив разрешён и означает «расписание
 * выключено» — система ведёт себя ровно как до появления фичи.
 */
export const UpdatePayrollAccrualScheduleSchema = z.object({
  daysOfMonth: z
    .array(DayOfMonth)
    .max(31)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  cutoffBasis: PayrollCutoffBasisSchema,
  appliesToSewing: z.boolean(),
  appliesToCutting: z.boolean(),
  autoCreateDraft: z.boolean(),
  runAtLocalTime: LocalTime,
});
export type UpdatePayrollAccrualScheduleDto = z.infer<
  typeof UpdatePayrollAccrualScheduleSchema
>;

export interface PayrollAccrualScheduleDto {
  daysOfMonth: number[];
  cutoffBasis: PayrollCutoffBasis;
  appliesToSewing: boolean;
  appliesToCutting: boolean;
  autoCreateDraft: boolean;
  runAtLocalTime: string;
  /** `YYYY-MM-DD` или `null`, если автосоздание ещё не срабатывало. */
  lastRunOn: string | null;
  updatedAt: string;
  updatedByFullName: string | null;
  /**
   * Ближайшие даты начисления (включая сегодняшнюю, если она в
   * расписании) с периодами. Пусто, если расписание выключено.
   */
  upcoming: PayrollAccrualOccurrenceDto[];
}

export interface PayrollAccrualOccurrenceDto {
  /** Дата начисления, `YYYY-MM-DD`. */
  date: string;
  /** Начало периода документа, `YYYY-MM-DD`. */
  periodFrom: string;
  /** Сколько дней осталось до даты (0 — сегодня). */
  daysLeft: number;
}

// ---------------------------------------------------------------------------
// Предпросмотр «что войдёт / что отложено»
// ---------------------------------------------------------------------------

export const PayrollAccrualPreviewQuerySchema = z.object({
  accrualDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD')
    .optional(),
});
export type PayrollAccrualPreviewQuery = z.infer<
  typeof PayrollAccrualPreviewQuerySchema
>;

/** Отложенная сумма в разрезе заказа — «почему не платим». */
export interface PayrollDeferredOrderDto {
  orderId: string;
  orderNumber: string;
  orderStatusLabel: string;
  /** Упаковано / всего паспортов по заказу — для строки «380 из 500». */
  packedQty: number;
  totalQty: number;
  amount: number;
}

/**
 * Отложенное в разрезе СОТРУДНИКА — для колонки «Отложено» в черновике
 * документа: менеджер должен уметь объяснить человеку, почему сумма
 * меньше ожидаемой, не поднимая заказы вручную.
 */
export interface PayrollDeferredEmployeeDto {
  employeeId: string;
  amount: number;
  /** Заказы, из-за которых деньги придержаны, по убыванию суммы. */
  orders: PayrollDeferredOrderDto[];
}

export interface PayrollAccrualPreviewDto {
  accrualDate: string;
  periodFrom: string | null;
  cutoffBasis: PayrollCutoffBasis;
  /** Сдельщина, прошедшая отсечку (без раскроя). */
  pieceworkAmount: number;
  /** Раскрой (может быть выведен из-под правила). */
  cuttingAmount: number;
  /** Оклад: смены и месячный оклад. */
  salaryAmount: number;
  /** Подкрой — почасовая доплата. */
  recutAmount: number;
  totalAmount: number;
  employeeCount: number;
  /** Сумма, не прошедшая отсечку. */
  deferredAmount: number;
  deferredOrders: PayrollDeferredOrderDto[];
  deferredEmployees: PayrollDeferredEmployeeDto[];
}

// ---------------------------------------------------------------------------
// Календарь: чистые функции
// ---------------------------------------------------------------------------

/** Число дней в месяце (1-based month). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Фактическое число месяца для дня расписания: 31-е в феврале
 * превращается в 28/29-е. Иначе февраль просто пропускал бы начисление,
 * и зарплата уезжала бы на месяц.
 */
export function clampDayToMonth(
  year: number,
  month: number,
  day: number,
): number {
  return Math.min(day, daysInMonth(year, month));
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Все даты начисления месяца по расписанию — отсортированные,
 * без дублей (5 и 31 в феврале не схлопываются в одну дату дважды).
 */
export function accrualDatesInMonth(
  daysOfMonth: number[],
  year: number,
  month: number,
): string[] {
  const clamped = daysOfMonth.map((d) => clampDayToMonth(year, month, d));
  return [...new Set(clamped)].sort((a, b) => a - b).map((d) => iso(year, month, d));
}

/**
 * Ближайшие `count` дат начисления, начиная с `fromIso` включительно.
 * Пустое расписание → пустой список.
 */
export function upcomingAccrualDates(
  daysOfMonth: number[],
  fromIso: string,
  count = 3,
): string[] {
  if (daysOfMonth.length === 0) return [];
  const [y0, m0] = fromIso.split('-').map(Number);
  const out: string[] = [];
  let year = y0;
  let month = m0;
  // 14 месяцев с запасом: даже расписание из одного дня наберёт count.
  for (let i = 0; i < 14 && out.length < count; i += 1) {
    for (const d of accrualDatesInMonth(daysOfMonth, year, month)) {
      if (d >= fromIso && out.length < count) out.push(d);
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * Предыдущая дата начисления перед `dateIso` (не включая её). `null`,
 * если расписание пустое. Используется как начало периода документа.
 */
export function previousAccrualDate(
  daysOfMonth: number[],
  dateIso: string,
): string | null {
  if (daysOfMonth.length === 0) return null;
  const [y0, m0] = dateIso.split('-').map(Number);
  let year = y0;
  let month = m0;
  for (let i = 0; i < 14; i += 1) {
    const dates = accrualDatesInMonth(daysOfMonth, year, month).filter(
      (d) => d < dateIso,
    );
    if (dates.length > 0) return dates[dates.length - 1];
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return null;
}

/**
 * Период документа для даты начисления: со следующего дня после
 * предыдущего начисления по саму дату включительно. Если предыдущего
 * начисления нет (первый запуск) — `periodFrom = null`, документ
 * забирает всё накопленное.
 */
export function accrualPeriodFor(
  daysOfMonth: number[],
  dateIso: string,
): { periodFrom: string | null; periodTo: string } {
  const prev = previousAccrualDate(daysOfMonth, dateIso);
  if (!prev) return { periodFrom: null, periodTo: dateIso };
  const [y, m, d] = prev.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    periodFrom: iso(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
    ),
    periodTo: dateIso,
  };
}

/** Число целых суток между двумя `YYYY-MM-DD` (b − a). */
export function daysBetweenIso(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86_400_000);
}

/** Есть ли `dateIso` в расписании (с учётом схлопывания 31→конец месяца). */
export function isAccrualDate(daysOfMonth: number[], dateIso: string): boolean {
  const [y, m] = dateIso.split('-').map(Number);
  return accrualDatesInMonth(daysOfMonth, y, m).includes(dateIso);
}
