/**
 * Серверные обёртки над read-only API готовой продукции
 * (`GET /api/finished-goods/balances`,
 * `GET /api/finished-goods/movements`,
 * см. `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 * `docs/api.md §«Finished goods»`,
 * `docs/current-state.md §«Foundation готовой продукции»`).
 *
 * Используется из RSC `/admin/warehouses?tab=balances|movements` —
 * на этой итерации UI объединяет ответы материалов
 * (`lib/stock-api.ts`) и готовой продукции в одних таблицах
 * (см. `apps/web/components/warehouses/stock/unified-rows.ts`).
 *
 * Frontend держит локальные shape-ы, повторяющие
 * `FinishedGoodsService::toBalanceListItem` / `toMovementListItem` —
 * без `sourceKey` (внутренний идемпотентный технический ключ,
 * backend его сознательно не отдаёт, см. JSDoc сервиса).
 *
 * **Отдельный контур от материалов** — модели `FinishedGoodsBalance`
 * / `FinishedGoodsMovement` живут отдельно от `StockBalance` /
 * `StockMovement`; backend сохраняем без изменений.
 */
import { apiFetch } from './api';

/**
 * Запрос к `GET /api/finished-goods/balances`
 * (см. `ListFinishedGoodsBalancesQuerySchema`).
 *
 * `q` — case-insensitive substring по `color`. `positiveOnly` /
 * `negativeOnly` / `zeroOnly` — взаимоисключающие флаги
 * (см. `superRefine`); UI ставит максимум один. Pagination —
 * `limit` default 50, max 200; `offset` default 0.
 */
export interface ListFinishedGoodsBalancesQuery {
  q?: string;
  warehouseId?: string;
  orderId?: string;
  productId?: string;
  sizeId?: string;
  cellId?: string;
  positiveOnly?: boolean;
  negativeOnly?: boolean;
  zeroOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Запрос к `GET /api/finished-goods/movements`
 * (см. `ListFinishedGoodsMovementsQuerySchema`).
 *
 * Фильтр `q` backend на этой итерации НЕ принимает (DTO
 * `.strict()`-схема), поэтому в client-обёртке поля `q` нет —
 * для общего «поиска» в объединённой таблице UI применяет `q`
 * только к материалам, а для готовой продукции пропускает
 * (см. `BalancesTabPage` / `MovementsTabPage`).
 */
export interface ListFinishedGoodsMovementsQuery {
  orderId?: string;
  productId?: string;
  sizeId?: string;
  warehouseId?: string;
  cellId?: string;
  type?: FinishedGoodsMovementType;
  direction?: FinishedGoodsMovementDirection;
  passportId?: string;
  boxId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export type FinishedGoodsMovementDirection = 'IN' | 'OUT';

/**
 * Совпадает с `FINISHED_GOODS_MOVEMENT_TYPE` из
 * `apps/api/src/modules/finished-goods/finished-goods.constants.ts`.
 * На MVP реальный writer есть только для `PRODUCTION_RECEIPT`.
 * Остальные типы зарезервированы строковыми литералами для
 * будущих итераций (отгрузка / transfer / adjustment / reversal).
 */
export type FinishedGoodsMovementType =
  | 'PRODUCTION_RECEIPT'
  | 'REVERSAL'
  | 'ADJUSTMENT'
  | 'SHIPMENT'
  | 'TRANSFER';

export interface FinishedGoodsBalanceListItem {
  id: string;
  balanceKey: string;
  orderId: string;
  orderNumber: string | null;
  /** `Order.clientId` — управленческая привязка к карточке клиента. */
  clientId: string | null;
  /** `Client.name` — отображается в UI («Заказчик»). */
  clientName: string | null;
  productId: string;
  productName: string | null;
  sizeId: string;
  sizeCode: string | null;
  color: string;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  qty: number;
  lastMovementAt: string | null;
  updatedAt: string;
}

export interface FinishedGoodsBalanceListResponse {
  items: FinishedGoodsBalanceListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface FinishedGoodsMovementListItem {
  id: string;
  finishedGoodsBalanceId: string | null;
  type: string;
  direction: string;
  orderId: string;
  orderNumber: string | null;
  /** `Order.clientId` — управленческая привязка к карточке клиента. */
  clientId: string | null;
  /** `Client.name` — отображается в UI журнала движений склада. */
  clientName: string | null;
  productId: string;
  productName: string | null;
  sizeId: string;
  sizeCode: string | null;
  color: string;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  qty: number;
  balanceBeforeQty: number | null;
  balanceAfterQty: number | null;
  sourceType: string | null;
  sourceId: string | null;
  passportId: string | null;
  boxId: string | null;
  comment: string | null;
  createdById: string | null;
  createdAt: string;
}

export interface FinishedGoodsMovementListResponse {
  items: FinishedGoodsMovementListItem[];
  total: number;
  limit: number;
  offset: number;
}

function toQueryFlag(value: boolean | undefined): 'true' | undefined {
  return value === true ? 'true' : undefined;
}

export function listFinishedGoodsBalances(
  query: ListFinishedGoodsBalancesQuery = {},
): Promise<FinishedGoodsBalanceListResponse> {
  return apiFetch<FinishedGoodsBalanceListResponse>('/finished-goods/balances', {
    cache: 'no-store',
    searchParams: {
      q: query.q,
      warehouseId: query.warehouseId,
      orderId: query.orderId,
      productId: query.productId,
      sizeId: query.sizeId,
      cellId: query.cellId,
      positiveOnly: toQueryFlag(query.positiveOnly),
      negativeOnly: toQueryFlag(query.negativeOnly),
      zeroOnly: toQueryFlag(query.zeroOnly),
      limit: query.limit,
      offset: query.offset,
    },
  });
}

export function listFinishedGoodsMovements(
  query: ListFinishedGoodsMovementsQuery = {},
): Promise<FinishedGoodsMovementListResponse> {
  return apiFetch<FinishedGoodsMovementListResponse>(
    '/finished-goods/movements',
    {
      cache: 'no-store',
      searchParams: {
        orderId: query.orderId,
        productId: query.productId,
        sizeId: query.sizeId,
        warehouseId: query.warehouseId,
        cellId: query.cellId,
        type: query.type,
        direction: query.direction,
        passportId: query.passportId,
        boxId: query.boxId,
        from: query.from,
        to: query.to,
        limit: query.limit,
        offset: query.offset,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Shipments — отгрузка готовой продукции из карточки заказа.
// ---------------------------------------------------------------------------

/**
 * Строка документа отгрузки готовой продукции (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::FinishedGoodsShipmentLineDto`).
 * Snapshot product / size / color / warehouse / cell на момент
 * создания документа.
 */
export interface FinishedGoodsShipmentLineDto {
  id: string;
  finishedGoodsBalanceId: string | null;
  productId: string;
  productName: string | null;
  sizeId: string;
  sizeCode: string | null;
  color: string;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  qty: number;
  comment: string | null;
}

export interface FinishedGoodsShipmentDetailDto {
  id: string;
  number: string;
  orderId: string;
  /** На MVP допустимы значения `POSTED` и `CANCELLED`. */
  status: string;
  shippedAt: string;
  comment: string | null;
  createdAt: string;
  createdById: string | null;
  /** Заполняется одновременно при `status = CANCELLED`. */
  cancelledAt: string | null;
  cancelledById: string | null;
  cancelReason: string | null;
  lines: FinishedGoodsShipmentLineDto[];
  // sourceKey намеренно не объявлен — backend его не отдаёт.
}

/**
 * Body для `POST /api/orders/:orderId/finished-goods-shipments`. UI
 * собирает строки по доступным `FinishedGoodsBalance` и присылает
 * `clientRequestId` (UUID) для идемпотентности повторного submit.
 */
export interface CreateFinishedGoodsShipmentDto {
  shippedAt?: string;
  comment?: string;
  clientRequestId?: string;
  lines: Array<{
    finishedGoodsBalanceId: string;
    qty: number;
    comment?: string;
  }>;
}

export function listOrderFinishedGoodsShipments(
  orderId: string,
): Promise<FinishedGoodsShipmentDetailDto[]> {
  return apiFetch<FinishedGoodsShipmentDetailDto[]>(
    `/orders/${encodeURIComponent(orderId)}/finished-goods-shipments`,
    { cache: 'no-store' },
  );
}

export function createOrderFinishedGoodsShipment(
  orderId: string,
  body: CreateFinishedGoodsShipmentDto,
): Promise<FinishedGoodsShipmentDetailDto> {
  return apiFetch<FinishedGoodsShipmentDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/finished-goods-shipments`,
    {
      method: 'POST',
      body,
    },
  );
}

export function getFinishedGoodsShipment(
  id: string,
): Promise<FinishedGoodsShipmentDetailDto> {
  return apiFetch<FinishedGoodsShipmentDetailDto>(
    `/finished-goods/shipments/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

/**
 * Body для `POST /api/finished-goods/shipments/:id/cancel`. UI
 * собирает только `reason` (2..500); никаких lines / qty —
 * частичная отмена не поддерживается на этой итерации (см.
 * `FinishedGoodsService.cancelShipment`).
 */
export interface CancelFinishedGoodsShipmentDto {
  reason: string;
}

export function cancelFinishedGoodsShipment(
  id: string,
  body: CancelFinishedGoodsShipmentDto,
): Promise<FinishedGoodsShipmentDetailDto> {
  return apiFetch<FinishedGoodsShipmentDetailDto>(
    `/finished-goods/shipments/${encodeURIComponent(id)}/cancel`,
    {
      method: 'POST',
      body,
    },
  );
}

// ---------------------------------------------------------------------------
// Transfers — перемещение готовой продукции между складами / ячейками.
// ---------------------------------------------------------------------------

/**
 * Body для `POST /api/finished-goods/transfers` — перемещение готовой
 * продукции между складами / ячейками из UI
 * `/admin/warehouses?tab=balances`, кнопка «Переместить» (см.
 * `apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts`).
 *
 * `orderId`, `productId`, `sizeId`, `color`, `unit` сервис берёт из
 * исходного `FinishedGoodsBalance` — клиент их не присылает.
 *
 * `qty` всегда целое (готовая продукция штучная,
 * `FinishedGoodsBalance.qty: Int`).
 *
 * `clientRequestId` опционален; если передан — становится частью пары
 * идемпотентных `sourceKey`-ключей в `FinishedGoodsMovement`
 * (`FINISHED_GOODS_TRANSFER:<id>:OUT` /
 * `FINISHED_GOODS_TRANSFER:<id>:IN`). UI всё равно присылает
 * `clientRequestId`, чтобы повторный submit при двойном клике /
 * network retry не задвоил движения.
 */
export interface CreateFinishedGoodsTransferDto {
  fromFinishedGoodsBalanceId: string;
  toWarehouseId?: string | null;
  toCellId?: string | null;
  qty: number;
  comment: string;
  clientRequestId?: string;
}

/**
 * Ответ `POST /api/finished-goods/transfers` — пара движений
 * `type = TRANSFER` + сам `transferId` (идентификатор пары, совпадает с
 * `clientRequestId`). `sourceKey` сознательно НЕ возвращается.
 */
export interface CreateFinishedGoodsTransferResponse {
  transferId: string;
  outMovement: FinishedGoodsMovementListItem;
  inMovement: FinishedGoodsMovementListItem;
}

/**
 * `POST /api/finished-goods/transfers` — перемещение готовой продукции
 * склад-в-склад / ячейка-в-ячейка. Создаёт пару
 * `FinishedGoodsMovement` `type = TRANSFER` (`OUT` из источника +
 * `IN` в назначение) в одной транзакции; `sourceKey` для обоих
 * движений строится по `clientRequestId`, поэтому повторный submit
 * идемпотентен.
 */
export function createFinishedGoodsTransfer(
  body: CreateFinishedGoodsTransferDto,
): Promise<CreateFinishedGoodsTransferResponse> {
  return apiFetch<CreateFinishedGoodsTransferResponse>(
    '/finished-goods/transfers',
    {
      method: 'POST',
      body,
    },
  );
}

// ---------------------------------------------------------------------------
// Adjustments — ручная корректировка остатка готовой продукции.
// ---------------------------------------------------------------------------

/**
 * Body для `POST /api/finished-goods/adjustments` — ручная
 * корректировка остатка готовой продукции из UI
 * `/admin/warehouses?tab=balances`, кнопка «Корректировка» (см.
 * `apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts`).
 *
 * `orderId`, `productId`, `sizeId`, `color`, `warehouseId`, `cellId`,
 * `unit` сервис берёт из исходного `FinishedGoodsBalance` — клиент их
 * не присылает. `qty` всегда целое (готовая продукция штучная,
 * `FinishedGoodsBalance.qty: Int`). `unitCost` для готовой продукции
 * не запрашивается — это не material cost.
 *
 * `clientRequestId` опционален; если передан — становится частью
 * идемпотентного `sourceKey =
 * FINISHED_GOODS_ADJUSTMENT:<clientRequestId>`. UI всё равно
 * присылает `clientRequestId`, чтобы повторный submit при двойном
 * клике / network retry не задвоил движение.
 */
export interface CreateFinishedGoodsAdjustmentDto {
  finishedGoodsBalanceId: string;
  direction: FinishedGoodsMovementDirection;
  qty: number;
  comment: string;
  clientRequestId?: string;
}

/**
 * `POST /api/finished-goods/adjustments` — ручная корректировка
 * остатка готовой продукции. Создаёт одно
 * `FinishedGoodsMovement` `type = ADJUSTMENT` (`direction = IN | OUT`)
 * и audit `FINISHED_GOODS_ADJUSTMENT_CREATED` в одной транзакции.
 * `sourceKey` сознательно НЕ возвращается.
 */
export function createFinishedGoodsAdjustment(
  body: CreateFinishedGoodsAdjustmentDto,
): Promise<FinishedGoodsMovementListItem> {
  return apiFetch<FinishedGoodsMovementListItem>(
    '/finished-goods/adjustments',
    {
      method: 'POST',
      body,
    },
  );
}
