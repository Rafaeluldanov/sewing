/**
 * Сборка данных для `OrderRouteOverridesEditor` — редактора расценок,
 * норм времени и способа оплаты операций ВНУТРИ заказа
 * (`PUT /orders/:id/route-overrides`).
 *
 * Живёт отдельно от самого редактора, потому что поверхностей две:
 *   - вкладка «Операции» карточки заказа (`OrderOperationsUnifiedTable`) —
 *     у неё детали операций уже загружены для таблицы;
 *   - вкладка «Расценки» окна «Изменить маршрут» / «Изменить в
 *     производстве» (`RatesAmendmentTab`) — там их надо догрузить.
 *
 * Источник истины — снимок маршрута заказа (`order.routeSteps`); из
 * справочника операций берутся только ДЕФОЛТЫ (placeholder и валидация).
 */

import type { OperationDetailDto } from '@sewing/shared/operations';
import type { OrderDetailDto } from '@sewing/shared/orders';
import { getOperation } from '@/lib/operations-api';
import type {
  RouteOverrideEditorSize,
  RouteOverrideEditorStep,
} from './order-route-overrides-editor';

/**
 * Заказ нельзя редактировать (расценки/нормы операций) в финальных
 * статусах — совпадает с гейтом бэкенда `updateRouteOverrides`.
 */
const LOCKED_STATUSES = new Set(['DONE', 'CANCELLED']);

export function canEditRouteOverrides(status: string): boolean {
  return !LOCKED_STATUSES.has(status);
}

/** Размеры заказа в порядке размерного ряда (колонки поразмерной сетки). */
export function buildRouteOverrideEditorSizes(
  order: OrderDetailDto,
): RouteOverrideEditorSize[] {
  const m = new Map<string, { id: string; code: string; sortOrder: number }>();
  for (const it of order.items) {
    if (!m.has(it.sizeId)) {
      m.set(it.sizeId, {
        id: it.sizeId,
        code: it.sizeCode,
        sortOrder: it.sizeSortOrder,
      });
    }
  }
  return [...m.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ id, code }) => ({ id, code }));
}

/**
 * Строки редактора: снимок маршрута заказа + дефолты операции из
 * справочника. Операции, которую не удалось загрузить, строка не теряет —
 * просто остаётся без дефолтов (placeholder пустой).
 */
export function buildRouteOverrideEditorSteps(
  order: OrderDetailDto,
  operationsById: ReadonlyMap<string, OperationDetailDto>,
): RouteOverrideEditorStep[] {
  return [...order.routeSteps]
    .sort((a, b) => a.index - b.index)
    .map((step) => {
      const op = operationsById.get(step.operationId) ?? null;
      const ratesBySize: Record<string, number> = {};
      const timeNormsBySize: Record<string, number> = {};
      if (op) {
        for (const r of op.ratesBySize) ratesBySize[r.sizeId] = Number(r.rate);
        for (const t of op.timeNormsBySize) {
          timeNormsBySize[t.sizeId] = Number(t.seconds);
        }
      }
      const sizeOverrides: Record<
        string,
        { rate: number | null; seconds: number | null }
      > = {};
      for (const o of step.sizeOverrides) {
        sizeOverrides[o.sizeId] = { rate: o.rate, seconds: o.seconds };
      }
      return {
        stepId: step.id,
        rowNumber: step.index + 1,
        operationName: step.operationName,
        operationCode: step.operationCode,
        pricingMode: op?.pricingMode ?? null,
        timeNormMode: op?.timeNormMode ?? null,
        fixedRate: op?.fixedRate != null ? Number(op.fixedRate) : null,
        timeNormSec: op?.timeNormSec ?? null,
        ratesBySize,
        timeNormsBySize,
        pricingModeOverride: step.pricingModeOverride,
        rateOverride: step.rateOverride,
        timeNormSecOverride: step.timeNormSecOverride,
        sizeOverrides,
      };
    });
}

/**
 * Полная загрузка данных редактора для поверхности, у которой деталей
 * операций ещё нет (окно правки маршрута). `null` — редактор показывать
 * нечего или незачем: финальный статус либо пустой маршрут. Ошибку
 * загрузки отдельной операции глотаем: строка останется без дефолтов, но
 * вкладка не пропадёт.
 */
export async function loadRouteOverridesEditorData(
  order: OrderDetailDto,
): Promise<{
  sizes: RouteOverrideEditorSize[];
  steps: RouteOverrideEditorStep[];
} | null> {
  if (!canEditRouteOverrides(order.status)) return null;
  if (order.routeSteps.length === 0) return null;

  const operationsById = new Map<string, OperationDetailDto>();
  const uniqueIds = Array.from(
    new Set(order.routeSteps.map((s) => s.operationId)),
  );
  await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        operationsById.set(id, await getOperation(id));
      } catch {
        // Дефолтов у строки не будет — редактор от этого не ломается.
      }
    }),
  );

  return {
    sizes: buildRouteOverrideEditorSizes(order),
    steps: buildRouteOverrideEditorSteps(order, operationsById),
  };
}
