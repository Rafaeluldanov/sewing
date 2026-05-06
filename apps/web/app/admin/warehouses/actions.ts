'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type {
  PrintWarehouseCellsDto,
  PrintWarehouseCellsResultDto,
} from '@sewing/shared/warehouses';
import { ApiRequestError } from '@/lib/api';
import { listCells } from '@/lib/passports-api';
import {
  createStockAdjustment,
  createStockTransfer,
  type CreateStockAdjustmentDto,
  type CreateStockTransferDto,
} from '@/lib/stock-api';
import {
  createWarehouse,
  createWarehouseLine,
  deleteWarehouseLine,
  printWarehouseCells,
  printWarehouseLineCells,
  updateCellWarehouse,
  updateWarehouse,
} from '@/lib/warehouses-api';
import type {
  AssignCellState,
  CreateLineState,
  CreateWarehouseState,
  DeleteLineState,
  StockAdjustmentState,
  StockTransferState,
  UpdateWarehouseState,
} from './form-state';

/**
 * Server action для создания склада. После успеха ревалидируем
 * `/admin/warehouses` и редиректим на карточку нового склада, чтобы
 * менеджер сразу мог привязать к нему ячейки (см. `docs/screens.md §10b`).
 */
export async function createWarehouseAction(
  _prev: CreateWarehouseState,
  form: FormData,
): Promise<CreateWarehouseState> {
  const name = String(form.get('name') ?? '').trim();
  const code = String(form.get('code') ?? '').trim();
  if (name.length === 0) {
    return { error: 'Введите название склада' };
  }
  let createdId: string | null = null;
  try {
    const created = await createWarehouse({
      name,
      code: code.length > 0 ? code : null,
    });
    createdId = created.id;
    revalidatePath('/admin/warehouses');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать склад' };
  }
  // redirect выбрасывает специальный NEXT_REDIRECT — выносим за try,
  // чтобы catch его не перехватил.
  if (createdId) {
    redirect(`/admin/warehouses/${createdId}`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Update warehouse meta
// ---------------------------------------------------------------------------

export async function updateWarehouseAction(
  warehouseId: string,
  _prev: UpdateWarehouseState,
  form: FormData,
): Promise<UpdateWarehouseState> {
  const name = String(form.get('name') ?? '').trim();
  const code = String(form.get('code') ?? '');
  const isActive = form.get('isActive') === 'on';
  const labelTemplate = String(form.get('labelTemplate') ?? '');

  if (name.length === 0) {
    return { error: 'Введите название склада' };
  }

  try {
    await updateWarehouse(warehouseId, {
      name,
      code,
      isActive,
      labelTemplate,
    });
    revalidatePath('/admin/warehouses');
    revalidatePath(`/admin/warehouses/${warehouseId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить склад' };
  }
}

// ---------------------------------------------------------------------------
// Assign cell to warehouse (привязка / отвязка)
// ---------------------------------------------------------------------------

/**
 * Привязка ячейки к складу — server action поверх `PATCH /api/cells/:id`.
 * `cellId` приходит из FormData (select на странице склада). Если
 * `cellId` пуст — no-op c понятной ошибкой, чтобы UI не давал
 * привязать «ничего».
 */
export async function assignCellToWarehouseAction(
  warehouseId: string,
  _prev: AssignCellState,
  form: FormData,
): Promise<AssignCellState> {
  const cellId = String(form.get('cellId') ?? '').trim();
  if (cellId.length === 0) {
    return { error: 'Выберите ячейку' };
  }
  try {
    await updateCellWarehouse(cellId, { warehouseId });
    revalidatePath('/admin/warehouses');
    revalidatePath(`/admin/warehouses/${warehouseId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось привязать ячейку' };
  }
}

/**
 * Отвязка ячейки от склада — `PATCH /api/cells/:id` c `warehouseId: null`.
 * Сама ячейка остаётся существовать (см. ADR-0019), просто перестаёт
 * принадлежать складу — менеджер может позже подвесить её на другой.
 */
// ---------------------------------------------------------------------------
// Create warehouse line (массовое создание ячеек)
// ---------------------------------------------------------------------------

/**
 * Server action поверх `POST /api/warehouses/:id/lines`.
 * Преобразует FormData (`code`, `count`) в нормальный JSON-вызов
 * и показывает менеджеру результат — сколько ячеек было создано.
 */
export async function createWarehouseLineAction(
  warehouseId: string,
  _prev: CreateLineState,
  form: FormData,
): Promise<CreateLineState> {
  const code = String(form.get('code') ?? '').trim();
  const countRaw = String(form.get('count') ?? '').trim();
  const count = Number.parseInt(countRaw, 10);

  if (code.length === 0) {
    return { error: 'Введите код линии' };
  }
  if (!Number.isFinite(count) || count <= 0) {
    return { error: 'Введите положительное количество ячеек' };
  }

  try {
    const result = await createWarehouseLine(warehouseId, { code, count });
    revalidatePath('/admin/warehouses');
    revalidatePath(`/admin/warehouses/${warehouseId}`);
    const first = result.cells[0]?.code ?? `${code}1`;
    const last = result.cells[result.cells.length - 1]?.code ?? `${code}${count}`;
    return {
      ok: true,
      successMessage: `Создана линия «${result.line.code}» и ${result.cells.length} ячеек: ${first}…${last}.`,
    };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать линию' };
  }
}

export async function detachCellFromWarehouseAction(
  warehouseId: string,
  cellId: string,
): Promise<AssignCellState> {
  try {
    await updateCellWarehouse(cellId, { warehouseId: null });
    revalidatePath('/admin/warehouses');
    revalidatePath(`/admin/warehouses/${warehouseId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось отвязать ячейку' };
  }
}

// ---------------------------------------------------------------------------
// Bulk print: «Печать всех ячеек» (см. `docs/api.md §15`)
// ---------------------------------------------------------------------------

export interface PrintWarehouseCellsActionResult {
  ok: boolean;
  /** Сводка успеха для UI (количество ячеек/копий/job-ов). */
  result?: PrintWarehouseCellsResultDto;
  /** Машинный код ошибки backend-а — UI решает, как отрисовать. */
  code?: string;
  error?: string;
  errorRequestId?: string;
}

/**
 * Server action поверх `POST /api/warehouses/:id/print-cells`. Принимает
 * нормализованный body (printerId/copies/labelSize) и возвращает
 * структурированный результат, чтобы клиентская модалка могла
 * показать success-state со счётчиком job-ов или ошибку с кодом.
 */
export async function printWarehouseCellsAction(
  warehouseId: string,
  input: PrintWarehouseCellsDto,
): Promise<PrintWarehouseCellsActionResult> {
  try {
    const result = await printWarehouseCells(warehouseId, input);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        code: e.code,
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { ok: false, error: 'Не удалось поставить задания на печать' };
  }
}

/**
 * Server action поверх `POST /api/warehouses/:id/lines/:lineId/print-cells` —
 * печать всех активных ячеек ОДНОЙ линии. Возвращаемая форма
 * совпадает с `printWarehouseCellsAction`, чтобы UI-модалка могла
 * быть универсальной.
 */
export async function printWarehouseLineCellsAction(
  warehouseId: string,
  lineId: string,
  input: PrintWarehouseCellsDto,
): Promise<PrintWarehouseCellsActionResult> {
  try {
    const result = await printWarehouseLineCells(warehouseId, lineId, input);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        code: e.code,
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { ok: false, error: 'Не удалось поставить задания на печать' };
  }
}

// ---------------------------------------------------------------------------
// Delete warehouse line (вариант с защитой по «занятости» ячеек)
// ---------------------------------------------------------------------------

/**
 * Server action поверх `DELETE /api/warehouses/:id/lines/:lineId`.
 * Возвращает `code` отдельно, чтобы UI отличил `WAREHOUSE_LINE_HAS_CONTENT`
 * (заняты ячейки) от прочих 4xx/5xx. После успеха ревалидируем
 * страницу склада — таблицы линий и ячеек обновятся.
 */
export async function deleteWarehouseLineAction(
  warehouseId: string,
  lineId: string,
): Promise<DeleteLineState> {
  try {
    await deleteWarehouseLine(warehouseId, lineId);
    revalidatePath('/admin/warehouses');
    revalidatePath(`/admin/warehouses/${warehouseId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        code: e.code,
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось удалить линию' };
  }
}

// ---------------------------------------------------------------------------
// Stock adjustment (manual): `POST /api/stock/adjustments`
// (см. `apps/api/src/modules/stock/stock.controller.ts`,
//  `apps/web/components/warehouses/stock/stock-adjustment-dialog.tsx`,
//  `docs/api.md §«26a.3 POST /api/stock/adjustments»`).
// ---------------------------------------------------------------------------

/**
 * Server action ручной корректировки остатка. Принимает уже
 * нормализованный body и просто делегирует в `createStockAdjustment`.
 * Идемпотентность реализована backend-ом по `clientRequestId` —
 * клиент в диалоге сам генерирует uuid и присылает один и тот же
 * при повторных submit.
 *
 * После успеха ревалидируем `/admin/warehouses` (вкладки `balances`
 * и `movements` живут на одной странице с разным `?tab=`), чтобы
 * корректировка появилась и в остатках, и в журнале движений.
 *
 * `MATERIAL_STOCK_INSUFFICIENT` (409) возвращается с `code` —
 * клиентский диалог отрисовывает понятный текст backend без raw JSON.
 */
export async function createStockAdjustmentAction(
  body: CreateStockAdjustmentDto,
): Promise<StockAdjustmentState> {
  try {
    const movement = await createStockAdjustment(body);
    revalidatePath('/admin/warehouses');
    return { ok: true, createdId: movement.id };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        code: e.code,
        error: e.message,
        errorRequestId: e.requestId,
      };
    }
    return { ok: false, error: 'Не удалось сохранить корректировку остатка.' };
  }
}

// ---------------------------------------------------------------------------
// Stock transfer (manual): `POST /api/stock/transfers`
// (см. `apps/api/src/modules/stock/stock.controller.ts`,
//  `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`,
//  `docs/api.md §«26a.4 POST /api/stock/transfers»`).
// ---------------------------------------------------------------------------

/**
 * Server action перемещения остатка между складами / ячейками.
 * Принимает уже нормализованный body (qty / comment / clientRequestId)
 * и делегирует в `createStockTransfer`. Идемпотентность реализована
 * backend-ом по `clientRequestId` — UI-диалог сам генерирует uuid и
 * присылает один и тот же при повторных submit.
 *
 * После успеха ревалидируем `/admin/warehouses` (вкладки `balances` и
 * `movements` живут на одной странице с разным `?tab=`), чтобы оба
 * движения появились в журнале и обновились остатки.
 *
 * `MATERIAL_STOCK_INSUFFICIENT` / `STOCK_TRANSFER_SAME_LOCATION` /
 * `STOCK_BALANCE_NOT_FOUND` приходят с `code` — клиентский диалог
 * отрисовывает понятный текст backend без raw JSON.
 */
export async function createStockTransferAction(
  body: CreateStockTransferDto,
): Promise<StockTransferState> {
  try {
    const result = await createStockTransfer(body);
    revalidatePath('/admin/warehouses');
    return { ok: true, transferId: result.transferId };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        code: e.code,
        error: e.message,
        errorRequestId: e.requestId,
      };
    }
    return { ok: false, error: 'Не удалось сохранить перемещение остатка.' };
  }
}

// ---------------------------------------------------------------------------
// Cells lookup (for transfer destination cell selector)
// ---------------------------------------------------------------------------

/**
 * Минимальная карточка ячейки для select-а в `StockTransferDialog`
 * (см. `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`).
 * Берём только то, что показывает selectbox — `id` + `code` (опционально
 * `qrCode` оставляем, чтобы не плодить отдельных DTO). `warehouse`
 * уже отфильтрован на backend через `?warehouseId=…`.
 */
export interface TransferDestinationCellOption {
  id: string;
  code: string;
}

export interface LoadTransferDestinationCellsResult {
  ok: boolean;
  cells?: TransferDestinationCellOption[];
  error?: string;
  code?: string;
}

/**
 * Server action для динамической подгрузки ячеек выбранного склада
 * назначения в форме «Переместить».
 *
 * Контракт:
 *   - `warehouseId` пустой / не задан → возвращаем пустой массив без
 *     запроса в backend (UI знает «склад ещё не выбран»);
 *   - иначе зовём `GET /api/cells?warehouseId=<id>` и нормализуем
 *     ответ до минимального shape `{ id, code }`. Только активные
 *     ячейки этого склада (фильтрация — на backend).
 *   - сетевые / API-ошибки оборачиваем в `{ ok: false, error, code }`,
 *     чтобы клиентский диалог отрисовал понятный fallback вместо
 *     raw-JSON.
 *
 * Не используется кэширование — список ячеек меняется редко, но
 * пользователь после привязки/отвязки ячейки на `/admin/warehouses/[id]`
 * должен сразу увидеть актуальное содержимое selectbox-а.
 */
export async function loadTransferDestinationCellsAction(
  warehouseId: string,
): Promise<LoadTransferDestinationCellsResult> {
  const wid = warehouseId.trim();
  if (wid.length === 0) {
    return { ok: true, cells: [] };
  }
  try {
    const cells = await listCells({ warehouseId: wid });
    return {
      ok: true,
      cells: cells.map((c) => ({ id: c.id, code: c.code })),
    };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, code: e.code, error: e.message };
    }
    return { ok: false, error: 'Не удалось загрузить список ячеек.' };
  }
}
