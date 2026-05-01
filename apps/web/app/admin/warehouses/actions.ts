'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type {
  PrintWarehouseCellsDto,
  PrintWarehouseCellsResultDto,
} from '@sewing/shared/warehouses';
import { ApiRequestError } from '@/lib/api';
import {
  createWarehouse,
  createWarehouseLine,
  printWarehouseCells,
  updateCellWarehouse,
  updateWarehouse,
} from '@/lib/warehouses-api';
import type {
  AssignCellState,
  CreateLineState,
  CreateWarehouseState,
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
