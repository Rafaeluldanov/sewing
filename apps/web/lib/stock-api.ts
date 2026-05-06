/**
 * Серверные обёртки над read-only API склада
 * (`GET /api/stock/balances`, `GET /api/stock/movements`,
 * см. `apps/api/src/modules/stock/stock.controller.ts`,
 * `docs/api.md §«26a. Stock (read-only)»`).
 *
 * Используется из RSC `/admin/warehouses?tab=balances|movements`
 * (см. `apps/web/app/admin/warehouses/page.tsx`). Фронтовых типов
 * для shape-ов `StockBalance` / `StockMovement` в `@sewing/shared`
 * пока нет — backend держит сериализатор у себя в сервисе
 * (`StockService.toStockBalanceListItem` / `toStockMovementListItem`).
 * Дублируем shape тут, локально, без `sourceKey` — это внутренний
 * идемпотентный ключ, его публичный API не отдаёт (см. JSDoc сервиса).
 */
import { apiFetch } from './api';

/**
 * Запрос к `GET /api/stock/balances` (см. `ListStockBalancesQuerySchema`
 * в `apps/api/src/modules/stock/dto/list-stock-balances.dto.ts`).
 *
 * На этой UI-итерации фильтр держим минимальным: `q` + три
 * взаимоисключающих флага + pagination. `warehouseId` / `cellId` /
 * `materialRole` / `unit` сознательно не прокидываем, чтобы не
 * усложнять MVP UI «Складов» multi-warehouse-логикой.
 */
export interface ListStockBalancesQuery {
  q?: string;
  positiveOnly?: boolean;
  negativeOnly?: boolean;
  zeroOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Запрос к `GET /api/stock/movements` (см. `ListStockMovementsQuerySchema`).
 * `direction` / `type` оставлены как минимально полезные фильтры
 * для журнала движений; `warehouseId` / `cellId` / `from` / `to`
 * не прокидываем.
 */
export interface ListStockMovementsQuery {
  q?: string;
  type?: StockMovementType;
  direction?: StockMovementDirection;
  limit?: number;
  offset?: number;
}

export type StockMovementDirection = 'IN' | 'OUT';

/**
 * Совпадает с `STOCK_MOVEMENT_TYPE` из
 * `apps/api/src/modules/stock/stock.constants.ts`. Frontend держит
 * локальный union, чтобы не вытаскивать backend-константы в
 * client-bundle.
 */
export type StockMovementType =
  | 'PURCHASE_RECEIPT'
  | 'MATERIAL_ISSUE'
  | 'ADJUSTMENT'
  | 'REVERSAL'
  | 'TRANSFER';

export interface StockBalanceListItem {
  id: string;
  balanceKey: string;
  workshopNeedId: string;
  orderId?: string | null;
  orderNumber?: string | null;
  warehouseId?: string | null;
  warehouseName?: string | null;
  cellId?: string | null;
  cellCode?: string | null;
  description: string;
  materialRole?: string | null;
  unit: string;
  qty: string | number;
  unitCost: string | number;
  totalCost: string | number;
  lastMovementAt?: string | null;
  updatedAt: string;
}

export interface StockBalanceListResponse {
  items: StockBalanceListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface StockMovementListItem {
  id: string;
  stockBalanceId?: string | null;
  workshopNeedId: string;
  orderId?: string | null;
  orderNumber?: string | null;
  type: string;
  direction: StockMovementDirection;
  warehouseId?: string | null;
  warehouseName?: string | null;
  cellId?: string | null;
  cellCode?: string | null;
  qty: string | number;
  unit: string;
  unitCost: string | number;
  totalCost: string | number;
  balanceBeforeQty?: string | number | null;
  balanceAfterQty?: string | number | null;
  sourceType?: string | null;
  sourceId?: string | null;
  purchaseReceiptId?: string | null;
  purchaseReceiptLineId?: string | null;
  materialIssueId?: string | null;
  materialIssueLineId?: string | null;
  comment?: string | null;
  createdById?: string | null;
  createdAt: string;
}

export interface StockMovementListResponse {
  items: StockMovementListItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Дефолтный размер страницы для UI-таблиц «Остатки» / «Движения».
 * Совпадает с backend-default из `ListStockBalancesQuerySchema`.
 */
export const STOCK_LIST_DEFAULT_LIMIT = 50;
export const STOCK_LIST_MAX_LIMIT = 200;

function toQueryFlag(value: boolean | undefined): 'true' | undefined {
  return value === true ? 'true' : undefined;
}

export function listStockBalances(
  query: ListStockBalancesQuery = {},
): Promise<StockBalanceListResponse> {
  return apiFetch<StockBalanceListResponse>('/stock/balances', {
    cache: 'no-store',
    searchParams: {
      q: query.q,
      // Backend ZodValidationPipe принимает 'true' | 'false' | '1' | '0';
      // отправляем строку только когда флаг явно true — так UI не
      // конфликтует с superRefine «mutually exclusive».
      positiveOnly: toQueryFlag(query.positiveOnly),
      negativeOnly: toQueryFlag(query.negativeOnly),
      zeroOnly: toQueryFlag(query.zeroOnly),
      limit: query.limit,
      offset: query.offset,
    },
  });
}

export function listStockMovements(
  query: ListStockMovementsQuery = {},
): Promise<StockMovementListResponse> {
  return apiFetch<StockMovementListResponse>('/stock/movements', {
    cache: 'no-store',
    searchParams: {
      q: query.q,
      type: query.type,
      direction: query.direction,
      limit: query.limit,
      offset: query.offset,
    },
  });
}

/**
 * Body для `POST /api/stock/adjustments` — ручная корректировка
 * остатка из UI `/admin/warehouses?tab=balances` (см.
 * `apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts`).
 *
 * `unitCost` имеет смысл только для `IN`. Для `OUT` поле может быть
 * передано (UI может прислать сохранённое значение), но backend его
 * игнорирует — складская оценка OUT всегда берётся из текущего
 * `StockBalance.unitCost`. `clientRequestId` опционален; если передан,
 * становится частью идемпотентного `sourceKey` в `StockMovement`
 * (один `clientRequestId` → одно движение).
 */
export interface CreateStockAdjustmentDto {
  stockBalanceId: string;
  direction: StockMovementDirection;
  qty: string | number;
  unitCost?: string | number;
  comment: string;
  clientRequestId?: string;
}

/**
 * `POST /api/stock/adjustments` — ручная корректировка остатка.
 * Возвращает созданное (или ранее существовавшее при идемпотентном
 * повторе) `StockMovement` в shape `StockMovementListItem`. `sourceKey`
 * сознательно НЕ возвращается (см. `StockService.toStockMovementListItem`).
 */
export function createStockAdjustment(
  body: CreateStockAdjustmentDto,
): Promise<StockMovementListItem> {
  return apiFetch<StockMovementListItem>('/stock/adjustments', {
    method: 'POST',
    body,
  });
}

/**
 * Body для `POST /api/stock/transfers` — перемещение остатка между
 * складами / ячейками из UI `/admin/warehouses?tab=balances`,
 * кнопка «Переместить» (см.
 * `apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`).
 *
 * `workshopNeedId`, `unit`, `unitCost`, `description` сервис берёт из
 * исходного `StockBalance` — клиент их не присылает.
 *
 * `clientRequestId` опционален; если передан — становится частью
 * пары идемпотентных `sourceKey`-ключей в `StockMovement`
 * (`STOCK_TRANSFER:<id>:OUT` / `STOCK_TRANSFER:<id>:IN`). UI всё равно
 * присылает `clientRequestId`, чтобы повторный submit при двойном
 * клике / network retry не задвоил движения.
 */
export interface CreateStockTransferDto {
  fromStockBalanceId: string;
  toWarehouseId?: string | null;
  toCellId?: string | null;
  qty: string | number;
  comment: string;
  clientRequestId?: string;
}

/**
 * Ответ `POST /api/stock/transfers` — пара движений `type = TRANSFER`
 * + сам `transferId` (идентификатор пары, совпадает с
 * `clientRequestId`). `sourceKey` сознательно НЕ возвращается.
 */
export interface CreateStockTransferResponse {
  transferId: string;
  outMovement: StockMovementListItem;
  inMovement: StockMovementListItem;
}

/**
 * `POST /api/stock/transfers` — перемещение остатка склад-в-склад /
 * ячейка-в-ячейка. Создаёт пару `StockMovement` `type = TRANSFER`
 * (`OUT` из источника + `IN` в назначение) в одной транзакции;
 * `sourceKey` для обоих движений строится по `clientRequestId`,
 * поэтому повторный submit идемпотентен.
 */
export function createStockTransfer(
  body: CreateStockTransferDto,
): Promise<CreateStockTransferResponse> {
  return apiFetch<CreateStockTransferResponse>('/stock/transfers', {
    method: 'POST',
    body,
  });
}
