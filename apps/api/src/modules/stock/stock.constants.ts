/**
 * Типы движений склада (foundation). Хранятся строкой в БД —
 * расширение без миграции.
 *
 * `TRANSFER` — пара `StockMovement` (`OUT` + `IN`), создаваемая
 * `StockService.createTransfer` при перемещении остатка между
 * складами / ячейками (см. `apps/api/src/modules/stock/stock.controller.ts`,
 * UI `/admin/warehouses?tab=balances`, кнопка «Переместить»).
 */
export const STOCK_MOVEMENT_TYPE = {
  PURCHASE_RECEIPT: 'PURCHASE_RECEIPT',
  MATERIAL_ISSUE: 'MATERIAL_ISSUE',
  ADJUSTMENT: 'ADJUSTMENT',
  REVERSAL: 'REVERSAL',
  TRANSFER: 'TRANSFER',
} as const;
export type StockMovementType =
  (typeof STOCK_MOVEMENT_TYPE)[keyof typeof STOCK_MOVEMENT_TYPE];

export const STOCK_MOVEMENT_DIRECTION = {
  IN: 'IN',
  OUT: 'OUT',
} as const;
export type StockMovementDirection =
  (typeof STOCK_MOVEMENT_DIRECTION)[keyof typeof STOCK_MOVEMENT_DIRECTION];

export const STOCK_MOVEMENT_TYPES = Object.values(STOCK_MOVEMENT_TYPE);
export const STOCK_MOVEMENT_DIRECTIONS = Object.values(
  STOCK_MOVEMENT_DIRECTION,
);
