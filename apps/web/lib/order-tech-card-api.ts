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
  CreateOrderTechCardLineDto,
  CreateOrderTechCardLinesDto,
  CreateOrderTechCardParameterDto,
  OrderTechCardParametersDto,
  SaveOrderTechCardAsTemplateDto,
  SetOrderTechCardParameterValueDto,
  UpdateOrderTechCardLineDto,
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

/** Добавить строку материала прямо в заказ (её нет в шаблоне). */
export function createOrderTechCardLine(
  orderId: string,
  body: CreateOrderTechCardLineDto,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `/orders/${encodeURIComponent(orderId)}/tech-card/lines`,
    { method: 'POST', body },
  );
}

/**
 * Завести ПАЧКУ строк: одна транзакция и одна пересборка производных на
 * бэке. По строке за запрос — это N пересборок снимка и потребностей.
 */
export function createOrderTechCardLines(
  orderId: string,
  body: CreateOrderTechCardLinesDto,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `/orders/${encodeURIComponent(orderId)}/tech-card/lines/bulk`,
    { method: 'POST', body },
  );
}

/**
 * Правка строки материала — ЛЮБОЙ, и шаблонной, и ручной («техкарта живёт
 * в заказе», решение 16.07). Ячейку под параметром backend отбивает 409
 * `ORDER_TECH_CARD_CELL_TAKEN` — её правят через значение параметра.
 */
export function updateOrderTechCardLine(
  orderId: string,
  requirementId: string,
  body: UpdateOrderTechCardLineDto,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `/orders/${encodeURIComponent(orderId)}/tech-card/lines/${encodeURIComponent(requirementId)}`,
    { method: 'PATCH', body },
  );
}

/**
 * Убрать строку — любую (решение 16.07). Последнюю шаблонную backend
 * отбивает 409 `ORDER_MATERIAL_LAST_TEMPLATE_LINE` (иначе пересборка молча
 * воскресила бы её).
 */
export function deleteOrderTechCardLine(
  orderId: string,
  requirementId: string,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `/orders/${encodeURIComponent(orderId)}/tech-card/lines/${encodeURIComponent(requirementId)}`,
    { method: 'DELETE' },
  );
}

/**
 * «Обновить из шаблона» — обратный клапан к принципу «шаблон читается один раз».
 * РАЗРУШИТЕЛЬНО: структура строк заказа перезаписывается шаблоном. Значения
 * параметров переживают (они в своей таблице).
 */
export function reloadOrderTechCardFromTemplate(
  orderId: string,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(
    `/orders/${encodeURIComponent(orderId)}/tech-card/reload-from-template`,
    { method: 'POST' },
  );
}

/**
 * «Обновить нормы из номенклатуры» — мягкий брат «Обновить из шаблона»:
 * структуру строк не трогает, только перечитывает числа норм из карточки
 * номенклатуры и снимает отметку «правлено в заказе» (кроме ручных строк).
 */
export function reloadOrderTechCardNorms(
  orderId: string,
): Promise<OrderTechCardParametersDto> {
  return apiFetch<OrderTechCardParametersDto>(
    `/orders/${encodeURIComponent(orderId)}/tech-card/reload-norms`,
    { method: 'POST' },
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
