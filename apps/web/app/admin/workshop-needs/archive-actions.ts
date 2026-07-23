'use server';

/**
 * Server actions вкладки «Архив» экрана «Потребность цеха».
 *
 * Три императивные операции над заказами ЦЕЛИКОМ (не над отдельной
 * строкой потребности):
 *   - archive — скрыть заказ(ы) из активного списка → «Архив»;
 *   - restore — вернуть из архива;
 *   - purge   — безвозвратно стереть просчёт (только из архива).
 *
 * Вызываются напрямую из клиентских компонентов (`order-archive.tsx`),
 * поэтому это не form-state-экшены, а обычные async-функции с типом
 * результата `ArchiveActionResult`. RBAC — на backend
 * (`@Roles('ADMIN','SHOP_MANAGER')`).
 */

import { revalidatePath } from 'next/cache';
import type { WorkshopNeedArchiveSkipDto } from '@sewing/shared/workshop-needs';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  archiveWorkshopNeedsOrders,
  purgeWorkshopNeedsOrders,
  restoreWorkshopNeedsOrders,
} from '@/lib/workshop-needs-api';

export interface ArchiveActionResult {
  ok: boolean;
  /** Сколько заказов реально обработано. */
  processed: number;
  /** Пропущенные с причиной (частичный успех). */
  skipped: WorkshopNeedArchiveSkipDto[];
  error?: string;
}

async function runArchiveOp(
  op: (orderIds: string[]) => Promise<{
    processed: string[];
    skipped: WorkshopNeedArchiveSkipDto[];
  }>,
  orderIds: string[],
): Promise<ArchiveActionResult> {
  if (!orderIds || orderIds.length === 0) {
    return {
      ok: false,
      processed: 0,
      skipped: [],
      error: 'Не выбрано ни одного заказа.',
    };
  }
  try {
    const res = await op(orderIds);
    revalidatePath('/admin/workshop-needs');
    return { ok: true, processed: res.processed.length, skipped: res.skipped };
  } catch (e) {
    return {
      ok: false,
      processed: 0,
      skipped: [],
      error:
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось выполнить операцию.',
    };
  }
}

export async function archiveWorkshopNeedsAction(
  orderIds: string[],
): Promise<ArchiveActionResult> {
  return runArchiveOp(archiveWorkshopNeedsOrders, orderIds);
}

export async function restoreWorkshopNeedsAction(
  orderIds: string[],
): Promise<ArchiveActionResult> {
  return runArchiveOp(restoreWorkshopNeedsOrders, orderIds);
}

export async function purgeWorkshopNeedsAction(
  orderIds: string[],
): Promise<ArchiveActionResult> {
  return runArchiveOp(purgeWorkshopNeedsOrders, orderIds);
}
