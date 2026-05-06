/**
 * Серверные обёртки над `/api/warehouses` и `/api/cells/:id/print`
 * (см. `docs/api.md §15`). Используются из RSC `/admin/warehouses` и
 * server actions создания/редактирования склада / привязки ячейки.
 */
import type {
  CreateWarehouseDto,
  CreateWarehouseLineDto,
  CreateWarehouseLineResultDto,
  PrintWarehouseCellsDto,
  PrintWarehouseCellsResultDto,
  UpdateCellDto,
  UpdateWarehouseDto,
  WarehouseDetailDto,
  WarehouseSummaryDto,
} from '@sewing/shared/warehouses';
import { apiFetch } from './api';

// URL-хелперы вынесены в client-safe модуль, чтобы их могли импортировать
// клиентские компоненты (например, превью этикеток bulk-print). Здесь
// re-export ради обратной совместимости с существующими server-импортами.
export { buildCellPrintUrl, buildCellQrImageUrl } from './warehouses-urls';

export function listWarehouses(): Promise<WarehouseSummaryDto[]> {
  return apiFetch<WarehouseSummaryDto[]>('/warehouses', {
    cache: 'no-store',
  });
}

export function getWarehouse(id: string): Promise<WarehouseDetailDto> {
  return apiFetch<WarehouseDetailDto>(
    `/warehouses/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createWarehouse(
  body: CreateWarehouseDto,
): Promise<WarehouseDetailDto> {
  return apiFetch<WarehouseDetailDto>('/warehouses', {
    method: 'POST',
    body,
  });
}

export function updateWarehouse(
  id: string,
  body: UpdateWarehouseDto,
): Promise<WarehouseDetailDto> {
  return apiFetch<WarehouseDetailDto>(
    `/warehouses/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

/**
 * Массовое создание ячеек через линию. См. `docs/api.md §15`.
 * Использует `POST /api/warehouses/:id/lines`.
 */
export function createWarehouseLine(
  warehouseId: string,
  body: CreateWarehouseLineDto,
): Promise<CreateWarehouseLineResultDto> {
  return apiFetch<CreateWarehouseLineResultDto>(
    `/warehouses/${encodeURIComponent(warehouseId)}/lines`,
    { method: 'POST', body },
  );
}

/**
 * Привязка/отвязка ячейки от склада через PATCH /api/cells/:id.
 * Используется на `/admin/warehouses/[id]` для блока «Привязать ячейку».
 */
export function updateCellWarehouse(
  cellId: string,
  body: UpdateCellDto,
) {
  return apiFetch<unknown>(`/cells/${encodeURIComponent(cellId)}`, {
    method: 'PATCH',
    body,
  });
}

/**
 * Массовая печать «Печать всех ячеек» (см. `docs/api.md §15`).
 * Использует `POST /api/warehouses/:id/print-cells`.
 */
export function printWarehouseCells(
  warehouseId: string,
  body: PrintWarehouseCellsDto,
): Promise<PrintWarehouseCellsResultDto> {
  return apiFetch<PrintWarehouseCellsResultDto>(
    `/warehouses/${encodeURIComponent(warehouseId)}/print-cells`,
    { method: 'POST', body },
  );
}

/**
 * Печать всех ячеек одной линии. Использует
 * `POST /api/warehouses/:id/lines/:lineId/print-cells`.
 */
export function printWarehouseLineCells(
  warehouseId: string,
  lineId: string,
  body: PrintWarehouseCellsDto,
): Promise<PrintWarehouseCellsResultDto> {
  return apiFetch<PrintWarehouseCellsResultDto>(
    `/warehouses/${encodeURIComponent(warehouseId)}/lines/${encodeURIComponent(
      lineId,
    )}/print-cells`,
    { method: 'POST', body },
  );
}

/**
 * Удаление линии склада с защитой по «занятости» ячеек. Использует
 * `DELETE /api/warehouses/:id/lines/:lineId`. 204 — успех; 409
 * `WAREHOUSE_LINE_HAS_CONTENT` — есть ячейки с содержимым.
 */
export function deleteWarehouseLine(
  warehouseId: string,
  lineId: string,
): Promise<unknown> {
  return apiFetch<unknown>(
    `/warehouses/${encodeURIComponent(warehouseId)}/lines/${encodeURIComponent(
      lineId,
    )}`,
    { method: 'DELETE' },
  );
}
