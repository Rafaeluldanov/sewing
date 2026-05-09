/**
 * Барелл компонентов вкладок «Остатки» / «Движения» в разделе
 * `/admin/warehouses` (см. `WarehouseStockTabs`,
 * `apps/web/app/admin/warehouses/page.tsx`).
 */
export {
  WarehouseStockTabs,
  parseWarehouseStockTab,
  type WarehouseStockTab,
} from './warehouse-stock-tabs';
export { StockBalancesTable } from './stock-balances-table';
export { StockMovementsTable } from './stock-movements-table';
export { StockPagination } from './stock-pagination';
export { StockDirectionBadge } from './stock-direction-badge';
export { StockMovementTypeBadge } from './stock-movement-type-badge';
export { StockAdjustmentButton } from './stock-adjustment-button';
export { StockAdjustmentDialog } from './stock-adjustment-dialog';
export { StockTransferButton } from './stock-transfer-button';
export { StockTransferDialog } from './stock-transfer-dialog';
export {
  StockBalancesFilters,
  parseStockBalanceState,
  stockStateToApiFlags,
  type StockBalanceState,
} from './stock-balances-filters';
export {
  StockMovementsFilters,
  parseUnifiedMovementType,
  routeMovementTypeToScope,
  UNIFIED_MOVEMENT_TYPE_OPTIONS,
  type UnifiedMovementType,
  type UnifiedMovementScope,
} from './stock-movements-filters';
export {
  WAREHOUSES_UNIFIED_FETCH_LIMIT,
  applyUnifiedPagination,
  finishedGoodsBalanceToUnified,
  finishedGoodsMovementToUnified,
  materialBalanceToUnified,
  materialMovementToUnified,
  workInProgressBalanceToUnified,
  workInProgressMovementToUnified,
  sortUnifiedBalances,
  sortUnifiedMovements,
  type UnifiedRowKind,
  type UnifiedWarehouseBalanceRow,
  type UnifiedWarehouseMovementRow,
} from './unified-rows';
