/**
 * Контракты модуля «PayrollPayout» — выплата зарплаты сотруднику
 * за период (PHASE 3 STEP 1).
 *
 * Источник истины — Prisma-модели `PayrollPayout` /
 * `PayrollPayoutLine` (`prisma/schema.prisma`,
 * [`docs/erd.md §2.9`](../../../docs/erd.md#29-salary--earnings)).
 * Контроллер/сервис добавляются на следующих шагах PHASE 3:
 * сейчас фиксируем только Zod-схемы и DTO, чтобы web и api жили
 * на одних и тех же типах.
 *
 * Бизнес-инвариант:
 *   - менеджер формирует выплату сотруднику (`DRAFT`) поверх
 *     уже созданных `OperationEntry` / `SalaryEntry`;
 *   - суммы и перечень строк фиксируются snapshot-ом на момент
 *     `recompute`/`issue`;
 *   - сотрудник позже подтверждает получение (`ACKNOWLEDGED`);
 *   - одна строка начисления не может попасть в две **активные**
 *     (не `CANCELLED`) выплаты. Эта уникальность проверяется в
 *     сервисе, на уровне БД `@@unique` на `operationEntryId` /
 *     `salaryEntryId` НЕ ставится.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma)
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл выплаты `PayrollPayout`. Валидные переходы:
 *
 *   - `DRAFT → ISSUED`        — менеджер «выдал» выплату;
 *   - `DRAFT → CANCELLED`     — отменил черновик;
 *   - `ISSUED → ACKNOWLEDGED` — сотрудник подтвердил получение;
 *   - `ISSUED → CANCELLED`    — менеджер отозвал уже выданную выплату.
 *
 * `ACKNOWLEDGED` и `CANCELLED` — терминальные.
 */
export const PAYROLL_PAYOUT_STATUSES = [
  'DRAFT',
  'ISSUED',
  'ACKNOWLEDGED',
  'CANCELLED',
] as const;
export const PayrollPayoutStatusSchema = z.enum(PAYROLL_PAYOUT_STATUSES);
export type PayrollPayoutStatus = z.infer<typeof PayrollPayoutStatusSchema>;

/**
 * Тип строки выплаты — из какой подсистемы начислений она пришла.
 *
 * - `PIECEWORK`  — `OperationEntry` (сдельщина);
 * - `SALARY`     — `SalaryEntry` (оклад);
 * - `BONUS`      — бонус (резерв для будущих ручных строк);
 * - `DEDUCTION`  — удержание (резерв для будущих ручных строк);
 * - `ADVANCE`    — аванс (резерв для будущих ручных строк);
 * - `ADJUSTMENT` — ручная корректировка из `PayrollAccrualDocumentLine.manualAdjustRub`
 *                  (PHASE 3 STEP 6.4). `operationEntryId` и `salaryEntryId` = null.
 */
export const PAYROLL_PAYOUT_LINE_KINDS = [
  'PIECEWORK',
  'SALARY',
  'BONUS',
  'DEDUCTION',
  'ADVANCE',
  'ADJUSTMENT',
] as const;
export const PayrollPayoutLineKindSchema = z.enum(PAYROLL_PAYOUT_LINE_KINDS);
export type PayrollPayoutLineKind = z.infer<typeof PayrollPayoutLineKindSchema>;

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
 * Опциональный комментарий менеджера / причина отмены. `null` —
 * «убрать комментарий», пустая строка после `trim` тоже трактуется
 * как отсутствие комментария.
 */
const OptionalCommentField = z
  .union([
    z
      .string()
      .trim()
      .max(2000, 'Комментарий слишком длинный')
      .transform((v) => (v.length === 0 ? null : v)),
    z.null(),
  ])
  .optional();

// ---------------------------------------------------------------------------
// Query DTO
// ---------------------------------------------------------------------------

/**
 * Query `GET /api/payroll-payouts`.
 *
 * Все фильтры опциональны. Период (`periodFrom` / `periodTo`)
 * сравнивается с `PayrollPayout.periodFrom` / `.periodTo` на сервере
 * — диапазон «выплат, период которых пересекается с заданным».
 */
export const PayrollPayoutListQuerySchema = z.object({
  employeeId: z.string().min(1).optional(),
  status: PayrollPayoutStatusSchema.optional(),
  periodFrom: DateOnlySchema.optional(),
  periodTo: DateOnlySchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type PayrollPayoutListQuery = z.infer<typeof PayrollPayoutListQuerySchema>;

// ---------------------------------------------------------------------------
// Mutation DTO
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/payroll-payouts`. Создаёт `DRAFT`-выплату и
 * (на следующем шаге сервис вызывает recompute) автоматически
 * собирает строки начислений за период. Период включает обе даты.
 */
export const CreatePayrollPayoutSchema = z
  .object({
    employeeId: z.string().min(1, 'Сотрудник обязателен'),
    periodFrom: DateOnlySchema,
    periodTo: DateOnlySchema,
    managerComment: OptionalCommentField,
  })
  .refine((obj) => obj.periodFrom <= obj.periodTo, {
    message: '`periodFrom` не может быть позже `periodTo`',
    path: ['periodTo'],
  });
export type CreatePayrollPayoutDto = z.infer<typeof CreatePayrollPayoutSchema>;

/**
 * Тело `POST /api/payroll-payouts/:id/recompute`. На MVP позволяет
 * скорректировать комментарий и/или период черновика и пересобрать
 * строки. Доступно только в статусе `DRAFT`.
 */
export const RecomputePayrollPayoutSchema = z
  .object({
    periodFrom: DateOnlySchema.optional(),
    periodTo: DateOnlySchema.optional(),
    managerComment: OptionalCommentField,
  })
  .refine(
    (obj) => {
      if (obj.periodFrom && obj.periodTo) {
        return obj.periodFrom <= obj.periodTo;
      }
      return true;
    },
    {
      message: '`periodFrom` не может быть позже `periodTo`',
      path: ['periodTo'],
    },
  );
export type RecomputePayrollPayoutDto = z.infer<
  typeof RecomputePayrollPayoutSchema
>;

/**
 * Тело `POST /api/payroll-payouts/:id/issue` — менеджер «выдаёт»
 * выплату. Меняет статус `DRAFT → ISSUED`, `issuedAt` /
 * `issuedById` фиксируются сервисом.
 *
 * На MVP отдельных полей не требуется; схема оставлена пустой
 * объектом-расширяемой капсулой, чтобы UI слал `{}` без
 * `Content-Type` сюрпризов.
 */
export const IssuePayrollPayoutSchema = z.object({}).strict();
export type IssuePayrollPayoutDto = z.infer<typeof IssuePayrollPayoutSchema>;

/**
 * Тело `POST /api/payroll-payouts/:id/ack` — сотрудник подтверждает
 * получение. Меняет статус `ISSUED → ACKNOWLEDGED`,
 * `acknowledgedAt` / `acknowledgedByEmployeeId` фиксируются
 * сервисом.
 */
export const AckPayrollPayoutSchema = z.object({}).strict();
export type AckPayrollPayoutDto = z.infer<typeof AckPayrollPayoutSchema>;

/**
 * Тело `POST /api/payroll-payouts/:id/cancel` — менеджер отменяет
 * выплату (`DRAFT → CANCELLED` или `ISSUED → CANCELLED`).
 * Опциональная причина пишется в `cancelReason`.
 */
export const CancelPayrollPayoutSchema = z.object({
  reason: OptionalCommentField,
});
export type CancelPayrollPayoutDto = z.infer<typeof CancelPayrollPayoutSchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

/**
 * Минимальная информация о сотруднике-получателе, которую UI
 * показывает в списке/карточке выплаты. Опционально (`?`) —
 * сервис на MVP может пропускать join при листинге.
 */
export interface PayrollPayoutEmployeeDto {
  id: string;
  fullName: string;
  role: string;
}

/**
 * Одна строка выплаты. Ровно одна из `operationEntryId` /
 * `salaryEntryId` будет заполнена; `kind` дублирует выбор для
 * фильтров. `snapshot` — свёрнутый JSON-вид начисления на момент
 * включения в выплату; форма произвольная, поэтому здесь —
 * `Record<string, unknown>`.
 */
export interface PayrollPayoutLineDto {
  id: string;
  kind: PayrollPayoutLineKind;
  operationEntryId?: string | null;
  salaryEntryId?: string | null;
  amountRub: number;
  /** Календарная дата события `YYYY-MM-DD`. */
  occurredOn: string;
  snapshot: Record<string, unknown>;
}

/**
 * Карточка выплаты `PayrollPayout`. Денежные значения — `number`
 * (`Decimal(12,2)` приводится через `Number(...)` на сервере,
 * MVP-суммы укладываются в безопасный диапазон).
 *
 * `lines` опционально: список выплат (`GET /api/payroll-payouts`)
 * не обязан тащить с собой строки, карточка
 * (`GET /api/payroll-payouts/:id`) — обязана.
 */
export interface PayrollPayoutDto {
  id: string;
  employeeId: string;
  employee?: PayrollPayoutEmployeeDto;
  /** ISO-даты без времени, `YYYY-MM-DD`. */
  periodFrom: string;
  periodTo: string;
  status: PayrollPayoutStatus;
  amountPieceworkRub: number;
  amountSalaryRub: number;
  amountTotalRub: number;
  managerComment: string | null;
  createdAt: string;
  issuedAt: string | null;
  acknowledgedAt: string | null;
  cancelledAt: string | null;
  lines?: PayrollPayoutLineDto[];
}

export interface PayrollPayoutPageDto {
  items: PayrollPayoutDto[];
  total: number;
  page: number;
  pageSize: number;
}
