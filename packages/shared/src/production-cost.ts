/**
 * Контракты управленческого отчёта «Себестоимость производства v2»
 * (см. `docs/production-cost-v2-recon.md`).
 *
 * Это **отдельный контракт** от `./costs.ts`: старый эндпоинт
 * `GET /api/costs/production` (cell-фокус: «себестоимость по дню
 * упаковки + простой») остаётся как есть. Новый отчёт делает разрез
 * по **номенклатуре / лекалам, заказам, операциям, сотрудникам и
 * размерам** — это управленческий P&L, который должен показывать,
 * где формируются деньги.
 *
 * Дизайн MVP:
 *
 *   - паспорт **не** является основной сущностью отчёта; используется
 *     только как технический join `OperationEntry → Passport → Order
 *     → PatternItem`. `passportId` / `passportNumber` могут лежать в
 *     `ProductionCostOperationLineDto` как secondary technical
 *     поля для отладки/будущего drill-down, но в UI основной таблицы
 *     колонки «Паспорт» **нет**;
 *   - выпуск считается в **единицах изделий**: `Σ Passport.qtyGood`
 *     для паспортов в финальном статусе `PACKED`. Нельзя
 *     суммировать `OperationEntry.qty` по всем операциям — одна
 *     единица проходит много операций;
 *   - факт операций — `OperationEntry` (только `APPROVED` по
 *     умолчанию), сумма = `OperationEntry.amount`;
 *   - материалы / фурнитура / нанесение — **расчётная основа**,
 *     не факт списания: берём из `Order.currentCostEstimate` (или
 *     fallback из `WorkshopNeed`), пропорционально аллоцируя по
 *     `releasedQtyInPeriod / order.qtyPlanTotal`. UI подписывает
 *     честно: «по завершённому расчёту» / «по текущей потребности»;
 *   - выручка — `Order.customerUnitPrice (RUB) × releasedQty`. USD
 *     без курса не смешиваем — отдельный warning, `revenueRub = 0`;
 *   - окладную часть в v2 не распределяем по номенклатуре (отдельный
 *     алгоритм). `salaryAllocatedCostRub = 0` + warning.
 *
 * Все суммы — `string` (Decimal сериализуется как в
 * `OrderCostEstimateLineDto`). Количества — `number`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const DateOnlySchema = z
  .string()
  .min(1)
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
    'Дата в формате YYYY-MM-DD',
  );

/**
 * Допустимые статусы `OperationEntry` для отчёта. По умолчанию
 * сервис берёт `APPROVED` — это «реальные деньги, которые платим».
 */
export const PRODUCTION_COST_V2_ENTRY_STATUSES = [
  'APPROVED',
  'PENDING',
  'PENDING_RELEASE',
  'CANCELLED',
  'REVERSED',
] as const;
export type ProductionCostV2EntryStatus =
  (typeof PRODUCTION_COST_V2_ENTRY_STATUSES)[number];

/**
 * Query `GET /api/admin/production-cost/v2`.
 *
 * Период необязателен: без него возвращаем «последние 30 календарных
 * дней по UTC». Для управленческого отчёта 30 дней — разумный
 * дефолт (один отчётный месяц).
 */
export const ProductionCostV2QuerySchema = z.object({
  dateFrom: DateOnlySchema.optional(),
  dateTo: DateOnlySchema.optional(),
  patternItemId: z.string().min(1).optional(),
  orderId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  status: z.enum(PRODUCTION_COST_V2_ENTRY_STATUSES).optional(),
});
export type ProductionCostV2Query = z.infer<typeof ProductionCostV2QuerySchema>;

// ---------------------------------------------------------------------------
// Source markers
// ---------------------------------------------------------------------------

/**
 * Источник материальной части для конкретного заказа в группе:
 *
 *   - `COST_ESTIMATE` — у заказа есть `currentCostEstimate`
 *     (status `COMPLETED`), используем его строки;
 *   - `WORKSHOP_NEED` — `currentCostEstimate` нет, считаем по
 *     активным `WorkshopNeed` (только RUB-строки);
 *   - `NONE` — ни того ни другого; материалы = 0, в warnings
 *     добавим строку «Нет источника материалов для заказа …».
 */
export const PRODUCTION_COST_MATERIAL_SOURCES = [
  'COST_ESTIMATE',
  'WORKSHOP_NEED',
  'NONE',
] as const;
export type ProductionCostMaterialSource =
  (typeof PRODUCTION_COST_MATERIAL_SOURCES)[number];

export const PRODUCTION_COST_MATERIAL_SOURCE_LABELS: Record<
  ProductionCostMaterialSource,
  string
> = {
  COST_ESTIMATE: 'Материалы по завершённому расчёту',
  WORKSHOP_NEED: 'Материалы по текущей потребности',
  NONE: 'Материалы не рассчитаны',
};

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * Агрегат «Операция внутри лекала» (см.
 * `ProductionCostNomenclatureGroupDto.operationBreakdown`).
 */
export interface ProductionCostOperationAggregateDto {
  operationId: string;
  operationName: string;
  operationCategory: string;
  /** Σ `OperationEntry.qty` по этой операции в группе. */
  qty: number;
  /** Σ `OperationEntry.amount`. */
  amount: string;
  /** `amount / qty`, средняя стоимость операции за единицу. */
  unitCostAvg: string;
}

/**
 * Агрегат окладной (`SALARY_ONLY`) операции в отчёте «Себестоимость».
 *
 * Эти операции (ОТК / ВТО / Упаковка / Деление кроя) НЕ создают
 * `OperationEntry`, поэтому их нет в `operationBreakdown` / `operationLines`
 * (те строятся из сдельных начислений). Стоимость берётся из движка
 * разноса реального времени (`PassportRealCostService`): разнесённые
 * минуты × (оклад / 480).
 */
export interface ProductionCostSalaryOperationDto {
  operationId: string;
  operationName: string;
  operationCategory: string;
  /** Σ разнесённых реальных минут по операции за период. */
  minutes: number;
  /** Σ ₽ оклада, отнесённого на эту операцию. */
  rub: string;
  /** `rub / minutes` — стоимость минуты (≈ ставка окладника). */
  rubPerMinute: string | null;
}

/**
 * Агрегат «Сотрудник внутри лекала» (см.
 * `ProductionCostNomenclatureGroupDto.employeeBreakdown`).
 */
export interface ProductionCostEmployeeAggregateDto {
  employeeId: string;
  employeeName: string;
  /** Σ `OperationEntry.qty` по сотруднику в группе. */
  qty: number;
  /** Σ `OperationEntry.amount`. */
  amount: string;
}

/**
 * Агрегат «Размер внутри лекала» (см.
 * `ProductionCostNomenclatureGroupDto.sizeBreakdown`).
 */
export interface ProductionCostSizeAggregateDto {
  sizeId: string | null;
  sizeCode: string;
  /** `Σ Passport.qtyGood` для PACKED-паспортов в этом размере. */
  releasedQty: number;
  /** Σ `OperationEntry.amount` по операциям, где паспорт этого размера. */
  operationCostRub: string;
}

// ---------------------------------------------------------------------------
// Operation line (детальная расшифровка)
// ---------------------------------------------------------------------------

/**
 * Одна строка расшифровки операций — это **одна `OperationEntry`**.
 *
 * UI отчёта **не показывает** колонку «Паспорт» как основную, но
 * `passportId` / `passportNumber` остаются в DTO как **optional
 * technical** поля для:
 *
 *   - отладки backend (proп нашёл, как образовалась сумма);
 *   - будущего drill-down «открыть карточку паспорта».
 */
export interface ProductionCostOperationLineDto {
  operationEntryId: string;
  /** ISO date-time, `approvedAt ?? createdAt`. */
  date: string;

  orderId: string;
  orderNumber: string;
  clientName: string | null;

  patternItemId: string | null;
  nomenclatureName: string | null;
  nomenclatureArticle: string | null;

  sizeId: string | null;
  sizeCode: string;

  color: string | null;

  operationId: string;
  operationName: string;
  operationCategory: string;

  employeeId: string;
  employeeName: string;

  qty: number;
  ratePerUnit: string;
  amount: string;
  /** `amount / qty`, либо `null` при `qty = 0`. */
  unitCost: string | null;

  status: string;
  sourceEventType: string;
  approvalMode: string;

  /** Optional technical: passport id (для отладки/drill-down). */
  passportId?: string;
  /** Optional technical: passport number (для отладки/drill-down). */
  passportNumber?: string;
}

// ---------------------------------------------------------------------------
// Order group
// ---------------------------------------------------------------------------

export interface ProductionCostOrderGroupDto {
  orderId: string;
  orderNumber: string;
  clientId: string | null;
  clientName: string | null;

  patternItemId: string | null;
  nomenclatureName: string | null;
  nomenclatureArticle: string | null;
  color: string | null;

  /** `Σ Passport.qtyGood` для PACKED-паспортов этого заказа в периоде. */
  releasedQty: number;
  /** Сколько PACKED-паспортов было в периоде по этому заказу (secondary). */
  passportsCount: number;
  /** План заказа (`Σ OrderItem.qtyPlan`) — для прозрачности проративки. */
  qtyPlanTotal: number;
  /** Сколько строк начислений по этому заказу попало в выборку. */
  operationEntriesCount: number;

  /** `customerUnitPrice (RUB) × releasedQty`; `'0'`, если USD без курса. */
  revenueRub: string;
  /** Из `OrderCostEstimateLine.kind = MATERIAL` × прората. */
  materialCostRub: string;
  /** `kind = HARDWARE`. */
  hardwareCostRub: string;
  /** `kind = APPLICATION`. */
  applicationCostRub: string;
  /** Σ `OperationEntry.amount` по заказу в выборке. */
  operationPieceworkCostRub: string;
  /** В MVP всегда `'0'` + warning «не распределено по номенклатуре». */
  salaryAllocatedCostRub: string;
  /** `kind = OTHER`. */
  otherCostRub: string;

  totalCostRub: string;
  /** `totalCostRub / releasedQty`, либо `null` при выпуске = 0. */
  unitCostRub: string | null;
  marginRub: string;
  marginPercent: string | null;

  materialSource: ProductionCostMaterialSource;
  /** Original currency для customerUnitPrice (`RUB | USD | null`). */
  customerCurrency: string | null;
  /** Original customerUnitPrice (string Decimal или null). */
  customerUnitPrice: string | null;
}

// ---------------------------------------------------------------------------
// Nomenclature group (главный разрез)
// ---------------------------------------------------------------------------

export interface ProductionCostNomenclatureGroupDto {
  /**
   * Стабильный ключ группы. Для лекал с `PatternItem` =
   * `pattern:<patternItemId>`, для legacy =
   * `legacy:<nomenclatureName>|<nomenclatureArticle ?? ''>`.
   */
  nomenclatureKey: string;
  patternItemId: string | null;
  nomenclatureName: string | null;
  nomenclatureArticle: string | null;
  previewImageUrl: string | null;
  categoryName: string | null;

  releasedQty: number;
  /** Secondary: сколько PACKED-паспортов агрегировалось. */
  passportsCount: number;
  ordersCount: number;
  operationEntriesCount: number;

  revenueRub: string;
  materialCostRub: string;
  hardwareCostRub: string;
  applicationCostRub: string;
  operationPieceworkCostRub: string;
  salaryAllocatedCostRub: string;
  otherCostRub: string;
  totalCostRub: string;

  /** `totalCostRub / releasedQty`; `null` при выпуске = 0. */
  unitCostRub: string | null;
  marginRub: string;
  marginPercent: string | null;

  operationBreakdown: ProductionCostOperationAggregateDto[];
  employeeBreakdown: ProductionCostEmployeeAggregateDto[];
  sizeBreakdown: ProductionCostSizeAggregateDto[];
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface ProductionCostTotalsDto {
  releasedQty: number;
  passportsCount: number;
  ordersCount: number;
  operationEntriesCount: number;

  revenueRub: string;
  materialCostRub: string;
  hardwareCostRub: string;
  applicationCostRub: string;
  operationPieceworkCostRub: string;
  salaryAllocatedCostRub: string;
  otherCostRub: string;
  totalCostRub: string;

  /** `totalCostRub / releasedQty`; `null` при выпуске = 0. */
  unitCostRub: string | null;
  marginRub: string;
  marginPercent: string | null;
}

// ---------------------------------------------------------------------------
// Top-level response
// ---------------------------------------------------------------------------

export interface ProductionCostReportDto {
  dateFrom: string;
  dateTo: string;
  /** Какой статус OperationEntry брался (`APPROVED` по умолчанию). */
  entryStatus: ProductionCostV2EntryStatus;
  totals: ProductionCostTotalsDto;
  nomenclatureGroups: ProductionCostNomenclatureGroupDto[];
  orderGroups: ProductionCostOrderGroupDto[];
  /** Детальная расшифровка операций (без обязательной колонки «Паспорт»). */
  operationLines: ProductionCostOperationLineDto[];
  /**
   * Окладные операции (ОТК / ВТО / Упаковка / Деление кроя) — отдельная
   * таблица: у них нет `OperationEntry`, стоимость считается из
   * разнесённого реального времени. Пусто, если за период по окладным
   * операциям не было событий/окладников.
   */
  salaryOperationBreakdown: ProductionCostSalaryOperationDto[];
  /**
   * Человекочитаемые предупреждения: USD без курса, отсутствие
   * cost-estimate, не распределённый оклад и т. п.
   */
  warnings: string[];
}
