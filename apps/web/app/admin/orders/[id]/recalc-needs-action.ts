'use server';

/**
 * Явный пересчёт потребности заказа из плашки «потребность устарела».
 *
 * Первый заход идёт без `force`: если закупщик строк не трогал, пересчёт
 * пройдёт тихо и отметка снимется сама. Отбилось по `WORKSHOP_NEEDS_ALREADY_
 * REVIEWED` — возвращаем `needsForce`, и UI спрашивает подтверждение, показав,
 * что именно будет затёрто. Насильно с первого раза не пересчитываем никогда.
 */

import { revalidatePath } from 'next/cache';

import { calculateOrderWorkshopNeeds } from '@/lib/workshop-needs-api';

export interface RecalcNeedsActionResult {
  ok: boolean;
  error: string;
  /** Отбилось из-за строк в работе — можно предложить force. */
  needsForce: boolean;
}

export async function recalcOrderNeedsAction(
  orderId: string,
  force: boolean,
): Promise<RecalcNeedsActionResult> {
  try {
    await calculateOrderWorkshopNeeds(orderId, { force });
    revalidatePath(`/admin/orders/${orderId}`);
    return { ok: true, error: '', needsForce: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Не удалось пересчитать';
    // Код ошибки приходит в тексте ответа API — отдельного поля у apiFetch нет.
    const reviewed =
      message.includes('WORKSHOP_NEEDS_ALREADY_REVIEWED') ||
      message.toLowerCase().includes('уже');
    return { ok: false, error: message, needsForce: !force && reviewed };
  }
}
