/**
 * Unified row-shape для read-only таблиц «Остатки» и «Движения»
 * раздела `/admin/warehouses` (см. `apps/web/app/admin/warehouses/page.tsx`).
 *
 * UI-решение владельца проекта (см. ТЗ «show finished goods in stock
 * views»): вместо отдельной вкладки / страницы / sidebar-пункта под
 * готовую продукцию — показать материалы и готовую продукцию **в
 * существующих вкладках** «Остатки» и «Движения». На уровне UI это
 * один общий список. Backend остаётся раздельным
 * (`StockBalance` / `StockMovement` для материалов,
 * `FinishedGoodsBalance` / `FinishedGoodsMovement` для готовой
 * продукции). Объединение делается на уровне страницы / mappers.
 *
 * `kind` различает источник строки и используется для key / data-attr;
 * **отдельной колонки «Тип»** не вводим — готовая продукция различима
 * по названию (`product / color / size`). Для готовой продукции цена
 * и сумма всегда `null` (это не material cost).
 *
 * **TODO (backend unified endpoint).** Слияние делается в RSC после
 * двух fetch-ей по `limit=200` (см. `WAREHOUSES_UNIFIED_FETCH_LIMIT`).
 * Для больших объёмов это станет узким местом — лучше сделать
 * backend unified warehouse endpoint с серверным total / pagination /
 * sorting. На MVP это сознательная граница итерации — материалы и
 * готовая продукция исторически в разных таблицах, и UI ходит в два
 * read-only API.
 */
import type { StockBalanceListItem, StockMovementListItem } from '@/lib/stock-api';
import type {
  FinishedGoodsBalanceListItem,
  FinishedGoodsMovementListItem,
} from '@/lib/finished-goods-api';
import type {
  WorkInProgressBalanceListItem,
  WorkInProgressMovementListItem,
} from '@/lib/work-in-progress-api';

/**
 * Размер страницы при объединённом fetch-е материалов и готовой
 * продукции. Совпадает с `STOCK_LIST_MAX_LIMIT` — это потолок
 * backend DTO. UI-pagination применяется уже на объединённом
 * массиве (см. `applyUnifiedPagination`).
 */
export const WAREHOUSES_UNIFIED_FETCH_LIMIT = 200;

export type UnifiedRowKind = 'MATERIAL' | 'FINISHED_GOOD' | 'WORK_IN_PROGRESS';

/**
 * Общий формат строки таблицы «Остатки». Для готовой продукции
 * `unitCost` / `totalCost` всегда `null` — рендер показывает
 * прочерк (`«—»`) через `formatStockMoney(null)`.
 */
export interface UnifiedWarehouseBalanceRow {
  kind: UnifiedRowKind;
  /** Уникальный id строки внутри своего контура. */
  id: string;
  /** Текстовое представление номенклатуры; для готовой продукции —
   * `${productName} / ${color} / ${sizeName}` с fallback на id. */
  name: string;
  /** Управленческая подсказка под именем (например, `materialRole`
   * для материалов). Для готовой продукции остаётся пустой. */
  hint?: string | null;
  orderId?: string | null;
  orderNumber?: string | null;
  warehouseId?: string | null;
  warehouseName?: string | null;
  cellId?: string | null;
  cellCode?: string | null;
  qty: string | number;
  unit: string;
  unitCost?: string | number | null;
  totalCost?: string | number | null;
  lastMovementAt?: string | null;
  updatedAt?: string | null;
}

/**
 * Общий формат строки таблицы «Движения».
 */
export interface UnifiedWarehouseMovementRow {
  kind: UnifiedRowKind;
  id: string;
  createdAt: string;
  type: string;
  direction: 'IN' | 'OUT';
  name: string;
  orderId?: string | null;
  orderNumber?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  warehouseId?: string | null;
  warehouseName?: string | null;
  cellId?: string | null;
  cellCode?: string | null;
  qty: string | number;
  unit: string;
  unitCost?: string | number | null;
  totalCost?: string | number | null;
  balanceBeforeQty?: string | number | null;
  balanceAfterQty?: string | number | null;
  sourceType?: string | null;
  sourceId?: string | null;
  passportId?: string | null;
  boxId?: string | null;
  comment?: string | null;
}

/**
 * Преобразование material `StockBalanceListItem` → unified row.
 * Для материалов «номенклатура» — это `description`, hint —
 * `materialRole` (если есть).
 */
export function materialBalanceToUnified(
  b: StockBalanceListItem,
): UnifiedWarehouseBalanceRow {
  return {
    kind: 'MATERIAL',
    id: `material:${b.id}`,
    name: b.description,
    hint: b.materialRole ?? null,
    orderId: b.orderId ?? null,
    orderNumber: b.orderNumber ?? null,
    warehouseId: b.warehouseId ?? null,
    warehouseName: b.warehouseName ?? null,
    cellId: b.cellId ?? null,
    cellCode: b.cellCode ?? null,
    qty: b.qty,
    unit: b.unit,
    unitCost: b.unitCost,
    totalCost: b.totalCost,
    lastMovementAt: b.lastMovementAt ?? null,
    updatedAt: b.updatedAt,
  };
}

/**
 * Преобразование `FinishedGoodsBalanceListItem` → unified row.
 *
 * Имя строки — `${productName} / ${color} / ${sizeCode}` (fallback
 * на id, если справочные поля отсутствуют — например, удалили
 * product). Это даёт менеджеру шаблон «Худи модель 001 / чёрный / L»
 * прямо в общей таблице с материалами, без отдельной колонки «Тип».
 *
 * `unit` зашит на «шт» — готовые изделия штучные (`qty: Int` в
 * Prisma). `unitCost` / `totalCost` — `null`: для готовой продукции
 * это не material cost, и backend их не считает.
 */
export function finishedGoodsBalanceToUnified(
  b: FinishedGoodsBalanceListItem,
): UnifiedWarehouseBalanceRow {
  return {
    kind: 'FINISHED_GOOD',
    id: `finished-good:${b.id}`,
    name: buildFinishedGoodsName(b),
    hint: null,
    orderId: b.orderId ?? null,
    orderNumber: b.orderNumber ?? null,
    warehouseId: b.warehouseId ?? null,
    warehouseName: b.warehouseName ?? null,
    cellId: b.cellId ?? null,
    cellCode: b.cellCode ?? null,
    qty: b.qty,
    unit: 'шт',
    unitCost: null,
    totalCost: null,
    lastMovementAt: b.lastMovementAt ?? null,
    updatedAt: b.updatedAt,
  };
}

/**
 * Преобразование `WorkInProgressBalanceListItem` → unified row.
 *
 * Имя строки — `${productName} / ${color} / ${sizeCode}` (тот же
 * шаблон, что у готовой продукции). `unit` = «шт» — крой штучный
 * (`qty: Int`). `unitCost` / `totalCost` — `null`: материальная
 * себестоимость кроя в этом контуре не считается (она живёт в
 * `MaterialIssue`). `hint` = «Полуфабрикат» — единственный кейс,
 * где мы маркируем строку, потому что без подсказки крой и готовая
 * продукция выглядят одинаково.
 */
export function workInProgressBalanceToUnified(
  b: WorkInProgressBalanceListItem,
): UnifiedWarehouseBalanceRow {
  return {
    kind: 'WORK_IN_PROGRESS',
    id: `wip:${b.id}`,
    name: buildFinishedGoodsName(b),
    hint: 'Полуфабрикат',
    orderId: b.orderId ?? null,
    orderNumber: b.orderNumber ?? null,
    warehouseId: b.warehouseId ?? null,
    warehouseName: b.warehouseName ?? null,
    cellId: b.cellId ?? null,
    cellCode: b.cellCode ?? null,
    qty: b.qty,
    unit: 'шт',
    unitCost: null,
    totalCost: null,
    lastMovementAt: b.lastMovementAt ?? null,
    updatedAt: b.updatedAt,
  };
}

/**
 * Преобразование `WorkInProgressMovementListItem` → unified row.
 */
export function workInProgressMovementToUnified(
  m: WorkInProgressMovementListItem,
): UnifiedWarehouseMovementRow {
  const direction: 'IN' | 'OUT' = m.direction === 'OUT' ? 'OUT' : 'IN';
  return {
    kind: 'WORK_IN_PROGRESS',
    id: `wip:${m.id}`,
    createdAt: m.createdAt,
    type: m.type,
    direction,
    name: buildFinishedGoodsName(m),
    orderId: m.orderId ?? null,
    orderNumber: m.orderNumber ?? null,
    clientId: null,
    clientName: null,
    warehouseId: m.warehouseId ?? null,
    warehouseName: m.warehouseName ?? null,
    cellId: m.cellId ?? null,
    cellCode: m.cellCode ?? null,
    qty: m.qty,
    unit: 'шт',
    unitCost: null,
    totalCost: null,
    balanceBeforeQty: m.balanceBeforeQty ?? null,
    balanceAfterQty: m.balanceAfterQty ?? null,
    sourceType: m.sourceType ?? null,
    sourceId: null,
    passportId: m.passportId ?? null,
    boxId: null,
    comment: m.comment ?? null,
  };
}

/**
 * Преобразование material `StockMovementListItem` → unified row.
 * Имя — fallback `workshopNeedId` / `sourceId` (backend в
 * movement-response не отдаёт `description`).
 */
export function materialMovementToUnified(
  m: StockMovementListItem,
): UnifiedWarehouseMovementRow {
  return {
    kind: 'MATERIAL',
    id: `material:${m.id}`,
    createdAt: m.createdAt,
    type: m.type,
    direction: m.direction,
    name: m.workshopNeedId || m.sourceId || '—',
    orderId: m.orderId ?? null,
    orderNumber: m.orderNumber ?? null,
    clientId: m.clientId ?? null,
    clientName: m.clientName ?? null,
    warehouseId: m.warehouseId ?? null,
    warehouseName: m.warehouseName ?? null,
    cellId: m.cellId ?? null,
    cellCode: m.cellCode ?? null,
    qty: m.qty,
    unit: m.unit,
    unitCost: m.unitCost,
    totalCost: m.totalCost,
    balanceBeforeQty: m.balanceBeforeQty ?? null,
    balanceAfterQty: m.balanceAfterQty ?? null,
    sourceType: m.sourceType ?? null,
    sourceId: m.sourceId ?? null,
    passportId: null,
    boxId: null,
    comment: m.comment ?? null,
  };
}

/**
 * Преобразование `FinishedGoodsMovementListItem` → unified row.
 *
 * Имя — `${productName} / ${color} / ${sizeCode}`. `direction`
 * нормализуем к `IN | OUT` (backend хранит string). Для
 * `passportId` / `boxId` колонка «Источник» в таблице соберёт
 * подпись (см. `stock-movements-table.tsx::formatUnifiedSource`).
 */
export function finishedGoodsMovementToUnified(
  m: FinishedGoodsMovementListItem,
): UnifiedWarehouseMovementRow {
  const direction: 'IN' | 'OUT' = m.direction === 'OUT' ? 'OUT' : 'IN';
  return {
    kind: 'FINISHED_GOOD',
    id: `finished-good:${m.id}`,
    createdAt: m.createdAt,
    type: m.type,
    direction,
    name: buildFinishedGoodsName(m),
    orderId: m.orderId ?? null,
    orderNumber: m.orderNumber ?? null,
    clientId: m.clientId ?? null,
    clientName: m.clientName ?? null,
    warehouseId: m.warehouseId ?? null,
    warehouseName: m.warehouseName ?? null,
    cellId: m.cellId ?? null,
    cellCode: m.cellCode ?? null,
    qty: m.qty,
    unit: 'шт',
    unitCost: null,
    totalCost: null,
    balanceBeforeQty: m.balanceBeforeQty ?? null,
    balanceAfterQty: m.balanceAfterQty ?? null,
    sourceType: m.sourceType ?? null,
    sourceId: m.sourceId ?? null,
    passportId: m.passportId ?? null,
    boxId: m.boxId ?? null,
    comment: m.comment ?? null,
  };
}

/**
 * Шаблон имени готовой продукции для UI: `productName / color /
 * sizeCode`. Если справочное поле отсутствует — fallback на id;
 * пустые сегменты выкидываем, чтобы не получить «// L».
 */
function buildFinishedGoodsName(item: {
  productId: string;
  productName: string | null;
  sizeId: string;
  sizeCode: string | null;
  color: string;
}): string {
  const product = item.productName ?? item.productId;
  const size = item.sizeCode ?? item.sizeId;
  const color = item.color ?? '';
  const parts: string[] = [];
  if (product) parts.push(product);
  if (color) parts.push(color);
  if (size) parts.push(size);
  return parts.join(' / ');
}

/**
 * Сортировка объединённых остатков по `updatedAt desc`. Строки без
 * даты идут в конец — лучше пустоту видеть после реальных записей.
 */
export function sortUnifiedBalances(
  rows: UnifiedWarehouseBalanceRow[],
): UnifiedWarehouseBalanceRow[] {
  return [...rows].sort((a, b) => compareDescNullable(a.updatedAt, b.updatedAt));
}

/**
 * Сортировка объединённых движений по `createdAt desc`.
 */
export function sortUnifiedMovements(
  rows: UnifiedWarehouseMovementRow[],
): UnifiedWarehouseMovementRow[] {
  return [...rows].sort((a, b) => compareDescNullable(a.createdAt, b.createdAt));
}

function compareDescNullable(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * UI-pagination над объединённым массивом. `total` остаётся
 * суммой backend-total-ов двух API — это компромисс MVP до
 * появления unified backend endpoint.
 */
export function applyUnifiedPagination<T>(
  rows: T[],
  offset: number,
  limit: number,
): T[] {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, limit);
  return rows.slice(safeOffset, safeOffset + safeLimit);
}
