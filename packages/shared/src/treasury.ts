/**
 * Контракты модуля «Казначейство» (Фаза 0 — журнал движения ДС).
 *
 * Источник идей — дизайн-контракт модуля «Казначейство» (fin.cash_flow_entry,
 * инварианты INV-4/INV-7), урезанный под один цех: RUB-only, без
 * мультивалюты/эквайринга/выписок/outbox. Модели БД —
 * `prisma/schema.prisma::CashAccount|CashFlowItem|CashFlowEntry`; рантайм —
 * `apps/api/src/modules/treasury/*`.
 *
 * Дизайн MVP:
 *   - своей роли у казначея нет: используем `ADMIN`/`SHOP_MANAGER`;
 *   - счёт ДС — единая таблица `CashAccount` с дискриминатором `kind`
 *     (касса/расчётный счёт), остаток не хранится — считается по журналу;
 *   - журнал append-only: правка = сторно-проводка (`POST /:id/storno`);
 *   - деньги в DTO — строка (`Prisma.Decimal.toString()`), на ввод —
 *     строка/число с ≤2 знаками после точки.
 *
 * Контракт — источник истины и для backend (ZodValidationPipe), и для
 * frontend (server actions).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma-enum, лейблы для UI)
// ---------------------------------------------------------------------------

/** Тип счёта ДС. */
export const CASH_ACCOUNT_KINDS = ['BANK', 'CASH'] as const;
export type CashAccountKind = (typeof CASH_ACCOUNT_KINDS)[number];
export const CashAccountKindSchema = z.enum(CASH_ACCOUNT_KINDS);
export const CASH_ACCOUNT_KIND_LABELS: Record<CashAccountKind, string> = {
  BANK: 'Расчётный счёт',
  CASH: 'Касса',
};

/** Направление проводки. Знак суммы несёт направление; сумма всегда > 0. */
export const CASH_FLOW_DIRECTIONS = ['IN', 'OUT'] as const;
export type CashFlowDirection = (typeof CASH_FLOW_DIRECTIONS)[number];
export const CashFlowDirectionSchema = z.enum(CASH_FLOW_DIRECTIONS);
export const CASH_FLOW_DIRECTION_LABELS: Record<CashFlowDirection, string> = {
  IN: 'Поступление',
  OUT: 'Расход',
};

/** Источник (основание) проводки — soft-ссылка на долг/документ. */
export const CASH_FLOW_SOURCES = [
  'SUPPLIER_PAYMENT',
  'PAYROLL_PAYOUT',
  'CUSTOMER_INCOME',
  'TRANSFER',
  'ADJUSTMENT',
  'OTHER',
] as const;
export type CashFlowSource = (typeof CASH_FLOW_SOURCES)[number];
export const CashFlowSourceSchema = z.enum(CASH_FLOW_SOURCES);
export const CASH_FLOW_SOURCE_LABELS: Record<CashFlowSource, string> = {
  SUPPLIER_PAYMENT: 'Оплата поставщику',
  PAYROLL_PAYOUT: 'Выплата зарплаты',
  CUSTOMER_INCOME: 'Поступление от клиента',
  TRANSFER: 'Перемещение между счетами',
  ADJUSTMENT: 'Корректировка / ввод остатков',
  OTHER: 'Прочее',
};

/**
 * На Фазе 0 ручную проводку можно отнести только к «безобъектным»
 * статьям: ввод остатков/корректировка, поступление от клиента, прочее.
 * `SUPPLIER_PAYMENT`/`PAYROLL_PAYOUT`/`TRANSFER` создаются документами
 * соответствующих контуров (Фаза 1), руками их выбирать нельзя.
 */
export const MANUAL_CASH_FLOW_SOURCES = [
  'CUSTOMER_INCOME',
  'ADJUSTMENT',
  'OTHER',
] as const satisfies readonly CashFlowSource[];
export const ManualCashFlowSourceSchema = z.enum(MANUAL_CASH_FLOW_SOURCES);

// ---------------------------------------------------------------------------
// Деньги — поле суммы (вход)
// ---------------------------------------------------------------------------

/**
 * Сумма проводки на ввод: строка или число, нормализуется в строку вида
 * `^\d{1,12}(\.\d{1,2})?$` (вписывается в `Decimal(14,2)`), строго > 0.
 * Запятая принимается как десятичный разделитель. Округление до 2 знаков
 * (ROUND_HALF_UP) делает backend на границе записи.
 */
export const MoneyAmountSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v.replace(',', '.').trim()))
  .pipe(
    z
      .string()
      .regex(
        /^\d{1,12}(\.\d{1,2})?$/,
        'Сумма: до 12 цифр и не более 2 знаков после точки.',
      ),
  )
  .refine((s) => Number(s) > 0, 'Сумма должна быть больше нуля.');

// ---------------------------------------------------------------------------
// CashAccount — счета ДС
// ---------------------------------------------------------------------------

export const CreateCashAccountSchema = z.object({
  kind: CashAccountKindSchema,
  name: z.string().trim().min(1, 'Укажите название счёта.').max(120),
  /** На MVP всегда RUB; поле оставлено для совместимости. */
  currency: z.string().trim().length(3).default('RUB'),
  comment: z.string().trim().max(500).optional().nullable(),
});
export type CreateCashAccountDto = z.infer<typeof CreateCashAccountSchema>;

export const UpdateCashAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
    comment: z.string().trim().max(500).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'Нет полей для обновления.');
export type UpdateCashAccountDto = z.infer<typeof UpdateCashAccountSchema>;

export const ListCashAccountsQuerySchema = z.object({
  kind: CashAccountKindSchema.optional(),
  activeOnly: z.coerce.boolean().optional(),
});
export type ListCashAccountsQuery = z.infer<typeof ListCashAccountsQuerySchema>;

export interface CashAccountDto {
  id: string;
  kind: CashAccountKind;
  name: string;
  currency: string;
  isActive: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// CashFlowItem — статьи ДДС
// ---------------------------------------------------------------------------

export const CreateCashFlowItemSchema = z.object({
  name: z.string().trim().min(1, 'Укажите название статьи.').max(160),
  code: z.string().trim().max(40).optional().nullable(),
  /** Намёк направления (для группировки в UI), необязателен. */
  direction: CashFlowDirectionSchema.nullable().optional(),
  /** «Накладные расходы» — OUT по таким статьям распределяются на заказы. */
  isOverhead: z.coerce.boolean().optional(),
  comment: z.string().trim().max(500).optional().nullable(),
});
export type CreateCashFlowItemDto = z.infer<typeof CreateCashFlowItemSchema>;

export const UpdateCashFlowItemSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    code: z.string().trim().max(40).nullable().optional(),
    direction: CashFlowDirectionSchema.nullable().optional(),
    isActive: z.boolean().optional(),
    isOverhead: z.coerce.boolean().optional(),
    comment: z.string().trim().max(500).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'Нет полей для обновления.');
export type UpdateCashFlowItemDto = z.infer<typeof UpdateCashFlowItemSchema>;

export const ListCashFlowItemsQuerySchema = z.object({
  activeOnly: z.coerce.boolean().optional(),
  direction: CashFlowDirectionSchema.optional(),
});
export type ListCashFlowItemsQuery = z.infer<
  typeof ListCashFlowItemsQuerySchema
>;

export interface CashFlowItemDto {
  id: string;
  name: string;
  code: string | null;
  direction: CashFlowDirection | null;
  isActive: boolean;
  isOverhead: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// CashFlowEntry — проводки журнала
// ---------------------------------------------------------------------------

/** Ручная проводка (`registrarType = 'MANUAL'`). */
export const CreateCashFlowEntrySchema = z.object({
  accountId: z.string().min(1, 'Выберите счёт.'),
  itemId: z.string().min(1, 'Выберите статью ДДС.'),
  direction: CashFlowDirectionSchema,
  amount: MoneyAmountSchema,
  source: ManualCashFlowSourceSchema.default('OTHER'),
  /** Свободная soft-ссылка на основание (например, id заказа). */
  sourceId: z.string().trim().min(1).max(60).nullable().optional(),
  /** Момент проводки (ISO). Если не задан — backend ставит `now()`. */
  postedAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CreateCashFlowEntryDto = z.infer<typeof CreateCashFlowEntrySchema>;

/** Сторно проводки. `note` — причина. */
export const StornoCashFlowEntrySchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type StornoCashFlowEntryDto = z.infer<typeof StornoCashFlowEntrySchema>;

export const ListCashFlowEntriesQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  direction: CashFlowDirectionSchema.optional(),
  source: CashFlowSourceSchema.optional(),
  /** Фильтр по `postedAt` (ISO date, включительно). */
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  /** Включать ли сторно-строки (по умолчанию да). */
  includeStorno: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type ListCashFlowEntriesQuery = z.infer<
  typeof ListCashFlowEntriesQuerySchema
>;

export interface CashFlowEntryDto {
  id: string;
  accountId: string;
  accountName: string;
  itemId: string;
  itemName: string;
  direction: CashFlowDirection;
  /** Decimal как строка. */
  amount: string;
  source: CashFlowSource;
  sourceId: string | null;
  isStorno: boolean;
  reversalOfId: string | null;
  registrarType: string;
  registrarId: string;
  note: string | null;
  postedAt: string;
  postedById: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Остатки по счетам (отчёт)
// ---------------------------------------------------------------------------

export interface CashAccountBalanceDto {
  accountId: string;
  accountName: string;
  kind: CashAccountKind;
  currency: string;
  /** Σ поступлений (Decimal как строка). */
  inflow: string;
  /** Σ расходов (Decimal как строка). */
  outflow: string;
  /** Остаток = inflow − outflow (Decimal как строка). */
  balance: string;
}

export interface TreasuryBalancesDto {
  accounts: CashAccountBalanceDto[];
  /** Итоговый остаток по всем счетам валюты RUB. */
  totalBalanceRub: string;
}

// ---------------------------------------------------------------------------
// SupplierPayment — заявка на расход (Фаза 1): оплата поставщику ИЛИ зарплата
// ---------------------------------------------------------------------------

/**
 * Вид заявки на расход (зеркало Prisma `ExpensePaymentKind`).
 * `SUPPLIER` — оплата поставщику (ручная из казначейства).
 * `SALARY` — выплата зарплаты сотруднику (создаётся автоматически при
 * «Выплатить» в зарплатах; проводка — на шаге «Оплатить» заявку).
 */
export const EXPENSE_PAYMENT_KINDS = ['SUPPLIER', 'SALARY'] as const;
export type ExpensePaymentKind = (typeof EXPENSE_PAYMENT_KINDS)[number];
export const ExpensePaymentKindSchema = z.enum(EXPENSE_PAYMENT_KINDS);
export const EXPENSE_PAYMENT_KIND_LABELS: Record<ExpensePaymentKind, string> = {
  SUPPLIER: 'Поставщику',
  SALARY: 'Зарплата',
};

export const SUPPLIER_PAYMENT_STATUSES = [
  'DRAFT',
  'APPROVED',
  'PAID',
  'CANCELLED',
] as const;
export type SupplierPaymentStatus = (typeof SUPPLIER_PAYMENT_STATUSES)[number];
export const SupplierPaymentStatusSchema = z.enum(SUPPLIER_PAYMENT_STATUSES);
export const SUPPLIER_PAYMENT_STATUS_LABELS: Record<
  SupplierPaymentStatus,
  string
> = {
  DRAFT: 'Черновик',
  APPROVED: 'Согласована',
  PAID: 'Оплачена',
  CANCELLED: 'Отменена',
};

export const CreateSupplierPaymentSchema = z.object({
  supplierId: z.string().min(1, 'Выберите поставщика.'),
  /** Заказ поставщику (опц.). */
  purchaseOrderId: z.string().min(1).nullable().optional(),
  accountId: z.string().min(1, 'Выберите счёт.'),
  itemId: z.string().min(1, 'Выберите статью ДДС.'),
  amount: MoneyAmountSchema,
  comment: z.string().trim().max(500).nullable().optional(),
});
export type CreateSupplierPaymentDto = z.infer<
  typeof CreateSupplierPaymentSchema
>;

export const CancelSupplierPaymentSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelSupplierPaymentDto = z.infer<
  typeof CancelSupplierPaymentSchema
>;

export const ListSupplierPaymentsQuerySchema = z.object({
  status: SupplierPaymentStatusSchema.optional(),
  supplierId: z.string().min(1).optional(),
  /** Фильтр по виду заявки (поставщик/зарплата). */
  kind: ExpensePaymentKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type ListSupplierPaymentsQuery = z.infer<
  typeof ListSupplierPaymentsQuerySchema
>;

export interface SupplierPaymentDto {
  id: string;
  /** Вид заявки: оплата поставщику или выплата зарплаты. */
  kind: ExpensePaymentKind;
  /** Заполнены только у `kind = SUPPLIER`. */
  supplierId: string | null;
  supplierName: string | null;
  /** Заполнены только у `kind = SALARY`. */
  employeeId: string | null;
  employeeName: string | null;
  /** Выплата, породившая заявку (`kind = SALARY`). */
  payrollPayoutId: string | null;
  /**
   * Контрагент для отображения: имя поставщика или ФИО сотрудника
   * (в зависимости от `kind`). `null` — снимок не заполнен.
   */
  payeeName: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  accountId: string;
  accountName: string;
  itemId: string;
  itemName: string;
  /** Decimal как строка. */
  amount: string;
  status: SupplierPaymentStatus;
  comment: string | null;
  cashFlowEntryId: string | null;
  createdAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

// ---------------------------------------------------------------------------
// TreasurySettings — настройки модуля (Фаза 1)
// ---------------------------------------------------------------------------

/**
 * Обновление настроек казначейства. `null` очищает значение. Поля
 * опциональны — переданные перезаписываются, остальные не трогаются.
 */
export const UpdateTreasurySettingsSchema = z.object({
  /** «Зарплатный» счёт списания (id `CashAccount`) или `null`. */
  salaryAccountId: z.string().min(1).nullable().optional(),
  /** Статья ДДС для зарплаты (id `CashFlowItem`) или `null`. */
  salaryItemId: z.string().min(1).nullable().optional(),
  /** Счёт по умолчанию для оплат поставщикам (id `CashAccount`) или `null`. */
  supplierAccountId: z.string().min(1).nullable().optional(),
  /** Статья ДДС по умолчанию для оплат поставщикам (id `CashFlowItem`) или `null`. */
  supplierItemId: z.string().min(1).nullable().optional(),
});
export type UpdateTreasurySettingsDto = z.infer<
  typeof UpdateTreasurySettingsSchema
>;

export interface TreasurySettingsDto {
  salaryAccountId: string | null;
  salaryAccountName: string | null;
  salaryItemId: string | null;
  salaryItemName: string | null;
  /**
   * Дефолты для авто-создания «заявок на расход» из заявок на оплату
   * поставщику. `supplierAccountId` — счёт списания (если задан —
   * хэндофф в казначейство включён), `supplierItemId` — fallback статьи ДДС.
   */
  supplierAccountId: string | null;
  supplierAccountName: string | null;
  supplierItemId: string | null;
  supplierItemName: string | null;
}
