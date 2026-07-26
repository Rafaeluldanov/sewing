'use server';

/**
 * Общая обвязка server actions архива для списков админки.
 *
 * Каждый раздел объявляет свои три экспортируемые функции (Next
 * требует, чтобы server action был именованным экспортом файла
 * `'use server'`), а вся повторяющаяся часть — пустой список,
 * разбор ошибки API, `revalidatePath` — живёт здесь.
 *
 * Пример (`app/admin/routes/archive-actions.ts`):
 *
 *   export async function archiveRoutesAction(ids: string[]) {
 *     return runBulkArchiveAction('/route-templates', 'archive', ids, '/admin/routes');
 *   }
 */
import { revalidatePath } from 'next/cache';
import type { BulkArchiveActionResult } from '@/components/admin';
import { ApiRequestError, errorText } from './api';
import { bulkArchiveRequest, type BulkArchiveOp } from './bulk-archive-api';

export async function runBulkArchiveAction(
  apiBasePath: string,
  op: BulkArchiveOp,
  ids: string[],
  revalidate: string | string[],
): Promise<BulkArchiveActionResult> {
  if (!ids || ids.length === 0) {
    return {
      ok: false,
      processed: 0,
      skipped: [],
      error: 'Не выбрано ни одной записи.',
    };
  }
  try {
    const res = await bulkArchiveRequest(apiBasePath, op, ids);
    for (const path of Array.isArray(revalidate) ? revalidate : [revalidate]) {
      revalidatePath(path);
    }
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
