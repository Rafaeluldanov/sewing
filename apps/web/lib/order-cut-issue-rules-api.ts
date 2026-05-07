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
 * Отключить одну конкретную очередь выдачи кроя
 * (`POST /api/orders/:id/cut-issue-rules/queues/:queueIndex/disable`).
 * `isActive = false` для всех её активных строк, `issuedQty`
 * сохраняется. Идемпотентно.
 */
export function disableOrderCutIssueQueue(
  orderId: string,
  queueIndex: number,
): Promise<OrderCutIssueRulesSummaryDto> {
  return apiFetch<OrderCutIssueRulesSummaryDto>(
    `/orders/${encodeURIComponent(orderId)}/cut-issue-rules/queues/${queueIndex}/disable`,
    { method: 'POST', body: {} },
  );
}
