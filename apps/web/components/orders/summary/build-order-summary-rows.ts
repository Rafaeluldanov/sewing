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
 *
 * Разбиение по расцветкам (07.08): `groupOrderSummaryRowsByColorway`
 * перераскладывает готовые `OrderSummaryRow[]` на блоки-расцветки
 * (по `WorkshopNeed.orderVariantId`), блок «Общее по заказу» и
 * секцию операций. Подытог блока — только материальная часть
 * расцветки; общий итог считается ДО группировки и не меняется.
 */
import {
  getWorkshopNeedKind,
  type WorkshopNeedKind,
} from '@sewing/shared/workshop-needs';
import type { OrderColorwaysDto } from '@sewing/shared';
import type {
  MaterialIssueListItemDto,
  MaterialIssueStatus,
} from '@sewing/shared/material-issues';
import type { OrderCostEstimateDto } from '@sewing/shared/order-cost-estimates';
import { ORDER_LOGISTICS_SOURCE_TYPE } from '@sewing/shared/order-extra-costs';
import type {
  OrderLogisticsLineDto,
  OrderMaterialsAndHardwareCostPolicy,
} from '@sewing/shared/orders';
import type { OrderMaterialTableRow } from '@/components/orders/materials/build-order-material-rows';
import type { OrderOperationTableRow } from '@/components/orders/operations/build-order-operation-rows';

/**
 * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
 * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
 * `docs/current-state.md §«Давальческое сырьё клиента»`).
 *
 * Если у заказа `materialsAndHardwareCostPolicy = 'EXCLUDE'`, секции
 * MATERIAL и HARDWARE не должны попадать в финансовую сводку: план,
 * факт, дельта по этим секциям становятся `0` / `null`, в UI колонке
 * «Сумма за тираж» показываем «не учитывается». APPLICATION (нанесение)
 * и OTHER не затрагиваются — это услуги/нанесения компании, они
 * остаются в себестоимости как раньше.
 */
const EXCLUDED_SECTIONS_FOR_GIVEN_MATERIAL: ReadonlySet<OrderSummarySection> =
  new Set(['MATERIAL', 'HARDWARE']);

/** Помощник: эта строка должна игнорироваться в финансовой сводке? */
function isFinanciallyExcludedRow(
  row: { section: OrderSummarySection; sourceKind: 'material' | 'operation' },
  policy: OrderMaterialsAndHardwareCostPolicy,
): boolean {
  return (
    policy === 'EXCLUDE' &&
    row.sourceKind === 'material' &&
    EXCLUDED_SECTIONS_FOR_GIVEN_MATERIAL.has(row.section)
  );
}

/** Лейбл, который мы показываем в колонке «Сумма за тираж» / комментарии,
 *  когда строка финансово исключена политикой EXCLUDE. */
export const ORDER_MATERIALS_AND_HARDWARE_EXCLUDED_LABEL = 'не учитывается';

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

  /**
   * Фича «Расцветки» (FEATURE_COLORWAYS): к какой расцветке
   * (`OrderVariant`) относится строка. Приходит из
   * `WorkshopNeed.orderVariantId` — потребность считается по каждой
   * расцветке отдельно. `null` — order-level строка (нанесение /
   * ручная строка / заказ с ≤1 расцветкой / операция / строка сметы).
   * `variantColor` — snapshot цвета на момент расчёта потребности;
   * используется как fallback-лейбл группы, если живая расцветка
   * уже удалена или недоступна.
   */
  orderVariantId: string | null;
  variantColor: string | null;
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
    orderVariantId: row.originalNeed.orderVariantId ?? null,
    variantColor: row.originalNeed.variantColor ?? null,
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
    // Маршрут один на заказ — операции к расцветке не привязаны.
    orderVariantId: null,
    variantColor: null,
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
  /**
   * Ручные строки логистики заказа (кнопка «Добавить поле» в таблице
   * «Операции», `OrderDetailDto.logisticsLines`). Это деньги заказа, и
   * «Сводно» обязано их показывать в секции «Прочее».
   *
   * Основной источник — всё та же зафиксированная смета: backend
   * заводит строку логистики позицией `sourceType = LOGISTICS`
   * (`order-cost-estimates.service.ts`). Список нужен для двух случаев,
   * когда сметной позиции ещё нет:
   *
   *   1. у заказа вообще нет активного расчёта (DRAFT / CALCULATION) —
   *      сводка живёт по текущим данным, а не по документу;
   *   2. смета есть, но автопересчёт не прошёл (нет курса USD, неполные
   *      строки потребности) — тогда `Order.costEstimateStaleReason`
   *      уже висит плашкой, и прятать строку сверх этого нельзя.
   *
   * Дедуп со сметой — по `sourceType`/`sourceId`, чтобы одна и та же
   * логистика не легла в итог дважды.
   */
  logisticsLines?: OrderLogisticsLineDto[];
  /** Тираж заказа — для расчёта `unitCostRub` каждой строки. */
  qtyTotal: number;
  /**
   * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
   * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
   * `OrderDetailDto.materialsAndHardwareCostPolicy`).
   *
   * `EXCLUDE` обнуляет финансовый вклад строк MATERIAL / HARDWARE
   * (план/факт/дельта = 0/null, в UI «не учитывается»). Количество
   * план/факт остаётся — клиенту всё ещё нужно сообщить, сколько
   * материалов и фурнитуры требуется. Default `INCLUDE` — старая
   * семантика, материалы и фурнитура учитываются как раньше.
   */
  materialsAndHardwareCostPolicy?: OrderMaterialsAndHardwareCostPolicy;
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
    logisticsLines = [],
    qtyTotal,
    materialsAndHardwareCostPolicy = 'INCLUDE',
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
    // Упрощённый MVP давальческого сырья: если политика заказа
    // `EXCLUDE`, и строка относится к MATERIAL / HARDWARE — финансовый
    // вклад обнуляем (план = `null`, RUB = `null`, display = «не
    // учитывается»). Количество и единица измерения сохраняются —
    // менеджер всё равно видит, сколько надо.
    if (
      isFinanciallyExcludedRow(summaryRow, materialsAndHardwareCostPolicy)
    ) {
      summaryRow.totalRub = null;
      summaryRow.totalDisplay = ORDER_MATERIALS_AND_HARDWARE_EXCLUDED_LABEL;
      summaryRow.unitCostRub = null;
      const note =
        'Не учитывается в себестоимости — давальческое сырьё / фурнитура клиента';
      if (!summaryRow.warnings.includes(note)) {
        summaryRow.warnings = [...summaryRow.warnings, note];
      }
    }
    buckets[summaryRow.section].push(summaryRow);
  }
  for (const r of operationRows) {
    const summaryRow = buildOperationRow(r);
    buckets.OPERATION.push(summaryRow);
  }

  // Строки зафиксированной сметы без `workshopNeedId` — это позиции,
  // у которых нет потребности цеха, поэтому через material/operation
  // rows они в сводку не попадают: «Разработка лекала»
  // (`sourceType = PATTERN_DEVELOPMENT`) и прочие / непредвиденные
  // расходы (`sourceType = EXTRA_COST`, `OrderExtraCost` с галкой «в
  // себестоимость»). Берём именно из `currentCostEstimate`, чтобы
  // «Сводно по заказу» совпадало с зафиксированным
  // `OrderCostEstimate.totalCostRub` (а не с текущим значением поля
  // заказа, которое могли поменять после расчёта).
  //
  // Признак — отсутствие `workshopNeedId`, а не перечисление типов:
  // раньше здесь стояло `sourceType !== 'PATTERN_DEVELOPMENT'`, и
  // прочие расходы молча выпадали, занижая себестоимость и завышая
  // маржу ровно на свою сумму.
  for (const line of currentCostEstimate?.lines ?? []) {
    if (line.workshopNeedId) continue;
    const totalRub = toFiniteNumber(line.lineTotalRub);
    const qty = toFiniteNumber(line.purchaseQty);
    const price = toFiniteNumber(line.quotedPrice);
    buckets.OTHER.push({
      id: line.id,
      // В union `sourceKind` нет отдельного значения под смету; для
      // строки с заданным `totalRub` оно влияет только на ветку
      // «нет суммы» в `computeOrderSummaryTotals` (которая тут не
      // сработает). 'material' — нейтральный выбор.
      sourceKind: 'material',
      section: 'OTHER',
      sectionLabel: ORDER_SUMMARY_SECTION_LABELS.OTHER,
      article: line.description,
      qty,
      qtyDisplay: qty == null ? '—' : String(qty),
      unit: line.unit,
      priceDisplay: fmtRub(price),
      priceCurrency: 'RUB',
      totalRub,
      totalDisplay: fmtRub(totalRub),
      unitCostRub: null,
      comment: null,
      warnings: [],
      // Строки сметы без workshopNeedId (лекало / прочие расходы) —
      // order-level, к расцветке не относятся.
      orderVariantId: null,
      variantColor: null,
    });
  }

  // Ручные строки логистики, которых в зафиксированной смете ещё нет:
  // заказ без активного расчёта либо неудавшийся автопересчёт. Молча
  // прятать их нельзя — в таблице «Операции» строка уже видна со своей
  // стоимостью, и «Сводно» обязано показывать те же деньги.
  const estimatedLogisticsIds = new Set(
    (currentCostEstimate?.lines ?? [])
      .filter(
        (l) => l.sourceType === ORDER_LOGISTICS_SOURCE_TYPE && l.sourceId,
      )
      .map((l) => l.sourceId as string),
  );
  for (const line of logisticsLines) {
    if (estimatedLogisticsIds.has(line.id)) continue;
    const totalRub = toFiniteNumber(line.costRub);
    // Нулевая строка («доставка 0 ₽» как напоминание) в смету не идёт —
    // не заводим её и здесь, иначе списки разойдутся.
    if (totalRub == null || totalRub <= 0) continue;
    buckets.OTHER.push({
      id: `logistics:${line.id}`,
      // См. комментарий выше про строки сметы: 'material' здесь —
      // нейтральное значение, сумма у строки всегда задана.
      sourceKind: 'material',
      section: 'OTHER',
      sectionLabel: ORDER_SUMMARY_SECTION_LABELS.OTHER,
      article: line.name,
      qty: 1,
      qtyDisplay: '1',
      unit: 'усл.',
      priceDisplay: fmtRub(totalRub),
      priceCurrency: 'RUB',
      totalRub,
      totalDisplay: fmtRub(totalRub),
      unitCostRub: null,
      comment: 'Логистика',
      warnings: currentCostEstimate
        ? ['Не входит в зафиксированную себестоимость — нужен пересчёт']
        : [],
      orderVariantId: null,
      variantColor: null,
    });
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
  // EXCLUDE-строки уже имеют `totalRub === null`, поэтому условие
  // ниже их пропустит автоматически — `unitCostRub` останется null.
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
   * Отказ автопересчёта потребности / себестоимости
   * (`Order.needsStaleAt` / `Order.costEstimateStaleAt` + причины).
   *
   * Backend ставит эти отметки, когда пересчёт объективно невозможен
   * (нет курса USD, нет цены, статус не допускает). Сводка обязана их
   * показывать: иначе она рисует устаревший снимок сметы как
   * актуальный, и расхождение с реальными материалами видно только по
   * плашке во вкладке «Потребности» — куда менеджер может не зайти.
   */
  needsStaleReason?: string | null;
  costEstimateStaleReason?: string | null;
  /**
   * Снимок плановой стоимости операций (`Order.operationCostPlanRub`).
   *
   * Источник истины по деньгам за работу — он, а не сумма строк:
   * строка операции остаётся без суммы, если операция окладная, без
   * ставки или с расценкой по размерам без совпадения, и итог по
   * секции молча занижался. Вкладка «Операции» давно считает по
   * снимку — сводка теперь тоже.
   */
  operationCostPlanRub?: string | number | null;
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
  /**
   * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
   * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
   * `OrderDetailDto.materialsAndHardwareCostPolicy`).
   *
   * `EXCLUDE` обнуляет финансовый план и факт по материалам и
   * фурнитуре: `byKind.material` / `byKind.hardware` =
   * `0`/`null`-aware ноль, `materialActualCostRub = 0`,
   * `materialDeltaCostRub = null`. В warnings добавляется
   * «Материалы и фурнитура не учитываются в себестоимости».
   * Default `INCLUDE` — старая логика без изменений.
   */
  materialsAndHardwareCostPolicy?: OrderMaterialsAndHardwareCostPolicy;
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
    materialsAndHardwareCostPolicy = 'INCLUDE',
    needsStaleReason,
    costEstimateStaleReason,
    operationCostPlanRub,
  } = input;
  const isMaterialsAndHardwareExcluded =
    materialsAndHardwareCostPolicy === 'EXCLUDE';

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
  let hasOperationPlanMismatch = false;

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

  // Секция «Операции» считается по снимку заказа, а не по сумме строк:
  // строка без суммы (окладная / без ставки / расценка по размерам без
  // совпадения) молча занижала итог. Расхождение не прячем — если
  // снимок и строки не сходятся, поднимаем warning: значит план
  // операций разошёлся с тем, что показано построчно.
  const operationPlanSnapshotRub = toFiniteNumber(operationCostPlanRub);
  if (operationPlanSnapshotRub != null) {
    const rowsOperationRub = byKind.operation;
    if (
      rowsOperationRub != null &&
      Math.abs(rowsOperationRub - operationPlanSnapshotRub) >= 0.01
    ) {
      hasOperationPlanMismatch = true;
    }
    costTotalRub =
      (costTotalRub ?? 0) - (byKind.operation ?? 0) + operationPlanSnapshotRub;
    byKind.operation = operationPlanSnapshotRub;
  }

  const costPerUnitRub =
    costTotalRub != null && qtyTotal > 0
      ? costTotalRub / qtyTotal
      : null;

  // Фактическая стоимость материалов: Σ MaterialIssue.netTotalCost по
  // POSTED-документам — то есть `totalCost − returnedTotalCost`. Это
  // нетто-факт по заказу: возвраты `MaterialIssueReturn` (POSTED)
  // вычитают свою часть из исходного `MaterialIssue.totalCost`,
  // потому что физически материал вернулся на склад. Источник
  // истины — `MaterialIssueListItemDto.netTotalCost` (backend уже
  // считает его в `MaterialIssuesService.toListItem`); fallback на
  // `totalCost` для совместимости со старыми клиентами/тестами,
  // которые ещё не отдают `netTotalCost`. DRAFT / CANCELLED
  // игнорируем (как и раньше).
  let materialActualCostRub: number | null = null;
  if (materialIssues !== undefined) {
    let actualSum = 0;
    for (const issue of materialIssues) {
      if ((issue.status as MaterialIssueStatus) !== 'POSTED') continue;
      const netRaw = (issue as { netTotalCost?: string | null }).netTotalCost;
      const candidate = netRaw !== undefined && netRaw !== null
        ? Number(netRaw)
        : Number(issue.totalCost);
      if (Number.isFinite(candidate)) actualSum += candidate;
    }
    materialActualCostRub = actualSum;
  }
  // Упрощённый MVP давальческого сырья / фурнитуры клиента: при
  // `EXCLUDE` финансовая сводка по материалам обнуляется. План
  // (`byKind.material` / `byKind.hardware`) уже занулён выше, потому
  // что строки вошли с `totalRub === null`. Факт `materialActualCostRub`
  // и дельту здесь принудительно сводим к 0 / null:
  //   - факт = `0` (документы расхода в БД не меняются — это только
  //     UI-агрегация);
  //   - дельта = `null` (план неизвестен → разница не имеет смысла).
  if (isMaterialsAndHardwareExcluded) {
    materialActualCostRub = 0;
  }
  // Δ = факт - план. Если план неизвестен — отклонение тоже
  // неизвестно, иначе UI показал бы фейковый «перерасход» на всю
  // фактическую сумму.
  //
  // База плана — МАТЕРИАЛЫ + ФУРНИТУРА, а не одни материалы. Факт
  // (`materialActualCostRub`) считается по документам расхода, а
  // автосписание кроя берёт строки потребности ЛЮБЫХ ролей, кроме
  // нанесения (`createAutoCutIssueForPassport`): туда попадают и нитки,
  // и пуговицы, и этикетки, и упаковка. Сравнение такого факта с планом
  // одной только секции MATERIAL давало систематический ложный
  // перерасход ровно на стоимость фурнитуры.
  const plannedMaterialCostRub =
    byKind.material == null && byKind.hardware == null
      ? null
      : (byKind.material ?? 0) + (byKind.hardware ?? 0);
  const materialDeltaCostRub = isMaterialsAndHardwareExcluded
    ? null
    : materialActualCostRub != null && plannedMaterialCostRub != null
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
  // Упрощённый MVP давальческого сырья / фурнитуры клиента: бейдж в
  // самом верху списка, чтобы менеджер сразу видел, почему план/факт
  // по материалам и фурнитуре в финансовой сводке = 0/—.
  if (isMaterialsAndHardwareExcluded) {
    warnings.push('Материалы и фурнитура не учитываются в себестоимости');
  }
  if (qtyTotal <= 0) {
    warnings.push('Не заполнен тираж');
  }
  if (hasUsdMissingRate && !isMaterialsAndHardwareExcluded) {
    warnings.push('Есть строки в USD без курса — сумма в рублях не считается');
  }
  if (hasMissingPrice && !isMaterialsAndHardwareExcluded) {
    warnings.push('Есть материалы без цены');
  }
  if (hasOperationFallback) {
    warnings.push(
      'Есть операции без точной ставки (окладная / план не зафиксирован)',
    );
  }
  if (hasOperationPlanMismatch) {
    warnings.push(
      'Итог по операциям взят из плана заказа и не сходится с суммой строк',
    );
  }
  if (operationPlanIsStale === true) {
    warnings.push('План операций требует пересчёта');
  }
  // Отказы автопересчёта — первыми по важности: пока они висят, все
  // числа ниже относятся к прежним материалам.
  if (needsStaleReason) {
    warnings.push(`Потребность устарела: ${needsStaleReason}`);
  }
  if (costEstimateStaleReason) {
    warnings.push(`Себестоимость устарела: ${costEstimateStaleReason}`);
  }
  if (customerUnitPriceNum == null) {
    warnings.push('Не указана цена продажи');
  } else if (customerCurrencyResolved === 'USD') {
    warnings.push('Маржа не рассчитана: цена продажи в USD без курса');
  }
  // Если материалы и фурнитура исключены политикой — статус «расчёт
  // себестоимости не завершён» теряет смысл (в неё материалов и так
  // не должно быть).
  if (
    !hasCompletedEstimate &&
    !isMaterialsAndHardwareExcluded &&
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

// ---------------------------------------------------------------------------
// Colorway grouping
// ---------------------------------------------------------------------------

/**
 * Группа «расцветка» для вкладки «Сводно по заказу»: материальные
 * строки одной расцветки + её материальная себестоимость.
 *
 * Семантика подытога — сознательно ТОЛЬКО материальная часть
 * (материалы + фурнитура + любые строки, привязанные к расцветке):
 * операции и order-level строки (нанесение / прочее) в подытог
 * расцветки НЕ входят, они видны в общем итоге под таблицей
 * (`computeOrderSummaryTotals` не меняется). Решение владельца от
 * 07.08: «пока только материальная часть».
 */
export interface OrderSummaryColorwayGroup {
  /** `OrderVariant.id` расцветки (ключ группировки). */
  orderVariantId: string;
  /** Лейбл группы: живой цвет расцветки, иначе snapshot
   *  `WorkshopNeed.variantColor`, иначе «Расцветка». */
  colorLabel: string;
  /** Тираж расцветки — Σ `qtyPlan` живого поразмерного плана.
   *  `null`, если расцветка удалена / API расцветок недоступен. */
  qty: number | null;
  /**
   * Строки группы (те же `OrderSummaryRow`, что и в плоской таблице).
   * `unitCostRub` здесь пересчитан на тираж РАСЦВЕТКИ: материал
   * чёрной ткани расходуется только на чёрные изделия, поэтому
   * деление на весь тираж заказа внутри блока расцветки врало бы.
   * При неизвестном тираже расцветки `unitCostRub = null` («—»).
   */
  rows: OrderSummaryRow[];
  /** Материальная часть расцветки: Σ `totalRub` строк группы.
   *  `null`, если ни у одной строки нет RUB-суммы. */
  materialTotalRub: number | null;
  /** `materialTotalRub / qty`. `null`, если что-то из двух неизвестно. */
  materialPerUnitRub: number | null;
  /** Предупреждения группы (USD без курса / нет цены / не учитывается). */
  warnings: string[];
}

/** Результат разбиения строк сводки по расцветкам. */
export interface OrderSummaryColorwayGrouping {
  /**
   * Блоки расцветок в порядке `ordinal` живых расцветок; группы по
   * удалённым расцветкам — после живых, по алфавиту лейбла. Пустой
   * массив — в заказе нет строк с расцветкой, UI рендерит плоскую
   * таблицу как раньше.
   */
  colorwayGroups: OrderSummaryColorwayGroup[];
  /** Строки без расцветки, кроме операций: нанесение / ручные
   *  строки / прочее / строки сметы. `unitCostRub` не пересчитывается
   *  (делится на весь тираж — эти затраты общие). */
  commonRows: OrderSummaryRow[];
  /** Σ `totalRub` общих строк — для заголовка блока «Общее по заказу». */
  commonTotalRub: number | null;
  /** Предупреждения общих строк (USD без курса / нет цены). */
  commonWarnings: string[];
  /** Операции — единой секцией, к расцветкам не относятся. */
  operationRows: OrderSummaryRow[];
}

interface GroupByColorwayInput {
  rows: OrderSummaryRow[];
  /** Живые расцветки заказа (`GET /orders/:id/colorways`) — источник
   *  лейбла, порядка и тиража группы. `null` — API недоступен /
   *  фича выключена: группы соберутся по snapshot-цветам без тиража. */
  colorways: OrderColorwaysDto | null;
}

/**
 * Собирает предупреждения по строкам одной группы. Мы не дублируем
 * построчные warnings — только причины, из-за которых подытог группы
 * меньше суммы «на глаз» (строка не вошла в Σ).
 */
function collectGroupWarnings(rows: OrderSummaryRow[]): string[] {
  let usdCount = 0;
  let noPriceCount = 0;
  let excludedCount = 0;
  for (const r of rows) {
    if (r.totalRub != null) continue;
    if (r.totalDisplay === ORDER_MATERIALS_AND_HARDWARE_EXCLUDED_LABEL) {
      excludedCount += 1;
    } else if (
      r.priceCurrency === 'USD' ||
      r.warnings.some((w) => w.includes('USD без курса'))
    ) {
      usdCount += 1;
    } else {
      noPriceCount += 1;
    }
  }
  const warnings: string[] = [];
  if (usdCount > 0) {
    warnings.push(
      `USD без курса: ${usdCount} стр. не входит в сумму расцветки`,
    );
  }
  if (noPriceCount > 0) {
    warnings.push(`Без цены: ${noPriceCount} стр.`);
  }
  if (excludedCount > 0) {
    warnings.push('Материалы клиента — не учитываются в себестоимости');
  }
  return warnings;
}

/** Σ totalRub строк; `null`, если ни у одной строки нет RUB-суммы. */
function sumRowsTotalRub(rows: OrderSummaryRow[]): number | null {
  let sum: number | null = null;
  for (const r of rows) {
    if (r.totalRub != null) sum = (sum ?? 0) + r.totalRub;
  }
  return sum;
}

/**
 * Разбивает строки сводки на блоки по расцветкам (вариант «только
 * материальная часть»). Pure-функция: работает поверх готовых
 * `OrderSummaryRow[]`, общий итог (`computeOrderSummaryTotals`)
 * считается ДО группировки и группировкой не меняется — блоки лишь
 * перераскладывают те же строки.
 */
export function groupOrderSummaryRowsByColorway(
  input: GroupByColorwayInput,
): OrderSummaryColorwayGrouping {
  const { rows, colorways } = input;

  const operationRows: OrderSummaryRow[] = [];
  const commonRows: OrderSummaryRow[] = [];
  const byVariant = new Map<string, OrderSummaryRow[]>();

  for (const r of rows) {
    if (r.section === 'OPERATION') {
      operationRows.push(r);
    } else if (r.orderVariantId) {
      const bucket = byVariant.get(r.orderVariantId) ?? [];
      bucket.push(r);
      byVariant.set(r.orderVariantId, bucket);
    } else {
      commonRows.push(r);
    }
  }

  // Живые расцветки: лейбл + порядок + тираж (Σ qtyPlan размеров).
  const liveById = new Map<
    string,
    { color: string; ordinal: number; qty: number }
  >();
  for (const v of colorways?.variants ?? []) {
    let qty = 0;
    for (const s of v.sizes) qty += s.qtyPlan;
    liveById.set(v.id, { color: v.color, ordinal: v.ordinal, qty });
  }

  const colorwayGroups: OrderSummaryColorwayGroup[] = [];
  for (const [variantId, groupRows] of byVariant) {
    const live = liveById.get(variantId) ?? null;
    const snapshotColor =
      groupRows.find((r) => r.variantColor)?.variantColor ?? null;
    const colorLabel = live?.color ?? snapshotColor ?? 'Расцветка';
    const qty = live ? live.qty : null;

    const materialTotalRub = sumRowsTotalRub(groupRows);
    const materialPerUnitRub =
      materialTotalRub != null && qty != null && qty > 0
        ? materialTotalRub / qty
        : null;

    // «За 1 изделие» внутри блока — на тираж расцветки, не заказа.
    const rowsPerVariantUnit = groupRows.map((r) => ({
      ...r,
      unitCostRub:
        r.totalRub != null && qty != null && qty > 0
          ? r.totalRub / qty
          : null,
    }));

    colorwayGroups.push({
      orderVariantId: variantId,
      colorLabel,
      qty,
      rows: rowsPerVariantUnit,
      materialTotalRub,
      materialPerUnitRub,
      warnings: collectGroupWarnings(groupRows),
    });
  }

  colorwayGroups.sort((a, b) => {
    const aOrd = liveById.get(a.orderVariantId)?.ordinal ?? Infinity;
    const bOrd = liveById.get(b.orderVariantId)?.ordinal ?? Infinity;
    if (aOrd !== bOrd) return aOrd - bOrd;
    return a.colorLabel.localeCompare(b.colorLabel, 'ru');
  });

  return {
    colorwayGroups,
    commonRows,
    commonTotalRub: sumRowsTotalRub(commonRows),
    commonWarnings: collectGroupWarnings(commonRows),
    operationRows,
  };
}
