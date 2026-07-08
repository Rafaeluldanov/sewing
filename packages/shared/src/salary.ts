/**
 * Контракты модуля «Окладные начисления» (post-Шаг 18 / Шаг 19).
 *
 * Источник истины — backend (`/api/salary/*`). Источник правил —
 * `docs/domain.md §9a`, `docs/api.md §10a`, ADR-0021.
 *
 * Скоуп:
 *   - один источник `SHIFT_DAY` — закрытые `ShiftSession` за день;
 *   - повременная оплата: `amount = workedSeconds / 3600 ×
 *     Employee.salaryPerHour` (см. `SalaryService.syncDailySalary`);
 *   - ручная правка делает только две вещи: сумма + комментарий.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma)
// ---------------------------------------------------------------------------

export const SALARY_ENTRY_SOURCES = ['SHIFT_DAY', 'MANUAL', 'RECUT'] as const;
export const SalaryEntrySourceSchema = z.enum(SALARY_ENTRY_SOURCES);
export type SalaryEntrySource = z.infer<typeof SalaryEntrySourceSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DateOnlySchema = z
  .string()
  .min(1)
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
    {
      message: 'Дата в формате YYYY-MM-DD',
    },
  );

/**
 * Денежная сумма `Decimal(12,2)` в виде числа. Принимаем `number` или
 * строку (формы шлют строки), нормализуем до неотрицательного с двумя
 * знаками. Защита от NaN/Infinity и слишком больших значений (укладываемся
 * в `Decimal(12,2)`).
 */
const AmountField = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
  if (!Number.isFinite(num)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Сумма должна быть числом',
    });
    return z.NEVER;
  }
  if (num < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Сумма не может быть отрицательной',
    });
    return z.NEVER;
  }
  if (num >= 10_000_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Сумма слишком большая',
    });
    return z.NEVER;
  }
  return Math.round(num * 100) / 100;
});

// ---------------------------------------------------------------------------
// Query DTO
// ---------------------------------------------------------------------------

/**
 * Query `GET /api/salary`.
 *
 * Все фильтры опциональны. Период проверяется по `SalaryEntry.date`.
 * Не-менеджер на сервере получает принудительный скоуп
 * `employeeId = viewer.employeeId` (см. `apps/api/src/modules/salary`).
 */
export const ListSalaryQuerySchema = z.object({
  employeeId: z.string().min(1).optional(),
  dateFrom: DateOnlySchema.optional(),
  dateTo: DateOnlySchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListSalaryQuery = z.infer<typeof ListSalaryQuerySchema>;

export const SalarySummaryQuerySchema = z.object({
  employeeId: z.string().min(1).optional(),
  dateFrom: DateOnlySchema.optional(),
  dateTo: DateOnlySchema.optional(),
});
export type SalarySummaryQuery = z.infer<typeof SalarySummaryQuerySchema>;

// ---------------------------------------------------------------------------
// Update DTO (manual adjustment)
// ---------------------------------------------------------------------------

/**
 * Тело `PATCH /api/salary/:id`.
 *
 * Менять можно только сумму и комментарий. Любое другое поле
 * (`employeeId`, `date`, `source`) — иммутабельно: иначе ручная правка
 * могла бы перенести оплату на чужой день/чужого человека и сломать
 * инвариант «один день — одна окладная запись».
 *
 * `reset = true` — снять флаг «исправлено вручную» и вернуть запись
 * под автоматическую sync-логику. Полезно, если менеджер передумал:
 * amount пересчитывается по почасовой ставке за тот же день
 * (закрытые смены × `salaryPerHour`). Если `reset = true`, остальные
 * поля игнорируются.
 */
export const UpdateSalaryEntrySchema = z
  .object({
    amount: AmountField.optional(),
    /** `null` — очистить комментарий. */
    managerComment: z
      .union([z.string().trim().max(500, 'Комментарий слишком длинный'), z.null()])
      .optional(),
    reset: z.boolean().optional(),
  })
  .refine(
    (obj) =>
      obj.amount !== undefined ||
      obj.managerComment !== undefined ||
      obj.reset === true,
    'Нечего обновлять: укажите amount, managerComment или reset',
  );
export type UpdateSalaryEntryDto = z.infer<typeof UpdateSalaryEntrySchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

/**
 * Одна окладная запись. Денежные значения как `number` (Decimal
 * приводится через `Number(...)`) — на MVP суммы небольшие, в
 * безопасный диапазон укладываются.
 */
export interface SalaryEntryDto {
  id: string;
  employeeId: string;
  employeeFullName: string;
  /** ISO-дата без времени, `YYYY-MM-DD`. */
  date: string;
  amount: number;
  /**
   * Отработанные секунды за день по закрытым сменам, на основе которых
   * посчитан `amount` (повременная оплата). `null` для исторических
   * записей до перехода на почасовую оплату и для `source = MANUAL`.
   * UI делит на 3600 для показа часов.
   */
  workedSeconds: number | null;
  source: SalaryEntrySource;
  editedManually: boolean;
  managerComment: string | null;
  editedByEmployeeId: string | null;
  editedByFullName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalaryPage {
  items: SalaryEntryDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SalarySummaryDto {
  /** Σ amount по всем записям, попавшим в фильтр. */
  total: number;
  /** Σ amount по записям с `editedManually = true`. */
  totalEditedManually: number;
  count: number;
  countEditedManually: number;
}
