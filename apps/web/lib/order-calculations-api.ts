/**
 * Серверные обёртки над Nest API модуля «Варианты просчёта заказа»
 * (`/api/orders/:id/calculations`). Контракт —
 * `@sewing/shared/order-calculations`, бэкенд —
 * `apps/api/src/modules/order-calculations/*`.
 *
 * Все write-эндпоинты возвращают свежий полный `OrderCalculationsDto`,
 * чтобы UI обновлял ряд вкладок из одного источника.
 */

import type {
  CreateOrderCalculationDto,
  OrderCalculationsDto,
  RenameOrderCalculationDto,
} from '@sewing/shared';
import { apiFetch } from './api';

export function getOrderCalculations(
  orderId: string,
): Promise<OrderCalculationsDto> {
  return apiFetch<OrderCalculationsDto>(
    `/orders/${encodeURIComponent(orderId)}/calculations`,
    { cache: 'no-store' },
  );
}

export function createOrderCalculation(
  orderId: string,
  body: CreateOrderCalculationDto,
): Promise<OrderCalculationsDto> {
  return apiFetch<OrderCalculationsDto>(
    `/orders/${encodeURIComponent(orderId)}/calculations`,
    { method: 'POST', body },
  );
}

export function activateOrderCalculation(
  orderId: string,
  calcId: string,
): Promise<OrderCalculationsDto> {
  return apiFetch<OrderCalculationsDto>(
    `/orders/${encodeURIComponent(orderId)}/calculations/${encodeURIComponent(calcId)}/activate`,
    { method: 'POST' },
  );
}

export function renameOrderCalculation(
  orderId: string,
  calcId: string,
  body: RenameOrderCalculationDto,
): Promise<OrderCalculationsDto> {
  return apiFetch<OrderCalculationsDto>(
    `/orders/${encodeURIComponent(orderId)}/calculations/${encodeURIComponent(calcId)}`,
    { method: 'PATCH', body },
  );
}

export function deleteOrderCalculation(
  orderId: string,
  calcId: string,
): Promise<OrderCalculationsDto> {
  return apiFetch<OrderCalculationsDto>(
    `/orders/${encodeURIComponent(orderId)}/calculations/${encodeURIComponent(calcId)}`,
    { method: 'DELETE' },
  );
}
