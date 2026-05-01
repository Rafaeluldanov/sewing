/**
 * Контракты модуля «Сотрудники» (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 * Управленческий справочник для начальника производства: один экран на
 * список и один — на карточку. Создание/удаление сотрудников out of
 * scope MVP (этим занимается seed/админ-пользователь напрямую).
 *
 * Источник истины — `docs/api.md §10b`, `docs/screens.md §11`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma)
// ---------------------------------------------------------------------------

export const COMPENSATION_TYPES = ['PIECEWORK', 'SALARY', 'MIXED'] as const;
export const CompensationTypeSchema = z.enum(COMPENSATION_TYPES);
export type CompensationType = z.infer<typeof CompensationTypeSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Денежная сумма `Decimal(12,2)`. На запросе принимаем `number | string`,
 * нормализуем до неотрицательного числа c двумя знаками после запятой.
 * `null` означает «убрать ставку» — допустимо только для `PIECEWORK`.
 */
const SalaryPerShiftField = z
  .union([z.number(), z.string(), z.null()])
  .transform((v, ctx) => {
    if (v === null || v === '' || v === undefined) {
      return null;
    }
    const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка должна быть числом',
      });
      return z.NEVER;
    }
    if (num < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка не может быть отрицательной',
      });
      return z.NEVER;
    }
    if (num >= 10_000_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка слишком большая',
      });
      return z.NEVER;
    }
    return Math.round(num * 100) / 100;
  });

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const ListEmployeesQuerySchema = z.object({
  /** `true` — только активные, `false` — только архивные, иначе все. */
  active: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .optional(),
  role: z.string().min(1).optional(),
  compensationType: CompensationTypeSchema.optional(),
  /** Поиск по `fullName` или `login`, нечувствителен к регистру. */
  search: z.string().trim().min(1).max(100).optional(),
});
export type ListEmployeesQuery = z.infer<typeof ListEmployeesQuerySchema>;

// ---------------------------------------------------------------------------
// Update DTO
// ---------------------------------------------------------------------------

/**
 * Тело `PATCH /api/employees/:id`.
 *
 * Скоуп MVP — только management-поля:
 *   - `compensationType` (PIECEWORK|SALARY|MIXED)
 *   - `salaryPerShift`   (ставка за смену; обязательна для SALARY/MIXED)
 *   - `active`           (мягкий «архив»)
 *
 * Логин/PIN/роль/ФИО админ меняет напрямую через Prisma seed/console:
 * правила безопасности тут отдельная история (rate limit, аудит, второй
 * фактор), и в MVP они отсутствуют.
 *
 * Серверная инвариант-проверка: для `compensationType in (SALARY, MIXED)`
 * после применения patch обязан быть положительный `salaryPerShift`.
 */
export const UpdateEmployeeSchema = z
  .object({
    compensationType: CompensationTypeSchema.optional(),
    salaryPerShift: SalaryPerShiftField.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (obj) =>
      obj.compensationType !== undefined ||
      obj.salaryPerShift !== undefined ||
      obj.active !== undefined,
    'Нечего обновлять: укажите compensationType, salaryPerShift или active',
  );
export type UpdateEmployeeDto = z.infer<typeof UpdateEmployeeSchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface EmployeeListItemDto {
  id: string;
  fullName: string;
  login: string;
  role: string;
  paymentType: 'SALARY' | 'PIECEWORK';
  compensationType: CompensationType;
  salaryPerShift: number | null;
  active: boolean;
  createdAt: string;
}

export interface EmployeeDetailDto extends EmployeeListItemDto {
  /**
   * Историческое поле «месячный оклад». На MVP не используется
   * payroll-движком; оставлено для информации (см. ADR-0021).
   */
  salaryBase: number | null;
}
