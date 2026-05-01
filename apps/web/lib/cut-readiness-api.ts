/**
 * Серверная обёртка над `/api/orders/:orderId/cut-readiness`
 * (см. модуль `apps/api/src/modules/cut-readiness/*`,
 * `docs/recon-soft-integration.md §«Этап 8А»`).
 *
 * Используется RSC-блоком «Готовность к крою» в карточке заказа
 * (`apps/web/components/orders/cut-readiness-card.tsx`). Контракт
 * — `CutReadinessDto` из `@sewing/shared/cut-readiness`. Запрос
 * `cache: 'no-store'`, чтобы каждый рендер карточки видел
 * актуальное состояние поступлений / потребности.
 */
import type { CutReadinessDto } from '@sewing/shared/cut-readiness';
import { apiFetch } from './api';

export function getOrderCutReadiness(
  orderId: string,
): Promise<CutReadinessDto> {
  return apiFetch<CutReadinessDto>(
    `/orders/${encodeURIComponent(orderId)}/cut-readiness`,
    { cache: 'no-store' },
  );
}
