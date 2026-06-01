/**
 * Серверные обёртки над Nest API модуля Web Push.
 *
 * Как и `shifts-api.ts`, рассчитаны на вызов из server actions
 * (`app/work/push-actions.ts`) — браузер не ходит в API напрямую,
 * cookie форвардится на стороне Next (см. `lib/api.ts`).
 */

import { apiFetch } from './api';

/** Сериализованная браузерная PushSubscription (`subscription.toJSON()`). */
export interface BrowserPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function getPushPublicKey(): Promise<{ key: string; enabled: boolean }> {
  return apiFetch<{ key: string; enabled: boolean }>('/push/public-key');
}

export function savePushSubscription(
  body: BrowserPushSubscription,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/push/subscribe', { method: 'POST', body });
}

export function removePushSubscription(
  endpoint: string,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/push/unsubscribe', {
    method: 'POST',
    body: { endpoint },
  });
}
