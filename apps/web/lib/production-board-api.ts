/**
 * Серверные обёртки над Nest API «Доски движения тиража» (кабинет
 * мастера). Контракт — `apps/api/src/modules/production-board/*`,
 * `@sewing/shared` (`production-board.ts`). Используются из server
 * actions (`apps/web/app/master/production-board-actions.ts`).
 */

import type {
  ProductionBoardDrillDto,
  ProductionBoardDrillQuery,
  ProductionBoardDto,
} from '@sewing/shared';
import { apiFetch } from './api';

export function getProductionBoard(days: number): Promise<ProductionBoardDto> {
  return apiFetch<ProductionBoardDto>('/master/production-board', {
    cache: 'no-store',
    searchParams: { days },
  });
}

export function getProductionBoardDrill(
  query: ProductionBoardDrillQuery,
): Promise<ProductionBoardDrillDto> {
  return apiFetch<ProductionBoardDrillDto>('/master/production-board/drill', {
    cache: 'no-store',
    searchParams: {
      cutDate: query.cutDate,
      stage: query.stage,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    },
  });
}
