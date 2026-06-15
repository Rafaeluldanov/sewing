/**
 * Контракт отчёта «Материалы: план → факт по заказу» (Себестоимость,
 * Фаза 2 — первый срез).
 *
 * Read-модель поверх существующих данных (новых таблиц нет):
 *   - ПЛАН — активный `OrderCostEstimate` (строки kind MATERIAL/HARDWARE),
 *     либо fallback на `WorkshopNeed` (RUB), либо нет плана;
 *   - ФАКТ — POSTED `PurchaseReceiptLine` по заказу (`receivedQty ×
 *     priceSnapshot`→RUB), привязка к заказу через `receipt.customerOrderId`
 *     или `line.workshopNeed.orderId`.
 *
 * Себестоимость ПОТРЕБЛЯЕТ факт приёмок — она не пишет проводок. Курс
 * USD для факта берётся из активной сметы заказа; если его нет, USD-строки
 * не учитываются (флаг `USD_NO_RATE`). Backend — `apps/api/src/modules/
 * costs/order-actual-materials.service.ts`.
 */

/** Источник плановой стоимости материалов. */
export const MATERIAL_PLAN_SOURCES = [
  'COST_ESTIMATE',
  'WORKSHOP_NEED',
  'NONE',
] as const;
export type MaterialPlanSource = (typeof MATERIAL_PLAN_SOURCES)[number];
export const MATERIAL_PLAN_SOURCE_LABELS: Record<MaterialPlanSource, string> = {
  COST_ESTIMATE: 'Расчёт себестоимости',
  WORKSHOP_NEED: 'Потребность цеха',
  NONE: 'Нет плана',
};

/** Коды предупреждений по строке отчёта. */
export const MATERIAL_FACT_WARNING_LABELS: Record<string, string> = {
  USD_NO_RATE: 'Есть приёмки в USD без курса — не учтены в факте',
  NO_PRICE: 'Есть приёмки без цены — не учтены в факте',
  PLAN_USD_SKIPPED: 'План по потребности: USD-строки без курса не учтены',
};

export interface OrderActualMaterialsRowDto {
  orderId: string;
  orderNumber: string;
  /** Плановая стоимость материалов (Decimal как строка). */
  planMaterialsRub: string;
  planSource: MaterialPlanSource;
  /** Фактическая стоимость материалов из приёмок (Decimal как строка). */
  factMaterialsRub: string;
  /** `fact − plan` по материалам (Decimal как строка; «+» = перерасход). */
  varianceRub: string;
  /** Число учтённых POSTED-строк приёмок. */
  receiptLinesCount: number;

  // --- Труд (Срез 2) ---
  /** Плановая стоимость труда — `Order.operationCostPlanRub`. */
  planLaborRub: string;
  /** Фактическая сдельная выработка — Σ `OperationEntry` APPROVED. */
  factLaborRub: string;
  /** `fact − plan` по труду (Decimal как строка). */
  varianceLaborRub: string;

  // --- Прямая себестоимость (материалы + труд) ---
  planDirectRub: string;
  factDirectRub: string;
  /** `fact − plan` по прямой себестоимости. */
  varianceDirectRub: string;

  // --- Накладные + полная себестоимость (Срез 3, fact-only) ---
  /**
   * Распределённые накладные из журнала ДДС (пропорционально прямой
   * себестоимости). Плана у накладных нет.
   */
  overheadRub: string;
  /** Полная фактическая себестоимость = прямая факт + накладные. */
  fullCostFactRub: string;

  /** Коды предупреждений (см. `MATERIAL_FACT_WARNING_LABELS`). */
  warnings: string[];
}

export interface OrderActualMaterialsReportDto {
  rows: OrderActualMaterialsRowDto[];
  /** Итоги по материалам. */
  totalPlanRub: string;
  totalFactRub: string;
  totalVarianceRub: string;
  /** Итоги по труду. */
  totalPlanLaborRub: string;
  totalFactLaborRub: string;
  /** Итоги по прямой себестоимости (материалы + труд). */
  totalPlanDirectRub: string;
  totalFactDirectRub: string;
  totalVarianceDirectRub: string;
  /**
   * Пул накладных из журнала ДДС (OUT по статьям isOverhead, нетто
   * сторно), распределённый на показанные заказы.
   */
  totalOverheadRub: string;
  /** Полная фактическая себестоимость по всем заказам. */
  totalFullCostFactRub: string;
}
