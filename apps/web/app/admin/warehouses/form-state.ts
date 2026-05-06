// Состояния форм и initial-значения для server actions из `./actions.ts`.
//
// Файл с `'use server'` обязан экспортировать ТОЛЬКО async-функции
// (Next.js 14+: «A "use server" file can only export async functions»).
// Поэтому объекты-константы и связанные интерфейсы вынесены сюда —
// клиентские формы импортируют их напрямую без накладных расходов.

export interface CreateWarehouseState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateWarehouseState: CreateWarehouseState = {};

export interface UpdateWarehouseState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateWarehouseState: UpdateWarehouseState = {};

export interface AssignCellState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialAssignCellState: AssignCellState = {};

export interface CreateLineState {
  ok?: boolean;
  /** Краткое сообщение «создано N ячеек кодом X1..XN» — показываем после успеха. */
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateLineState: CreateLineState = {};

/**
 * Состояние «удаление линии». UI показывает сообщение при
 * `WAREHOUSE_LINE_HAS_CONTENT` — backend уже формирует
 * человекочитаемый текст с кодами «занятых» ячеек.
 */
export interface DeleteLineState {
  ok?: boolean;
  /** Машинный код ошибки backend — UI ветвит отображение. */
  code?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialDeleteLineState: DeleteLineState = {};

/**
 * Состояние формы «Корректировка остатка»
 * (`/admin/warehouses?tab=balances` → кнопка «Корректировка», см.
 * `apps/web/components/warehouses/stock/stock-adjustment-dialog.tsx`,
 * `createStockAdjustmentAction` в `./actions.ts`).
 *
 * `code` нужен, чтобы UI отдельно отрисовывал нехватку остатка
 * (`MATERIAL_STOCK_INSUFFICIENT`) от прочих 4xx/5xx — текст уже
 * содержит конкретные `requestedQty` / `availableQty` от backend.
 */
export interface StockAdjustmentState {
  ok?: boolean;
  error?: string;
  /** Машинный код ошибки backend — UI может ветвить отображение. */
  code?: string;
  errorRequestId?: string;
  /** Id созданного `StockMovement` — может быть полезно для тестов / автоматики. */
  createdId?: string;
}

export const initialStockAdjustmentState: StockAdjustmentState = {};
