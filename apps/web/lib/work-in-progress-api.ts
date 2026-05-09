/**
 * Серверные обёртки над read-only API полуфабриката (крой)
 * (`GET /api/work-in-progress/balances`,
 * `GET /api/work-in-progress/movements`,
 * см. `apps/api/src/modules/work-in-progress/work-in-progress.controller.ts`).
 *
 * Используется из RSC `/admin/warehouses?tab=balances|movements` —
 * UI объединяет ответы материалов (`lib/stock-api.ts`), готовой
 * продукции (`lib/finished-goods-api.ts`) и полуфабриката
 * в одних таблицах (см.
 * `apps/web/components/warehouses/stock/unified-rows.ts`).
 *
 * **Отдельный контур** от материалов и готовой продукции — модели
 * `WorkInProgressBalance` / `WorkInProgressMovement` живут отдельно.
 */
import { apiFetch } from './api';

export type WorkInProgressMovementDirection = 'IN' | 'OUT';

export type WorkInProgressMovementType =
  | 'PLACE'
  | 'ISSUE'
  | 'RETURN'
  | 'DELETE'
  | 'PACK_OUT';

export interface ListWorkInProgressBalancesQuery {
  warehouseId?: string;
  orderId?: string;
  productId?: string;
  sizeId?: string;
  color?: string;
  cellId?: string;
  /** Если `true`, отдаются только балансы с qty > 0. */
  nonZero?: boolean;
  skip?: number;
  take?: number;
}

export interface ListWorkInProgressMovementsQuery {
  orderId?: string;
  warehouseId?: string;
  cellId?: string;
  passportId?: string;
  type?: WorkInProgressMovementType;
  direction?: WorkInProgressMovementDirection;
  skip?: number;
  take?: number;
}

export interface WorkInProgressBalanceListItem {
  id: string;
  orderId: string;
  orderNumber: string | null;
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
  updatedAt: string;
  lastMovementAt: string | null;
}

export interface WorkInProgressBalanceListResponse {
  items: WorkInProgressBalanceListItem[];
  total: number;
}

export interface WorkInProgressMovementListItem {
  id: string;
  type: string;
  direction: string;
  orderId: string;
  orderNumber: string | null;
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
  passportId: string | null;
  passportNumber: string | null;
  sourceType: string | null;
  comment: string | null;
  createdAt: string;
}

export interface WorkInProgressMovementListResponse {
  items: WorkInProgressMovementListItem[];
  total: number;
}

function toQueryFlag(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? 'true' : 'false';
}

export function listWorkInProgressBalances(
  query: ListWorkInProgressBalancesQuery = {},
): Promise<WorkInProgressBalanceListResponse> {
  return apiFetch<WorkInProgressBalanceListResponse>(
    '/work-in-progress/balances',
    {
      cache: 'no-store',
      searchParams: {
        warehouseId: query.warehouseId,
        orderId: query.orderId,
        productId: query.productId,
        sizeId: query.sizeId,
        color: query.color,
        cellId: query.cellId,
        nonZero: toQueryFlag(query.nonZero),
        skip: query.skip,
        take: query.take,
      },
    },
  );
}

export function listWorkInProgressMovements(
  query: ListWorkInProgressMovementsQuery = {},
): Promise<WorkInProgressMovementListResponse> {
  return apiFetch<WorkInProgressMovementListResponse>(
    '/work-in-progress/movements',
    {
      cache: 'no-store',
      searchParams: {
        orderId: query.orderId,
        warehouseId: query.warehouseId,
        cellId: query.cellId,
        passportId: query.passportId,
        type: query.type,
        direction: query.direction,
        skip: query.skip,
        take: query.take,
      },
    },
  );
}
