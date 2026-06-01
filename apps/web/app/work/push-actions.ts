'use server';

import { ApiRequestError } from '@/lib/api';
import {
  getPushPublicKey,
  removePushSubscription,
  savePushSubscription,
  type BrowserPushSubscription,
} from '@/lib/push-api';

/**
 * Server actions Web Push для seamstress flow на /work. Тонкие
 * прокси к Nest API (`/push/*`) с fail-soft нормализацией ошибок —
 * клиентский код (`use-rework-push.ts`) получает простые
 * `{ ok }`-результаты вместо исключений.
 */

export async function getPushPublicKeyAction(): Promise<{
  key: string;
  enabled: boolean;
} | null> {
  try {
    return await getPushPublicKey();
  } catch (e) {
    if (e instanceof ApiRequestError) return null;
    throw e;
  }
}

export async function savePushSubscriptionAction(
  subscription: BrowserPushSubscription,
): Promise<{ ok: boolean }> {
  try {
    await savePushSubscription(subscription);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) return { ok: false };
    throw e;
  }
}

export async function removePushSubscriptionAction(
  endpoint: string,
): Promise<{ ok: boolean }> {
  try {
    await removePushSubscription(endpoint);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) return { ok: false };
    throw e;
  }
}
