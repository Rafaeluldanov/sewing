/**
 * Серверные обёртки над Nest API «Параметры техкарты в заказе»
 * (`/api/orders/:id/tech-card-parameters`). Контракт —
 * `@sewing/shared/order-tech-cards`, бэкенд —
 * `apps/api/src/modules/order-tech-card/*`.
 *
 * Все write-эндпоинты возвращают свежий полный DTO — UI обновляет состояние
 * из одного источника (тот же приём, что в `colorways-api.ts`).
 */

import type {
  CreateOrderTechCardParameterDto,
  OrderTechCardParametersDto,
  SaveOrderTechCardAsTemplateDto,
  SetOrderTechCardParameterValueDto,
} from '@sewing/shared/order-tech-cards';
import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';

import { apiFetch } from './api';

const base = (orderId: string) =>
  `/orders/${encodeURIComponent(orderId)}/tech-card-parameters`;

export function getOrderTechCardParameters(
  orderId: string,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(base(orderId), {
    cache: 'no-store',
  });
}

export function setOrderTechCardParameterValue(
  orderId: string,
  parameterId: string,
  body: SetOrderTechCardParameterValueDto,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `${base(orderId)}/${encodeURIComponent(parameterId)}`,
    { method: 'PATCH', body },
  );
}

/** Разовое копирование значения в остальные расцветки (не связь). */
export function applyOrderTechCardParameterToAll(
  orderId: string,
  parameterId: string,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `${base(orderId)}/${encodeURIComponent(parameterId)}/apply-to-all-variants`,
    { method: 'POST' },
  );
}

export function createOrderTechCardParameter(
  orderId: string,
  body: CreateOrderTechCardParameterDto,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(base(orderId), {
    method: 'POST',
    body,
  });
}

export function deleteOrderTechCardParameter(
  orderId: string,
  parameterId: string,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `${base(orderId)}/${encodeURIComponent(parameterId)}`,
    { method: 'DELETE' },
  );
}

/** Вынести техкарту расцветки в справочник как новый шаблон. */
export function saveOrderTechCardAsTemplate(
  orderId: string,
  body: SaveOrderTechCardAsTemplateDto,
): Promise<TechCardTemplateDetailDto> {
  return apiFetch<TechCardTemplateDetailDto>(
    `/orders/${encodeURIComponent(orderId)}/tech-card/save-as-template`,
    { method: 'POST', body },
  );
}
