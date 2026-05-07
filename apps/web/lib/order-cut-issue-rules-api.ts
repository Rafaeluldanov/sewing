/**
 * Серверные обёртки над Nest API модуля `order-cut-issue-rules`
 * («Очередь выдачи кроя по размерам внутри заказа»).
 *
 * Контракт — `apps/api/src/modules/order-cut-issue-rules/*`,
 * `@sewing/shared/order-cut-issue-rules`. Используются server actions
 * карточки заказа `/orders/[id]` и страницы admin-варианта.
 */

import type {
  BulkUpsertOrderCutIssueRulesDto,
  DisableOrderCutIssueRulesDto,
  OrderCutIssueRulesSummaryDto,
} from '@sewing/shared';
import { apiFetch } from './api';

export function getOrderCutIssueRules(
  orderId: string,
): Promise<OrderCutIssueRulesSummaryDto> {
  return apiFetch<OrderCutIssueRulesSummaryDto>(
    `/orders/${encodeURIComponent(orderId)}/cut-issue-rules`,
    { cache: 'no-store' },
  );
}

export function saveOrderCutIssueRules(
  orderId: string,
  body: BulkUpsertOrderCutIssueRulesDto,
): Promise<OrderCutIssueRulesSummaryDto> {
  return apiFetch<OrderCutIssueRulesSummaryDto>(
    `/orders/${encodeURIComponent(orderId)}/cut-issue-rules`,
    { method: 'POST', body },
  );
}

export function disableOrderCutIssueRules(
  orderId: string,
  body: DisableOrderCutIssueRulesDto = {},
): Promise<OrderCutIssueRulesSummaryDto> {
  return apiFetch<OrderCutIssueRulesSummaryDto>(
    `/orders/${encodeURIComponent(orderId)}/cut-issue-rules/disable-all`,
    { method: 'POST', body },
  );
}

/**
 * Удалить пустую последнюю очередь выдачи кроя
 * (`DELETE /api/orders/:id/cut-issue-rules/queues/:queueIndex`).
 * Бэкенд защищает: удалить можно только последнюю очередь и только
 * если в ней `Σ issuedQty = 0`.
 */
export function deleteOrderCutIssueQueue(
  orderId: string,
  queueIndex: number,
): Promise<OrderCutIssueRulesSummaryDto> {
  return apiFetch<OrderCutIssueRulesSummaryDto>(
    `/orders/${encodeURIComponent(orderId)}/cut-issue-rules/queues/${queueIndex}`,
    { method: 'DELETE' },
  );
}
