/**
 * Контракты модуля «Сотрудники» (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 * Управленческий справочник для начальника производства: список,
 * карточка и (с этой задачи) минимальная страница создания нового
 * сотрудника `/admin/employees/new` (см. `docs/screens.md §10d`,
 * `docs/api.md §3b`). Удаление сотрудников out of scope MVP — менеджер
 * мягко гасит карточку через `active = false`.
 *
 * Источник истины — `docs/api.md §3b`, `docs/screens.md §10d`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma)
// ---------------------------------------------------------------------------

export const COMPENSATION_TYPES = ['PIECEWORK', 'SALARY', 'MIXED'] as const;
export const CompensationTypeSchema = z.enum(COMPENSATION_TYPES);
export type CompensationType = z.infer<typeof CompensationTypeSchema>;

/**
 * Роли, которые менеджер может выбрать при создании сотрудника через
 * `/admin/employees/new`. Подмножество `enum Role` из Prisma-схемы:
 * сюда сознательно НЕ входит `DISPLAY` — это служебная учётка под
 * большой монитор цеха (см. ADR-0014, `apps/web/lib/rbac.ts`), её
 * заводит админ напрямую через seed/Prisma. Остальные «настоящие»
 * сотрудники полностью покрываются этим списком — он же используется
 * как ROLE_LABELS на фронте (см. `app/admin/employees/page.tsx`).
 */
export const EMPLOYEE_ROLES = [
  'ADMIN',
  'SHOP_MANAGER',
  'CUTTER',
  'CUTTER_ASSISTANT',
  'SEAMSTRESS',
  'QC',
  'IRONING',
  'PACKING',
  // MVP «Мастер цеха» (см. `Role.SHOPFLOOR_MASTER`,
  // `docs/domain.md §«Мастер цеха»`). Учётка заводится менеджером
  // через тот же `/admin/employees/new`, как и остальные сотрудники.
  'SHOPFLOOR_MASTER',
] as const;
export const EmployeeRoleSchema = z.enum(EMPLOYEE_ROLES);
export type EmployeeRole = z.infer<typeof EmployeeRoleSchema>;

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

/**
 * Процент B2B-начисления закройщика (`Employee.cutterB2bSewingPercent`,
 * Decimal(5, 2)). См. `docs/payroll-cutter-compensation-recon.md`.
 *
 * Принимаем `number | string | null`, нормализуем к неотрицательному
 * числу c <= 2 знаками после запятой и валидируем диапазон `[0; 100]`.
 * `null` / пустая строка / `undefined` → `null` (поле не задано —
 * backend возьмёт fallback из ENV `CUTTER_B2B_SEWING_PERCENT`).
 *
 * Поле имеет смысл только для роли `CUTTER`. UI скрывает/выключает
 * его для других ролей; сервер сохраняет всё, что пришло — это
 * безопасно (поле читается только B2B-веткой
 * `EarningsService.createImmediateForCutter` для `Employee.role =
 * CUTTER`, см. ADR `cutter-compensation`).
 */
const CutterB2bSewingPercentField = z
  .union([z.number(), z.string(), z.null()])
  .transform((v, ctx) => {
    if (v === null || v === '' || v === undefined) {
      return null;
    }
    const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Процент должен быть числом',
      });
      return z.NEVER;
    }
    if (num < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Процент не может быть отрицательным',
      });
      return z.NEVER;
    }
    if (num > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Процент не может быть больше 100',
      });
      return z.NEVER;
    }
    // Округляем до 2 знаков, как в БД (DECIMAL(5, 2)). Также
    // защищаемся от .toFixed-проблем у JS-чисел: операция через
    // Math.round + 100 даёт ровно две цифры после точки.
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
    /**
     * Процент B2B-начисления закройщика. Опционально на уровне DTO:
     * `undefined` — backend не трогает колонку; `null` или пустая
     * строка — стирает значение (backend возьмёт fallback из ENV).
     * Поле имеет смысл только для роли `CUTTER`; для остальных ролей
     * UI его прячет/выключает, но сервер не падает, если значение
     * пришло (см. `EmployeesService.update`).
     */
    cutterB2bSewingPercent: CutterB2bSewingPercentField.optional(),
  })
  .refine(
    (obj) =>
      obj.compensationType !== undefined ||
      obj.salaryPerShift !== undefined ||
      obj.active !== undefined ||
      obj.cutterB2bSewingPercent !== undefined,
    'Нечего обновлять: укажите compensationType, salaryPerShift, active или cutterB2bSewingPercent',
  );
export type UpdateEmployeeDto = z.infer<typeof UpdateEmployeeSchema>;

// ---------------------------------------------------------------------------
// Create DTO (POST /api/employees, see `docs/api.md §3b`)
// ---------------------------------------------------------------------------

/**
 * Поле «логин». Уникально в пределах `Employee.login` (Prisma `@unique`),
 * используется в форме входа (`AuthService.login`). Нормализуем —
 * trim + lower-case, чтобы не плодить «Vasya» / «vasya» дубли по
 * ошибке оператора. Длина — щадящий диапазон под человеческие
 * логины и служебные коды.
 */
const LoginField = z
  .string()
  .trim()
  .min(2, 'Логин должен быть не короче 2 символов')
  .max(64, 'Логин слишком длинный (макс. 64 символа)')
  .transform((v) => v.toLowerCase());

const FullNameField = z
  .string()
  .trim()
  .min(1, 'ФИО обязательно')
  .max(200, 'ФИО слишком длинное (макс. 200 символов)');

/**
 * PIN/пароль на вход. Хранится в БД как bcrypt-hash (`pinHash`),
 * наружу не отдаётся ни в одном DTO. Минимум 4 символа — это и
 * привычный 4-значный PIN, и короткий пароль для дев-аккаунтов.
 * Верхняя граница (100) — чисто защитная: bcrypt всё равно режет
 * до 72 байт, но не позволим прислать «миллион байт» в ручку.
 */
const PinField = z
  .string()
  .min(4, 'PIN должен быть не короче 4 символов')
  .max(100, 'PIN слишком длинный (макс. 100 символов)');

/**
 * Тело `POST /api/employees` (см. `docs/api.md §3b`, ADR-0021).
 *
 * Минимальный набор полей, необходимый для появления нового сотрудника
 * в системе:
 *   - `fullName`, `login`, `pin` — паспортная часть и креденшелы;
 *   - `role` — определяет доступные экраны;
 *   - `compensationType` (default `PIECEWORK`), `salaryPerShift?` —
 *     единая управленческая ось «как платим»: `PIECEWORK`/`MIXED`
 *     участвуют в сдельном `EarningsService`, `SALARY`/`MIXED`
 *     получают дневной оклад через `SalaryService`. Инвариант
 *     `UpdateEmployeeSchema`: для `SALARY`/`MIXED` обязательна
 *     положительная ставка за смену.
 *
 * Историческое поле `Employee.salaryBase` («месячный оклад») удалено
 * в PHASE 2 STEP 1 — payroll-движок его никогда не использовал.
 */
export const CreateEmployeeSchema = z
  .object({
    fullName: FullNameField,
    login: LoginField,
    pin: PinField,
    role: EmployeeRoleSchema,
    compensationType: CompensationTypeSchema.default('PIECEWORK'),
    salaryPerShift: SalaryPerShiftField.optional(),
    active: z.boolean().optional(),
    /**
     * Процент B2B-начисления закройщика (см.
     * `Employee.cutterB2bSewingPercent`). На уровне DTO — опционально
     * и nullable: для не-`CUTTER`-ролей UI поле скрывает, а если
     * значение всё-таки придёт, backend сохранит, не падая. Значение
     * имеет смысл только в B2B-flow (`getCutterCompensationSchemeForDivision
     * → B2B_SEWING_PERCENT`).
     */
    cutterB2bSewingPercent: CutterB2bSewingPercentField.optional(),
  })
  .superRefine((obj, ctx) => {
    if (
      (obj.compensationType === 'SALARY' || obj.compensationType === 'MIXED') &&
      (obj.salaryPerShift === null ||
        obj.salaryPerShift === undefined ||
        obj.salaryPerShift <= 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salaryPerShift'],
        message:
          'Для SALARY/MIXED обязательно укажите положительную ставку за смену',
      });
    }
  });
export type CreateEmployeeDto = z.infer<typeof CreateEmployeeSchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface EmployeeListItemDto {
  id: string;
  fullName: string;
  login: string;
  role: string;
  compensationType: CompensationType;
  salaryPerShift: number | null;
  active: boolean;
  createdAt: string;
}

export interface EmployeeDetailDto extends EmployeeListItemDto {
  /**
   * Процент B2B-начисления закройщика (`Employee.cutterB2bSewingPercent`,
   * Decimal(5, 2)). См. `docs/payroll-cutter-compensation-recon.md`.
   *
   * `null` — у этого сотрудника процент не задан; backend в B2B-flow
   * возьмёт fallback из ENV `CUTTER_B2B_SEWING_PERCENT`. Если и его
   * нет — сдельное B2B-начисление закройщика не создаётся.
   *
   * Поле опционально (`?`) для backward-compat — старые потребители
   * без пересборки shared-пакета продолжают компилироваться. Backend
   * всегда отдаёт ключ, даже для не-`CUTTER` ролей (там ожидаем
   * `null`).
   */
  cutterB2bSewingPercent?: number | null;
}
