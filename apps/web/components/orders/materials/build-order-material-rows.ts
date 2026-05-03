/**
 * `buildOrderMaterialRows` — собирает плоский список строк
 * `OrderMaterialTableRow` для unified-таблицы материалов в карточке
 * заказа `/admin/orders/[id]` (вкладка «Материалы»).
 *
 * Это **чисто web-side агрегатор**: backend / Prisma / WorkshopNeed
 * formulas / OrderCostEstimate logic / CutReadinessService / payroll
 * НЕ меняются. Помощник переиспользует уже существующие DTO:
 *
 *   - `WorkshopNeedListItemDto` (`@/lib/workshop-needs-api`) — основа
 *     каждой строки;
 *   - `CutReadinessDto.sections.materials` (`@/lib/cut-readiness-api`)
 *     — `placedQty`, `manuallyUnblocked`, `manualArrivalOverrides`,
 *     рассчитанный backend-ом `receivedQty`;
 *   - `PurchaseOrderListItemDto` (`@/lib/purchase-orders-api`) —
 *     активные PO для лейбла «Заказан» и `expectedDeliveryDate`
 *     поставщика;
 *   - `PurchaseReceiptListItemDto` + опциональный `PurchaseReceiptDetailDto[]`
 *     для нахождения фактической даты приёмки по `workshopNeedId`.
 *
 * Никакой бизнес-логики «можно ли запустить крой / сколько
 * списать / какая сумма расчёта» здесь нет — мы только склеиваем
 * данные для плоского вью «что нужно купить / сколько / у кого /
 * когда / готово ли к крою».
 */
import {
  type CutMaterialReadinessDto,
  type CutReadinessDto,
} from '@sewing/shared/cut-readiness';
import {
  type MaterialIssueDetailDto,
  type MaterialIssueLineDto,
} from '@sewing/shared/material-issues';
import {
  type PurchaseOrderListItemDto,
} from '@sewing/shared/purchase-orders';
import {
  type PurchaseReceiptDetailDto,
  type PurchaseReceiptListItemDto,
} from '@sewing/shared/purchase-receipts';
import {
  type WorkshopNeedListItemDto,
} from '@sewing/shared/workshop-needs';

/** Тон UI-статуса строки таблицы материалов. */
export type OrderMaterialStatusTone =
  | 'neutral'
  | 'warning'
  | 'success'
  | 'danger'
  | 'info';

/**
 * Денормализованная строка таблицы «Материалы» в карточке заказа.
 *
 * Все Decimal значения уже преобразованы в строки для отображения
 * в `<td>` без дополнительного форматирования (`'77'`, `'80.5'`,
 * `'0'`).
 */
export interface OrderMaterialTableRow {
  /** `WorkshopNeed.id` — уникальный ключ строки. */
  id: string;

  // ----- Колонки 1–2: «Роль» / «Описание» --------------------------------
  /** Лейбл роли (например, «Основной материал», «Фурнитура»). */
  roleLabel: string;
  /** Сырое значение `materialRole` для тестов и data-attribute. */
  materialRoleRaw: string | null;
  /** Основное описание (например, «Дюспо», «Молния»). */
  description: string;
  /** Доп. строка под описанием (размер · материал · цвет · …). */
  metaText: string | null;
  /** Маленькое preview (URL картинки) или `null`. */
  imageUrl: string | null;
  /** Нужно ли подсветить «цвет нужно указать в заказе». */
  requiresColorSelection: boolean;
  /** Решённый цвет, если выбран. */
  colorText: string | null;

  // ----- Колонки 3–4: количества -----------------------------------------
  /** Системно рассчитанное (Чистая) — строка как есть из DTO. */
  calculatedQty: string;
  /** К закупке — `null`, если закупщик ещё не заполнил. */
  purchaseQty: string | null;
  unit: string;

  // ----- Колонки 5–6: цена и сумма ---------------------------------------
  quotedPrice: string | null;
  quotedCurrency: 'RUB' | 'USD' | string | null;
  /**
   * `qtyForTotal × quotedPrice` в исходной валюте. `null`, если цены
   * нет — мы не показываем фейковые `0₽`, потому что закупщик ещё
   * не дал оценку.
   */
  lineTotalRub: string | null;
  /** USD-сумма, если строка в USD. */
  lineTotalUsd: string | null;

  // ----- Колонки 7–8: фактическое движение -------------------------------
  /** Σ POSTED `PurchaseReceiptLine.receivedQty`. `'0'` если ничего. */
  receivedQty: string;
  /** Размещено в ячейках (через CutReadiness). `'0'` если ничего. */
  placedQty: string;

  // ----- Колонки 9–10: статус и дата -------------------------------------
  statusLabel: string;
  statusTone: OrderMaterialStatusTone;
  /**
   * Дополнительный бейдж под основным статусом (например,
   * «Разблокировано вручную»). Не дублирует `statusLabel`.
   */
  secondaryBadge: { label: string; tone: OrderMaterialStatusTone } | null;

  /** ISO дата поступления (фактическая) или ожидаемая. */
  expectedOrReceivedDate: string | null;
  /** `'received' | 'expected'` — UI может прибавить muted hint. */
  dateSource: 'received' | 'expected' | null;

  // ----- Колонки 11–12: поставщик и комментарий --------------------------
  supplierName: string | null;
  /** Доп. строка под поставщиком (название позиции каталога). */
  supplierItemText: string | null;

  /**
   * Комментарий + warning-список (склеенный из
   * `WorkshopNeed.comment` / `WorkshopNeed.calculationNote` / явных
   * предупреждений). `commentText` — это первая строка для
   * `<td>`, `warnings` — список для `title`/`details` или иконок.
   */
  commentText: string | null;
  warnings: string[];

  // ----- Колонки 13–14: план / факт расхода материалов -------------------
  /**
   * Плановое количество расхода материала в производство.
   * `WorkshopNeed.calculatedQty` — производственная потребность
   * (а не закупочная `purchaseQty`, см. ТЗ §4 frontend-итерации
   * «план/факт»). Decimal-as-string.
   */
  plannedQty: string;
  /**
   * Плановая стоимость расхода = `calculatedQty * quotedPrice`,
   * только для RUB-цены. `null`, если цена не указана либо в USD.
   * Сознательно не дублируем USD-сумму: `lineTotalUsd` уже
   * показывается отдельно колонкой «Сумма».
   */
  plannedCost: string | null;
  /**
   * Σ `MaterialIssueLine.issuedQty` по POSTED-документам с
   * `workshopNeedId === row.id`. Учитываем только строки с тем же
   * `unit`, что у потребности — конвертация единиц в MVP не
   * делается. `'0'`, если факта нет.
   */
  issuedQtyFact: string;
  /**
   * Σ `MaterialIssueLine.totalCost` по POSTED-документам с
   * `workshopNeedId === row.id`. Считаем независимо от unit,
   * потому что `totalCost` — это уже деньги. `'0'`, если факта
   * нет.
   */
  actualCost: string;
  /**
   * `issuedQtyFact - plannedQty` (Decimal-as-string). Может быть
   * отрицательной — это «факт меньше плана», UI отдельно
   * подкрашивает экономию vs перерасход.
   */
  deltaQty: string;
  /**
   * `actualCost - plannedCost` (Decimal-as-string). `null`, если
   * `plannedCost` отсутствует (USD без курса / нет цены) — иначе
   * был бы фейковый «перерасход» на всю фактическую сумму.
   */
  deltaCost: string | null;
  /**
   * `true`, если есть POSTED `MaterialIssueLine` с этим
   * `workshopNeedId`, у которой `unit !== WorkshopNeed.unit`. UI
   * показывает короткое предупреждение и НЕ суммирует разные
   * единицы — конвертация в MVP не делается (см. ТЗ §3 «фактический
   * расход / unit mismatch»).
   */
  unitMismatch: boolean;
  /** Кол-во POSTED-строк с `workshopNeedId === row.id` (для UI/debug). */
  postedIssueLineCount: number;

  /** Ссылка на исходный DTO — на случай inline-edit / debug. */
  originalNeed: WorkshopNeedListItemDto;
}

// ---------------------------------------------------------------------------
// Role labels (узкий словарь, не зависящий от backend enum)
// ---------------------------------------------------------------------------

/**
 * Лейблы ролей материала для unified-таблицы. ТЗ §6 требует свои
 * варианты лейблов («Основной материал» вместо «Основное полотно»,
 * «Фурнитура» для PACKAGING и т.п.). Существующий
 * `MATERIAL_ROLE_LABELS` в `@sewing/shared/material-roles`
 * по-другому называет PACKAGING («Упаковка»), и в нём нет ролей
 * `FILLER` / `INTERLINING` / `MARKING` / `ADDITIONAL_FABRIC` —
 * они хранятся как свободные строки в БД. Поэтому держим свой
 * UI-словарь, без Prisma-миграции.
 */
const ORDER_MATERIAL_ROW_ROLE_LABELS: Record<string, string> = {
  MAIN_FABRIC: 'Основной материал',
  ADDITIONAL_FABRIC: 'Дополнительное полотно',
  RIB: 'Рибана / кашкорсе',
  LINING: 'Подкладка',
  FILLER: 'Наполнитель',
  INTERLINING: 'Дублерин / клеевые',
  THREAD: 'Нитки',
  PACKAGING: 'Фурнитура',
  MARKING: 'Маркировка',
  ORDER_APPLICATION: 'Нанесение',
  APPLICATION: 'Нанесение',
};

export function getOrderMaterialRoleLabel(
  role: string | null | undefined,
): string {
  if (!role) return 'Прочее';
  return ORDER_MATERIAL_ROW_ROLE_LABELS[role] ?? 'Прочее';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function decToString(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  // Decimal-as-string: убираем хвостовые нули после точки.
  const s = String(n);
  return s;
}

function pickReceivedAtForNeed(
  workshopNeedId: string,
  receipts: PurchaseReceiptListItemDto[],
  receiptDetails: Map<string, PurchaseReceiptDetailDto>,
): string | null {
  let latest: string | null = null;
  for (const pr of receipts) {
    if (pr.status !== 'POSTED') continue;
    const detail = receiptDetails.get(pr.id);
    if (!detail) continue;
    const matches = detail.lines.some(
      (l) => l.workshopNeedId === workshopNeedId && l.status === 'POSTED',
    );
    if (!matches) continue;
    if (latest === null || new Date(pr.receivedAt) > new Date(latest)) {
      latest = pr.receivedAt;
    }
  }
  return latest;
}

function pickActivePurchaseOrderForNeed(
  workshopNeedId: string,
  purchaseOrders: PurchaseOrderListItemDto[],
): PurchaseOrderListItemDto | null {
  // Активный PO определяется по статусу головы документа: пока
  // PO не CANCELLED, считаем его «занимающим» соответствующую
  // потребность. На MVP мы видим список PO без строк — проверка
  // «строка PO именно по этой WorkshopNeed» делается в карточке
  // самого PO. Здесь нам достаточно «есть/нет активного PO у
  // заказа». Для надёжной фильтрации по WorkshopNeed нужен detail
  // по каждому PO; в этой версии мы не делаем N+1 fetch — берём
  // первый активный PO.
  for (const po of purchaseOrders) {
    if (po.status !== 'CANCELLED' && po.status !== 'DRAFT') {
      return po;
    }
  }
  // Если нет SENT/CONFIRMED/…, попробуем DRAFT — это тоже уже
  // «занятая» потребность.
  for (const po of purchaseOrders) {
    if (po.status === 'DRAFT') return po;
  }
  return null;
}

function findCutReadinessRow(
  workshopNeedId: string,
  cutReadiness: CutReadinessDto | null,
): CutMaterialReadinessDto | null {
  if (!cutReadiness) return null;
  return (
    cutReadiness.sections.materials.find(
      (m) => m.workshopNeedId === workshopNeedId,
    ) ?? null
  );
}

interface BuildRowsInput {
  workshopNeeds: WorkshopNeedListItemDto[];
  cutReadiness: CutReadinessDto | null;
  purchaseOrders: PurchaseOrderListItemDto[];
  purchaseReceipts: PurchaseReceiptListItemDto[];
  /**
   * Map по `PurchaseReceipt.id` → детальная карточка приёмки. Нужно,
   * чтобы найти фактический `receivedAt` для конкретной
   * `WorkshopNeed.id`. Если detail не загружен — не страшно: дата
   * деградирует на ожидаемую (`expectedDeliveryDate` потребности).
   */
  purchaseReceiptDetails: Map<string, PurchaseReceiptDetailDto>;
  /**
   * Документы фактического расхода материалов по заказу
   * (`MaterialIssue` + `MaterialIssueLine`). Для агрегации
   * план/факт нам нужны именно `Detail`-варианты — у `ListItemDto`
   * нет `lines`. Frontend-итерация: данные грузит
   * `OrderNeedsTab` один раз и пробрасывает и сюда, и в
   * `MaterialIssuesSection` (без повторного fetch).
   *
   * Мы фильтруем POSTED внутри агрегатора, а не на входе, чтобы
   * UI мог при желании показывать DRAFT/CANCELLED-сумму отдельно
   * без второго fetch (текущая итерация этого не делает).
   *
   * Если `undefined` или пусто — таблица работает как раньше:
   * `issuedQtyFact = 0`, `actualCost = 0`, `unitMismatch = false`.
   */
  materialIssues?: MaterialIssueDetailDto[];
}

interface MaterialIssueAggregateForNeed {
  issuedQtyFact: string;
  actualCost: string;
  unitMismatch: boolean;
  postedLineCount: number;
}

/**
 * Агрегат факта расхода для одной `WorkshopNeed.id` по всем
 * POSTED `MaterialIssueLine` с этим `workshopNeedId`.
 *
 * Правила (см. ТЗ §3 frontend-итерации «план/факт»):
 *   - учитываем только `issue.status === 'POSTED'`;
 *   - DRAFT и CANCELLED игнорируем;
 *   - строки с `workshopNeedId === null` сюда не попадают
 *     (caller их фильтрует);
 *   - `issuedQty` суммируем только если `line.unit === need.unit`
 *     (конвертация единиц в MVP не делается). При несовпадении
 *     поднимаем `unitMismatch = true` и **не** добавляем число;
 *   - `totalCost` суммируем независимо от unit — это уже деньги.
 *
 * Decimal-аккумуляторы — `number`. Это допустимо для UI-агрегата
 * (мы не закрываем себестоимость), и совпадает со стилем
 * `summariseOrderMaterialRows`.
 */
function buildIssueAggregatesByNeed(
  materialIssues: readonly MaterialIssueDetailDto[],
  workshopNeedById: ReadonlyMap<string, WorkshopNeedListItemDto>,
): Map<string, MaterialIssueAggregateForNeed> {
  const acc = new Map<
    string,
    {
      issuedQty: number;
      actualCost: number;
      unitMismatch: boolean;
      postedLineCount: number;
    }
  >();

  for (const issue of materialIssues) {
    if (issue.status !== 'POSTED') continue;
    for (const line of issue.lines as readonly MaterialIssueLineDto[]) {
      const needId = line.workshopNeedId;
      if (!needId) continue;
      // Если `workshopNeedId` указывает на удалённую/неизвестную
      // потребность — не агрегируем (см. ТЗ §7 «Состояние данных»),
      // иначе строки таблицы «привесят» лишний факт ни к чему.
      const need = workshopNeedById.get(needId);
      if (!need) continue;

      const bucket = acc.get(needId) ?? {
        issuedQty: 0,
        actualCost: 0,
        unitMismatch: false,
        postedLineCount: 0,
      };

      const lineUnit = String(line.unit ?? '').trim();
      const needUnit = String(need.unit ?? '').trim();
      if (lineUnit && needUnit && lineUnit !== needUnit) {
        bucket.unitMismatch = true;
      } else {
        const qty = toFiniteNumber(line.issuedQty);
        if (qty != null) bucket.issuedQty += qty;
      }

      const cost = toFiniteNumber(line.totalCost);
      if (cost != null) bucket.actualCost += cost;
      bucket.postedLineCount += 1;

      acc.set(needId, bucket);
    }
  }

  const out = new Map<string, MaterialIssueAggregateForNeed>();
  for (const [needId, bucket] of acc) {
    out.set(needId, {
      issuedQtyFact: String(bucket.issuedQty),
      actualCost: String(bucket.actualCost),
      unitMismatch: bucket.unitMismatch,
      postedLineCount: bucket.postedLineCount,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status resolver
// ---------------------------------------------------------------------------

interface StatusResolution {
  label: string;
  tone: OrderMaterialStatusTone;
  /** Опциональный extra-бейдж (например, «Разблокировано вручную»). */
  secondary: { label: string; tone: OrderMaterialStatusTone } | null;
  warnings: string[];
}

const NEED_STATUS_LABELS: Record<string, string> = {
  CALCULATED: 'Рассчитано',
  REVIEWED: 'Проверено',
  PURCHASE_PLANNED: 'К закупке',
  ORDERED: 'Заказан',
  PARTIALLY_RECEIVED: 'Частично принято',
  RECEIVED: 'Принято',
  CANCELLED: 'Отменено',
};

const NEED_STATUS_TONES: Record<string, OrderMaterialStatusTone> = {
  CALCULATED: 'neutral',
  REVIEWED: 'info',
  PURCHASE_PLANNED: 'info',
  ORDERED: 'info',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CANCELLED: 'danger',
};

function resolveStatus(
  need: WorkshopNeedListItemDto,
  cutRow: CutMaterialReadinessDto | null,
  activePo: PurchaseOrderListItemDto | null,
  receivedQtyNum: number,
  placedQtyNum: number,
  targetQtyNum: number,
): StatusResolution {
  const warnings: string[] = [];

  const requiresColor = need.requiresColorSelection === true;
  const hasColor = !!(need.selectedColorText ?? need.resolvedColorText);
  if (requiresColor && !hasColor) {
    warnings.push('Цвет нужно указать в заказе');
  }
  if (
    need.quotedPrice == null ||
    need.quotedPrice === '' ||
    Number(need.quotedPrice) <= 0
  ) {
    warnings.push('Цена не указана');
  }
  if (
    need.quotedPrice != null &&
    String(need.quotedCurrency ?? 'RUB').toUpperCase() === 'USD'
  ) {
    warnings.push('USD без курса — сумма в рублях не считается');
  }
  if (!need.selectedSupplierId && !need.supplierNameText) {
    warnings.push('Поставщик не выбран');
  }

  // Терминальный «Отменено» имеет наивысший приоритет.
  if (need.status === 'CANCELLED') {
    return {
      label: 'Отменено',
      tone: 'danger',
      secondary: null,
      warnings,
    };
  }

  // 1. Цвет нужно указать
  if (requiresColor && !hasColor) {
    return { label: 'Нужен цвет', tone: 'warning', secondary: null, warnings };
  }

  // 2. Нет цены
  if (
    need.quotedPrice == null ||
    need.quotedPrice === '' ||
    Number(need.quotedPrice) <= 0
  ) {
    return { label: 'Нет цены', tone: 'warning', secondary: null, warnings };
  }

  // 3. Полностью принято?
  if (targetQtyNum > 0 && receivedQtyNum >= targetQtyNum) {
    const secondary =
      cutRow?.manuallyUnblocked === true
        ? {
            label: 'Разблокировано вручную',
            tone: 'warning' as OrderMaterialStatusTone,
          }
        : null;
    return {
      label: 'Принято',
      tone: 'success',
      secondary,
      warnings,
    };
  }

  // 4. Готово к крою (placedQty покрывает целевую)
  if (targetQtyNum > 0 && placedQtyNum >= targetQtyNum) {
    return {
      label: 'Готово к крою',
      tone: 'success',
      secondary: null,
      warnings,
    };
  }

  // 5. Активный PO
  if (activePo) {
    const secondary =
      cutRow?.manuallyUnblocked === true
        ? {
            label: 'Разблокировано вручную',
            tone: 'warning' as OrderMaterialStatusTone,
          }
        : null;
    if (receivedQtyNum > 0) {
      return {
        label: 'Частично принято',
        tone: 'warning',
        secondary,
        warnings,
      };
    }
    return { label: 'Заказан', tone: 'info', secondary, warnings };
  }

  // 6. Manual arrival override — если PO нет, но overrides есть
  if (cutRow?.manuallyUnblocked === true) {
    return {
      label: 'Разблокировано вручную',
      tone: 'warning',
      secondary: null,
      warnings,
    };
  }

  // 7. Падение к WorkshopNeed.status
  const statusKey = String(need.status ?? '');
  const label = NEED_STATUS_LABELS[statusKey] ?? (statusKey || '—');
  const tone = NEED_STATUS_TONES[statusKey] ?? 'neutral';
  return { label, tone, secondary: null, warnings };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

function joinMeta(parts: Array<string | null | undefined>): string | null {
  const filtered = parts
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter((p) => p.length > 0);
  if (filtered.length === 0) return null;
  return filtered.join(' · ');
}

function safeSum(a: string | number | null | undefined): number {
  const n = toFiniteNumber(a);
  return n ?? 0;
}

export function buildOrderMaterialRows(
  input: BuildRowsInput,
): OrderMaterialTableRow[] {
  const {
    workshopNeeds,
    cutReadiness,
    purchaseOrders,
    purchaseReceipts,
    purchaseReceiptDetails,
    materialIssues,
  } = input;

  // Активный (не CANCELLED) PO для всего заказа — на MVP мы
  // используем его для всех строк, по которым нет точного
  // matching через детальные строки PO. Если строк в PO нет —
  // просто пропустим маркер «Заказан» по этой потребности.
  const activePoForOrder = pickActivePurchaseOrderForNeed(
    '*',
    purchaseOrders,
  );

  // Агрегат факта расхода по `WorkshopNeed.id`. Если документов
  // нет (`materialIssues` пуст / undefined), вернём пустую мапу —
  // строки просто отрисуются с `issuedQtyFact = 0`.
  const workshopNeedById = new Map<string, WorkshopNeedListItemDto>();
  for (const need of workshopNeeds) workshopNeedById.set(need.id, need);
  const issueAggregates = buildIssueAggregatesByNeed(
    materialIssues ?? [],
    workshopNeedById,
  );

  const rows: OrderMaterialTableRow[] = [];

  for (const need of workshopNeeds) {
    const cutRow = findCutReadinessRow(need.id, cutReadiness);

    const calculatedQty = decToString(need.calculatedQty);
    const purchaseQty =
      need.purchaseQty == null || need.purchaseQty === ''
        ? null
        : decToString(need.purchaseQty);
    const unit = need.unit ?? '';

    const targetQtyNum =
      toFiniteNumber(need.purchaseQty) ?? toFiniteNumber(need.calculatedQty) ?? 0;

    // receivedQty / placedQty — из CutReadiness (backend уже считает).
    const receivedQtyNum = safeSum(cutRow?.receivedQty);
    const placedQtyNum = safeSum(cutRow?.placedQty);
    const receivedQtyStr = cutRow ? decToString(cutRow.receivedQty) : '0';
    const placedQtyStr = cutRow ? decToString(cutRow.placedQty) : '0';

    // Активный PO по этой потребности. На MVP — общий по заказу
    // (см. JSDoc `pickActivePurchaseOrderForNeed`).
    const activePo = activePoForOrder;

    const status = resolveStatus(
      need,
      cutRow,
      activePo,
      receivedQtyNum,
      placedQtyNum,
      targetQtyNum,
    );

    // Сумма строки.
    const priceNum = toFiniteNumber(need.quotedPrice);
    const qtyForTotal =
      toFiniteNumber(need.purchaseQty) ?? toFiniteNumber(need.calculatedQty);
    const isUsd = String(need.quotedCurrency ?? '').toUpperCase() === 'USD';
    let lineTotalRub: string | null = null;
    let lineTotalUsd: string | null = null;
    if (priceNum != null && qtyForTotal != null && priceNum >= 0) {
      const total = priceNum * qtyForTotal;
      if (isUsd) {
        lineTotalUsd = String(total);
      } else {
        lineTotalRub = String(total);
      }
    }

    // Дата поступления.
    const receivedAt =
      receivedQtyNum > 0
        ? pickReceivedAtForNeed(need.id, purchaseReceipts, purchaseReceiptDetails)
        : null;
    const expectedDate =
      need.expectedDeliveryDate ?? activePo?.expectedDeliveryDate ?? null;
    const expectedOrReceivedDate = receivedAt ?? expectedDate;
    const dateSource: OrderMaterialTableRow['dateSource'] = receivedAt
      ? 'received'
      : expectedDate
        ? 'expected'
        : null;

    // Описание + meta.
    const colorText = need.selectedColorText ?? need.resolvedColorText ?? null;
    const metaText = joinMeta([
      need.hardwareSizeText,
      need.hardwareMaterialText,
      colorText ? `цвет ${colorText}` : null,
      need.densityGsm ? `${need.densityGsm} г/м²` : null,
      need.plannedWidthCm ? `${need.plannedWidthCm} см` : null,
    ]);

    // Поставщик: справочник имеет приоритет над текстом.
    const supplierName =
      need.selectedSupplierName ??
      need.supplierNameText ??
      activePo?.supplierNameSnapshot ??
      null;
    const supplierItemText =
      need.selectedSupplierCatalogItemName ??
      need.purchaseItemNameText ??
      null;

    // Комментарий: WorkshopNeed.comment + calculationNote.
    //
    // Stale calculationNote (см. ТЗ §E «Stale calculationNote»):
    // backend пишет `calculationNote = "Цвет нужно указать в заказе"`
    // в момент `WorkshopNeedsService.calculateForOrder` (см.
    // `workshop-needs.service.ts`). После того как менеджер
    // сохранил цвет через PATCH .../material-requirements/.../color,
    // backend обновляет `selectedColorText`/`resolvedColorText` в
    // snapshot, но НЕ пересчитывает `WorkshopNeed.calculationNote`.
    // Чтобы свежий цвет не «перекрывался» stale-нотой, в UI
    // фильтруем именно этот текст, если цвет уже заполнен. Любой
    // другой комментарий backend-а оставляем как есть.
    const isColorWarningNote =
      typeof need.calculationNote === 'string' &&
      need.calculationNote.trim() === 'Цвет нужно указать в заказе';
    const filteredCalculationNote =
      isColorWarningNote && colorText ? null : need.calculationNote;
    const commentText =
      [need.comment, filteredCalculationNote]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join(' · ') || null;

    // План / факт по фактическому расходу материалов
    // (frontend-итерация «план/факт» поверх MaterialIssue).
    //
    // Плановое количество — производственная потребность
    // (`calculatedQty`), а не закупочная (`purchaseQty`): см. ТЗ §4.
    // Плановая стоимость — `calculatedQty * quotedPrice`, только
    // для RUB-цены; для USD цены и для пустой цены — `null`.
    const plannedCalcQtyNum = toFiniteNumber(need.calculatedQty);
    let plannedCost: string | null = null;
    if (
      priceNum != null &&
      priceNum >= 0 &&
      plannedCalcQtyNum != null &&
      !isUsd
    ) {
      plannedCost = String(priceNum * plannedCalcQtyNum);
    }

    const aggregate = issueAggregates.get(need.id);
    const issuedQtyFact = aggregate?.issuedQtyFact ?? '0';
    const actualCost = aggregate?.actualCost ?? '0';
    const unitMismatch = aggregate?.unitMismatch ?? false;
    const postedIssueLineCount = aggregate?.postedLineCount ?? 0;

    // `deltaQty = issuedQtyFact - plannedQty`. При unitMismatch
    // мы намеренно не суммировали разные единицы (см. агрегатор),
    // поэтому дельта в этом случае — это «факт совпадающих
    // единиц минус план», UI показывает warning отдельно.
    const issuedQtyNum = toFiniteNumber(issuedQtyFact) ?? 0;
    const plannedQtyNum = plannedCalcQtyNum ?? 0;
    const deltaQty = String(issuedQtyNum - plannedQtyNum);

    // `deltaCost = actualCost - plannedCost`. Если плановой
    // стоимости нет (USD без курса / нет цены) — `null`, иначе
    // дельта была бы фейковым «перерасходом» на всю фактическую
    // сумму.
    let deltaCost: string | null = null;
    if (plannedCost != null) {
      const actualCostNum = toFiniteNumber(actualCost) ?? 0;
      const plannedCostNum = toFiniteNumber(plannedCost) ?? 0;
      deltaCost = String(actualCostNum - plannedCostNum);
    }

    rows.push({
      id: need.id,
      roleLabel: getOrderMaterialRoleLabel(
        typeof need.materialRole === 'string' ? need.materialRole : null,
      ),
      materialRoleRaw:
        typeof need.materialRole === 'string' ? need.materialRole : null,
      description: need.description,
      metaText,
      imageUrl: need.materialImageUrl ?? null,
      requiresColorSelection: need.requiresColorSelection === true,
      colorText,
      calculatedQty,
      purchaseQty,
      unit,
      quotedPrice: need.quotedPrice ?? null,
      quotedCurrency: (need.quotedCurrency as 'RUB' | 'USD' | null) ?? null,
      lineTotalRub,
      lineTotalUsd,
      receivedQty: receivedQtyStr,
      placedQty: placedQtyStr,
      statusLabel: status.label,
      statusTone: status.tone,
      secondaryBadge: status.secondary,
      expectedOrReceivedDate,
      dateSource,
      supplierName,
      supplierItemText,
      commentText,
      warnings: status.warnings,
      plannedQty: calculatedQty,
      plannedCost,
      issuedQtyFact,
      actualCost,
      deltaQty,
      deltaCost,
      unitMismatch,
      postedIssueLineCount,
      originalNeed: need,
    });
  }

  // Сортировка: активные строки сверху, CANCELLED — в конец;
  // внутри активных приоритезируем критичные роли (MAIN_FABRIC →
  // RIB → LINING) — закупщик хочет их видеть первыми.
  const ROLE_PRIORITY: Record<string, number> = {
    MAIN_FABRIC: 0,
    ADDITIONAL_FABRIC: 1,
    RIB: 2,
    LINING: 3,
    INTERLINING: 4,
    FILLER: 5,
    THREAD: 6,
    PACKAGING: 7,
    MARKING: 8,
    APPLICATION: 9,
    ORDER_APPLICATION: 9,
  };

  return rows.sort((a, b) => {
    const aCancelled = a.originalNeed.status === 'CANCELLED' ? 1 : 0;
    const bCancelled = b.originalNeed.status === 'CANCELLED' ? 1 : 0;
    if (aCancelled !== bCancelled) return aCancelled - bCancelled;
    const aPrio = ROLE_PRIORITY[a.materialRoleRaw ?? ''] ?? 99;
    const bPrio = ROLE_PRIORITY[b.materialRoleRaw ?? ''] ?? 99;
    if (aPrio !== bPrio) return aPrio - bPrio;
    return a.description.localeCompare(b.description, 'ru');
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface OrderMaterialRowsSummary {
  totalRows: number;
  blockerCount: number;
  totalRub: number | null;
  hasUsdLines: boolean;
}

export function summariseOrderMaterialRows(
  rows: OrderMaterialTableRow[],
): OrderMaterialRowsSummary {
  let blockerCount = 0;
  let totalRub = 0;
  let anyRub = false;
  let hasUsdLines = false;
  for (const r of rows) {
    if (r.statusTone === 'warning' || r.statusTone === 'danger') {
      blockerCount += 1;
    }
    if (r.lineTotalRub) {
      const n = Number(r.lineTotalRub);
      if (Number.isFinite(n)) {
        totalRub += n;
        anyRub = true;
      }
    }
    if (r.lineTotalUsd) {
      hasUsdLines = true;
    }
  }
  return {
    totalRows: rows.length,
    blockerCount,
    totalRub: anyRub ? totalRub : null,
    hasUsdLines,
  };
}
