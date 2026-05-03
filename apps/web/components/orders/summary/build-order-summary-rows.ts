/**
 * `buildOrderSummaryRows` — собирает плоский список строк для
 * единой таблицы «Сводно по заказу» в карточке заказа
 * `/admin/orders/[id]` (вкладка «Сводно по заказу»).
 *
 * Это **чисто web-side агрегатор**: backend / Prisma / WorkshopNeed
 * formulas / OperationPlan formulas / OrderCostEstimate logic /
 * payroll / Passport НЕ меняются. Helper переиспользует уже
 * существующие row-builders:
 *
 *   - `buildOrderMaterialRows` (`materials/build-order-material-rows.ts`)
 *     отдаёт `OrderMaterialTableRow[]` для вкладки «Материалы»;
 *   - `buildOrderOperationRows` (`operations/build-order-operation-rows.ts`)
 *     отдаёт `OrderOperationTableRow[]` для вкладки «Операции».
 *
 * Здесь мы превращаем эти две коллекции в плоский
 * `OrderSummaryRow[]`, по одной строке на материал / операцию, +
 * считаем итоги (себестоимость / выручка / маржа).
 *
 * Никаких новых backend-вызовов и расчётов нет — только UI-склейка.
 *
 * Главные правила (см. ТЗ §«Сводно»):
 *   - USD-строки без курса не подмешиваются в RUB total. У такой
 *     строки `totalRub === null` и поднят warning «USD без курса».
 *     В исходной валюте показываем `totalDisplay` отдельно.
 *   - Если у материала / операции нет цены — `totalRub === null`,
 *     fake `0₽` мы не рисуем.
 *   - Если зафиксирован `currentCostEstimate` (документ
 *     «Себестоимость заказа» в статусе COMPLETED) — берём его
 *     `lineTotalRub` как более точный snapshot для материалов
 *     (там USD уже сконвертирован по `usdRateRub`). Для операций
 *     snapshot живёт в `Order.operationCostPlanRub`, его собирают
 *     отдельно в `computeOrderSummaryTotals`.
 *
 * SALARY_ONLY-операция может иметь стоимость, если
 * `operations/build-order-operation-rows.ts` сам её посчитал
 * (через `salaryPlanRubPerShift × shiftSeconds`); в этом случае
 * `lineTotalRub != null`. Если нет — `totalRub === null` и в
 * `comment` прокидываем «окладная». Backend formulas не дублируем.
 */
import {
  getWorkshopNeedKind,
  type WorkshopNeedKind,
} from '@sewing/shared/workshop-needs';
import type {
  MaterialIssueListItemDto,
  MaterialIssueStatus,
} from '@sewing/shared/material-issues';
import type { OrderCostEstimateDto } from '@sewing/shared/order-cost-estimates';
import type { OrderMaterialTableRow } from '@/components/orders/materials/build-order-material-rows';
import type { OrderOperationTableRow } from '@/components/orders/operations/build-order-operation-rows';

/** UI-секции единой таблицы «Сводно по заказу». */
export type OrderSummarySection =
  | 'MATERIAL'
  | 'HARDWARE'
  | 'APPLICATION'
  | 'OPERATION'
  | 'OTHER';

/** Лейблы секций — те же, что в `WORKSHOP_NEED_KIND_LABELS`,
 *  плюс «Операции». */
export const ORDER_SUMMARY_SECTION_LABELS: Record<
  OrderSummarySection,
  string
> = {
  MATERIAL: 'Материалы',
  HARDWARE: 'Фурнитура',
  APPLICATION: 'Нанесение',
  OPERATION: 'Операции',
  OTHER: 'Прочее',
};

/**
 * Денормализованная строка единой таблицы «Сводно».
 *
 * `qty` / `totalRub` / `unitCostRub` хранятся как `number | null`,
 * чтобы UI мог однозначно отличить «значения нет» от «значение
 * равно нулю». Display-строки (`qtyDisplay` / `totalDisplay` /
 * `priceDisplay`) — это уже отформатированный текст для `<td>`,
 * включая единицы и валюту. Это удобно для тестов: они проверяют
 * прямой substring без дополнительного форматирования.
 */
export interface OrderSummaryRow {
  /** Уникальный ключ строки (workshopNeedId / routeStepId). */
  id: string;
  /** Идентификатор источника — `'material'` или `'operation'`. */
  sourceKind: 'material' | 'operation';
  /** UI-секция (Материалы / Фурнитура / Нанесение / Операции / Прочее). */
  section: OrderSummarySection;
  /** Лейбл секции для колонки «Раздел». */
  sectionLabel: string;

  /** Колонка «Статья» — описание материала или имя операции. */
  article: string;

  /** Количество (для материалов: purchaseQty ?? calculatedQty;
   *  для операций: plannedQty). `null`, если данных нет. */
  qty: number | null;
  /** Display: `'80'` / `'100'` / `'—'`. */
  qtyDisplay: string;
  /** Единица измерения — `'кг'` / `'шт'` / `'м'` / …. */
  unit: string;

  /** Display колонки «Цена» — `'20 ₽'` / `'15 ₽'` / `'окладная'` /
   *  `'по размерам'` / `'—'`. Для USD-строк пишем `'$5'`. */
  priceDisplay: string;
  /** ISO-валюта для UI (`'RUB'` / `'USD'`) или `null`. */
  priceCurrency: 'RUB' | 'USD' | null;

  /** Сумма за тираж в рублях. `null`, если посчитать невозможно
   *  (нет цены / USD без курса / окладная без shift-rate). */
  totalRub: number | null;
  /** Display-сумма. Для RUB строк — `'1 600 ₽'`; для USD без
   *  курса — `'$80'` (исходная валюта); для пустых — `'—'`. */
  totalDisplay: string;

  /** Стоимость за 1 изделие в рублях (`totalRub / qtyTotalOrder`).
   *  `null`, если `totalRub === null` или `qtyTotalOrder <= 0`. */
  unitCostRub: number | null;

  /** Свободный комментарий + warnings (склеенный). */
  comment: string | null;
  /** Список warnings строки (для UI tooltip / списка). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers — formatting
// ---------------------------------------------------------------------------

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
});

const USD_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function fmtRub(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return RUB_FORMATTER.format(value);
}

function fmtUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return USD_FORMATTER.format(value);
}

function toFiniteNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Section resolver
// ---------------------------------------------------------------------------

/**
 * Маппит роль материала из `OrderMaterialTableRow` в UI-секцию
 * сводной таблицы. Используем `getWorkshopNeedKind` из shared,
 * чтобы не дублировать классификатор. Для операций секция всегда
 * `OPERATION`.
 */
function resolveMaterialSection(
  row: OrderMaterialTableRow,
): OrderSummarySection {
  const kind: WorkshopNeedKind = getWorkshopNeedKind({
    sourceType: row.originalNeed.sourceType,
    calculationMethod: row.originalNeed.calculationMethod,
    materialRole: row.originalNeed.materialRole ?? undefined,
  });
  switch (kind) {
    case 'MATERIAL':
      return 'MATERIAL';
    case 'HARDWARE':
      return 'HARDWARE';
    case 'APPLICATION':
      return 'APPLICATION';
    case 'OTHER':
    default:
      return 'OTHER';
  }
}

// ---------------------------------------------------------------------------
// Material → Summary row
// ---------------------------------------------------------------------------

interface MaterialSummaryInput {
  /** Опциональный snapshot завершённого расчёта. Если есть и для
   *  данного `workshopNeedId` найдена строка — `lineTotalRub` берём
   *  из snapshot (там USD уже сконвертирован). */
  estimate: OrderCostEstimateDto | null;
}

function buildMaterialRow(
  row: OrderMaterialTableRow,
  input: MaterialSummaryInput,
): OrderSummaryRow {
  // Отменённые строки не должны попадать в сводный итог; их
  // фильтрует caller (`buildOrderSummaryRows`), но защитимся
  // здесь.
  const section = resolveMaterialSection(row);
  const sectionLabel = ORDER_SUMMARY_SECTION_LABELS[section];

  const qtyNum =
    toFiniteNumber(row.purchaseQty) ?? toFiniteNumber(row.calculatedQty);
  const unit = row.unit ?? '';
  const qtyDisplay = (() => {
    const display = row.purchaseQty ?? row.calculatedQty;
    if (display == null || display === '') return '—';
    return String(display);
  })();

  const priceNum = toFiniteNumber(row.quotedPrice);
  const isUsd =
    String(row.quotedCurrency ?? '').toUpperCase() === 'USD';
  const priceCurrency: 'RUB' | 'USD' | null =
    priceNum == null
      ? null
      : isUsd
        ? 'USD'
        : 'RUB';
  const priceDisplay = (() => {
    if (priceNum == null) return '—';
    const fmt = isUsd ? fmtUsd(priceNum) : fmtRub(priceNum);
    return unit ? `${fmt} / ${unit}` : fmt;
  })();

  // Источник истины для total в RUB (приоритеты см. ТЗ §4):
  //   1. estimate.lineTotalRub по workshopNeedId — если расчёт
  //      зафиксирован, в нём USD уже сконвертирован по
  //      `usdRateRub`. Это самый точный snapshot.
  //   2. иначе `lineTotalRub` из OrderMaterialTableRow (RUB-строка).
  //   3. для USD без курса — null + warning.
  let totalRub: number | null = null;
  let totalDisplay = '—';
  if (input.estimate) {
    const snapshotLine = input.estimate.lines.find(
      (l) => l.workshopNeedId === row.id,
    );
    const snapshotTotal = snapshotLine
      ? toFiniteNumber(snapshotLine.lineTotalRub)
      : null;
    if (snapshotTotal != null) {
      totalRub = snapshotTotal;
      totalDisplay = fmtRub(snapshotTotal);
    }
  }
  if (totalRub == null) {
    const rowTotalRub = toFiniteNumber(row.lineTotalRub);
    const rowTotalUsd = toFiniteNumber(row.lineTotalUsd);
    if (rowTotalRub != null && !isUsd) {
      totalRub = rowTotalRub;
      totalDisplay = fmtRub(rowTotalRub);
    } else if (rowTotalUsd != null && isUsd) {
      // USD без курса — RUB остаётся null (fake 0 не показываем).
      totalRub = null;
      totalDisplay = fmtUsd(rowTotalUsd);
    }
  }

  // Warnings строки: переносим из row + добавляем «USD без курса»,
  // если RUB-итог не сложился из snapshot.
  const warnings = new Set<string>(row.warnings);
  if (isUsd && totalRub == null) {
    warnings.add('USD без курса — сумма в рублях не считается');
  }
  if (priceNum == null) {
    warnings.add('Цена не указана');
  }

  // Comment колонки таблицы — короткий «человеческий» текст:
  // склеиваем `commentText` (если есть) + до 2 первых warnings.
  const commentParts: string[] = [];
  if (row.commentText) commentParts.push(row.commentText);
  for (const w of warnings) commentParts.push(w);
  const comment =
    commentParts.length > 0 ? commentParts.join(' · ') : null;

  return {
    id: row.id,
    sourceKind: 'material',
    section,
    sectionLabel,
    article: row.description,
    qty: qtyNum,
    qtyDisplay,
    unit,
    priceDisplay,
    priceCurrency,
    totalRub,
    totalDisplay,
    unitCostRub: null, // будет посчитан caller-ом, когда знает qtyTotal заказа
    comment,
    warnings: Array.from(warnings),
  };
}

// ---------------------------------------------------------------------------
// Operation → Summary row
// ---------------------------------------------------------------------------

function buildOperationRow(
  row: OrderOperationTableRow,
): OrderSummaryRow {
  const section: OrderSummarySection = 'OPERATION';
  const sectionLabel = ORDER_SUMMARY_SECTION_LABELS[section];

  const qty = row.plannedQty > 0 ? row.plannedQty : null;
  const qtyDisplay = qty != null ? String(qty) : '—';
  const unit = 'шт';

  // Цена: используем priceLabel (готовый текст «25 ₽/шт» / «по
  // размерам» / «окладная» / «—»).
  const priceDisplay = row.priceLabel ?? '—';
  const priceCurrency: 'RUB' | 'USD' | null =
    row.lineTotalRub != null ? 'RUB' : null;

  let totalRub: number | null = null;
  let totalDisplay = '—';
  if (row.lineTotalRub != null && Number.isFinite(row.lineTotalRub)) {
    totalRub = row.lineTotalRub;
    totalDisplay = fmtRub(row.lineTotalRub);
  }

  // Warnings + хинт «окладная» (если backend не дал точную сумму).
  const warnings = new Set<string>(row.warnings);
  if (totalRub == null) {
    if (row.costFallbackLabel) {
      warnings.add(
        `${row.costFallbackLabel}: точный итог зафиксируется при расчёте плана операций`,
      );
    } else if (row.priceLabel === '—') {
      warnings.add('Нет ставки');
    }
  }

  const commentParts: string[] = [];
  if (row.commentText) commentParts.push(row.commentText);
  if (row.costFallbackLabel)
    commentParts.push(`Тариф: ${row.costFallbackLabel}`);
  for (const w of warnings) commentParts.push(w);
  const comment =
    commentParts.length > 0 ? commentParts.join(' · ') : null;

  return {
    id: row.id,
    sourceKind: 'operation',
    section,
    sectionLabel,
    article: row.operationName,
    qty,
    qtyDisplay,
    unit,
    priceDisplay,
    priceCurrency,
    totalRub,
    totalDisplay,
    unitCostRub: null,
    comment,
    warnings: Array.from(warnings),
  };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

interface BuildOrderSummaryRowsInput {
  materialRows: OrderMaterialTableRow[];
  operationRows: OrderOperationTableRow[];
  /** Snapshot завершённого расчёта (если есть). */
  currentCostEstimate?: OrderCostEstimateDto | null;
  /** Тираж заказа — для расчёта `unitCostRub` каждой строки. */
  qtyTotal: number;
}

/**
 * Главный helper — собирает единую плоскую коллекцию строк сводной
 * таблицы из материалов + операций. Отменённые материалы в сводный
 * итог не попадают. Сортировка:
 *
 *   1. Материалы (в порядке `OrderMaterialTableRow` — он уже
 *      приоритезирует MAIN_FABRIC и т.п.);
 *   2. Фурнитура;
 *   3. Нанесение;
 *   4. Прочее (всё остальное по материалам);
 *   5. Операции (в порядке маршрута, как в `OrderOperationTableRow`).
 */
export function buildOrderSummaryRows(
  input: BuildOrderSummaryRowsInput,
): OrderSummaryRow[] {
  const {
    materialRows,
    operationRows,
    currentCostEstimate = null,
    qtyTotal,
  } = input;

  const materialRowsActive = materialRows.filter(
    (r) => r.originalNeed.status !== 'CANCELLED',
  );

  const buckets: Record<OrderSummarySection, OrderSummaryRow[]> = {
    MATERIAL: [],
    HARDWARE: [],
    APPLICATION: [],
    OPERATION: [],
    OTHER: [],
  };

  for (const r of materialRowsActive) {
    const summaryRow = buildMaterialRow(r, {
      estimate: currentCostEstimate,
    });
    buckets[summaryRow.section].push(summaryRow);
  }
  for (const r of operationRows) {
    const summaryRow = buildOperationRow(r);
    buckets.OPERATION.push(summaryRow);
  }

  const sectionOrder: OrderSummarySection[] = [
    'MATERIAL',
    'HARDWARE',
    'APPLICATION',
    'OTHER',
    'OPERATION',
  ];

  const rows: OrderSummaryRow[] = [];
  for (const section of sectionOrder) {
    for (const r of buckets[section]) rows.push(r);
  }

  // unitCostRub считаем после сборки — нужен `qtyTotal` заказа.
  if (qtyTotal > 0) {
    for (const r of rows) {
      if (r.totalRub != null) {
        r.unitCostRub = r.totalRub / qtyTotal;
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** Суммарные показатели для блока «Итоги» под таблицей. */
export interface OrderSummaryTotals {
  /** Тираж заказа (`order.qtyPlanTotal`). */
  qtyTotal: number;

  /** Σ totalRub по секциям (если хоть одна строка в секции имеет
   *  RUB-сумму, иначе `null`). */
  byKind: {
    material: number | null;
    hardware: number | null;
    application: number | null;
    operation: number | null;
    other: number | null;
  };

  /** Σ totalRub по всем строкам, у которых есть RUB-сумма. `null`,
   *  если ни у одной строки нет RUB-суммы. */
  costTotalRub: number | null;
  /** `costTotalRub / qtyTotal` или `null`. */
  costPerUnitRub: number | null;

  /**
   * Фактическая стоимость материалов по заказу — Σ
   * `MaterialIssue.totalCost` по всем POSTED-документам этого
   * заказа. Источник истины — `MaterialIssue.totalCost` (а не
   * пересчёт строк на frontend), как требует MVP-итерация
   * «Фактический расход». DRAFT и CANCELLED документы не
   * учитываются.
   *
   * Источник `MaterialIssue` для финансовой сводки сознательно
   * НЕ требует `workshopNeedId` у строк и НЕ требует `passportId`
   * у документа: order-level financial summary показывает «всё, что
   * фактически выдано в производство по этому заказу», даже если
   * строка не сопоставлена с конкретной потребностью цеха.
   *
   * `null`, только если `materialIssues` не передан — в этом
   * случае мы не можем отличить «нет факта» от «факт не
   * загружен». При переданном пустом массиве — `0`.
   */
  materialActualCostRub: number | null;
  /**
   * Отклонение факта от плана по материалам:
   * `materialActualCostRub - byKind.material`.
   *
   * `null`, если плана по материалам нет (`byKind.material === null`)
   * либо если факт не передавался (`materialActualCostRub === null`).
   * Положительное значение — перерасход, отрицательное — экономия.
   */
  materialDeltaCostRub: number | null;

  /** Цена продажи за единицу (как пришла из заказа). */
  customerUnitPrice: number | null;
  customerCurrency: 'RUB' | 'USD' | null;

  /** Выручка за тираж в рублях. `null`, если цены нет / USD без курса. */
  revenueTotalRub: number | null;
  /** Маржа за тираж в рублях. `null`, если выручка / себестоимость не
   *  считаются. */
  marginTotalRub: number | null;
  /** Маржа за 1 изделие. `null`, если `marginTotalRub === null` или
   *  `qtyTotal <= 0`. */
  marginPerUnitRub: number | null;
  /** Маржинальность в процентах. `null`, если выручка <= 0. */
  marginPercent: number | null;

  /** Список warnings уровня заказа (есть USD без курса / нет тиража /
   *  нет цены продажи / есть строки без цены / есть стейл план
   *  операций). */
  warnings: string[];
}

interface ComputeTotalsInput {
  rows: OrderSummaryRow[];
  qtyTotal: number;
  /** Цена продажи за единицу (raw). */
  customerUnitPrice: string | number | null | undefined;
  /** Валюта цены продажи. */
  customerCurrency: 'RUB' | 'USD' | string | null | undefined;
  /** Опциональный «есть пометка stale план операций» — для warning. */
  operationPlanIsStale?: boolean | null;
  /** Опциональный «есть незавершённый расчёт себестоимости» — для warning. */
  hasCompletedEstimate?: boolean;
  /**
   * Список документов «Фактический расход материалов» по заказу
   * (`GET /api/orders/:orderId/material-issues`). Используется для
   * подсчёта `materialActualCostRub` / `materialDeltaCostRub` —
   * order-level финансового факта. На уровне сводки берём ТОЛЬКО
   * POSTED-документы; DRAFT и CANCELLED игнорируются.
   *
   * Если `undefined` — `materialActualCostRub` останется `null` и
   * сводка покажет «—» для факта. Это отличается от `[]` (явный
   * пустой массив) — `[]` означает «факта по заказу нет», и тогда
   * сводка показывает `0 ₽`.
   */
  materialIssues?: MaterialIssueListItemDto[];
}

export function computeOrderSummaryTotals(
  input: ComputeTotalsInput,
): OrderSummaryTotals {
  const {
    rows,
    qtyTotal,
    customerUnitPrice,
    customerCurrency,
    operationPlanIsStale,
    hasCompletedEstimate,
    materialIssues,
  } = input;

  const byKind: OrderSummaryTotals['byKind'] = {
    material: null,
    hardware: null,
    application: null,
    operation: null,
    other: null,
  };

  let costTotalRub: number | null = null;
  let hasUsdMissingRate = false;
  let hasMissingPrice = false;
  let hasOperationFallback = false;

  for (const r of rows) {
    if (r.totalRub != null) {
      costTotalRub = (costTotalRub ?? 0) + r.totalRub;
      const bucketKey: keyof OrderSummaryTotals['byKind'] = (() => {
        switch (r.section) {
          case 'MATERIAL':
            return 'material';
          case 'HARDWARE':
            return 'hardware';
          case 'APPLICATION':
            return 'application';
          case 'OPERATION':
            return 'operation';
          case 'OTHER':
          default:
            return 'other';
        }
      })();
      byKind[bucketKey] = (byKind[bucketKey] ?? 0) + r.totalRub;
    } else {
      // Строка без RUB-суммы — поднимаем причину.
      if (
        r.priceCurrency === 'USD' ||
        r.warnings.some((w) => w.includes('USD без курса'))
      ) {
        hasUsdMissingRate = true;
      } else if (r.priceDisplay === '—' || r.priceDisplay === '') {
        if (r.sourceKind === 'operation') hasOperationFallback = true;
        else hasMissingPrice = true;
      } else if (r.sourceKind === 'operation') {
        // priceLabel = «окладная» / «по размерам» — backend не дал
        // точную сумму. Это не «нет цены», а fallback.
        hasOperationFallback = true;
      }
    }
  }

  const costPerUnitRub =
    costTotalRub != null && qtyTotal > 0
      ? costTotalRub / qtyTotal
      : null;

  // Фактическая стоимость материалов: Σ MaterialIssue.totalCost по
  // POSTED-документам. Источник истины — `MaterialIssue.totalCost`,
  // не пересчёт строк (см. ТЗ: `passportId` / `workshopNeedId` тут
  // не требуются). DRAFT / CANCELLED игнорируем.
  let materialActualCostRub: number | null = null;
  if (materialIssues !== undefined) {
    let actualSum = 0;
    for (const issue of materialIssues) {
      if ((issue.status as MaterialIssueStatus) !== 'POSTED') continue;
      const n = Number(issue.totalCost);
      if (Number.isFinite(n)) actualSum += n;
    }
    materialActualCostRub = actualSum;
  }
  // Δ = факт - план. Если план неизвестен (нет ни одной MATERIAL
  // строки в RUB) — отклонение тоже неизвестно, иначе UI показал
  // бы фейковый «перерасход» на всю фактическую сумму.
  const plannedMaterialCostRub = byKind.material;
  const materialDeltaCostRub =
    materialActualCostRub != null && plannedMaterialCostRub != null
      ? materialActualCostRub - plannedMaterialCostRub
      : null;

  // Цена продажи и выручка.
  const priceNum =
    customerUnitPrice == null || customerUnitPrice === ''
      ? null
      : Number(customerUnitPrice);
  const customerUnitPriceNum =
    priceNum != null && Number.isFinite(priceNum) && priceNum > 0
      ? priceNum
      : null;
  const customerCurrencyResolved: 'RUB' | 'USD' | null =
    customerUnitPriceNum == null
      ? null
      : (String(customerCurrency ?? 'RUB').toUpperCase() === 'USD'
          ? 'USD'
          : 'RUB');

  const revenueTotalRub =
    customerUnitPriceNum != null &&
    customerCurrencyResolved === 'RUB' &&
    qtyTotal > 0
      ? customerUnitPriceNum * qtyTotal
      : null;

  const marginTotalRub =
    revenueTotalRub != null && costTotalRub != null
      ? revenueTotalRub - costTotalRub
      : null;
  const marginPerUnitRub =
    marginTotalRub != null && qtyTotal > 0
      ? marginTotalRub / qtyTotal
      : null;
  const marginPercent =
    marginTotalRub != null &&
    revenueTotalRub != null &&
    revenueTotalRub > 0
      ? (marginTotalRub / revenueTotalRub) * 100
      : null;

  // Order-level warnings.
  const warnings: string[] = [];
  if (qtyTotal <= 0) {
    warnings.push('Не заполнен тираж');
  }
  if (hasUsdMissingRate) {
    warnings.push('Есть строки в USD без курса — сумма в рублях не считается');
  }
  if (hasMissingPrice) {
    warnings.push('Есть материалы без цены');
  }
  if (hasOperationFallback) {
    warnings.push(
      'Есть операции без точной ставки (окладная / план не зафиксирован)',
    );
  }
  if (operationPlanIsStale === true) {
    warnings.push('План операций требует пересчёта');
  }
  if (customerUnitPriceNum == null) {
    warnings.push('Не указана цена продажи');
  } else if (customerCurrencyResolved === 'USD') {
    warnings.push('Маржа не рассчитана: цена продажи в USD без курса');
  }
  if (
    !hasCompletedEstimate &&
    rows.some((r) => r.sourceKind === 'material')
  ) {
    warnings.push('Расчёт себестоимости не завершён');
  }

  return {
    qtyTotal,
    byKind,
    costTotalRub,
    costPerUnitRub,
    materialActualCostRub,
    materialDeltaCostRub,
    customerUnitPrice: customerUnitPriceNum,
    customerCurrency: customerCurrencyResolved,
    revenueTotalRub,
    marginTotalRub,
    marginPerUnitRub,
    marginPercent,
    warnings,
  };
}
