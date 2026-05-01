/**
 * Состояния форм для блока «Потребность цеха».
 *
 * Вынесено из `./actions.ts`, потому что файл с `'use server'` в
 * Next.js может экспортировать только async-функции (типы должны
 * жить в обычном модуле).
 */

export interface UpdateWorkshopNeedState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateWorkshopNeedState: UpdateWorkshopNeedState = {};

export interface CalculateWorkshopNeedsState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorCode?: string;
  /** Если backend вернул `WORKSHOP_NEEDS_ALREADY_REVIEWED`. */
  alreadyReviewed?: boolean;
  /** Сводка результата расчёта (для toast). */
  summary?: {
    count: number;
    methods: { AREA_DENSITY: number; QTY_PER_UNIT: number };
    warnings: string[];
  };
}

export const initialCalculateWorkshopNeedsState: CalculateWorkshopNeedsState = {};

export interface CancelWorkshopNeedState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialCancelWorkshopNeedState: CancelWorkshopNeedState = {};
