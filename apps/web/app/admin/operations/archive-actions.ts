'use server';

/**
 * Server actions вкладок «Активные» / «Архив» на `/admin/operations`.
 * Механика — в `lib/bulk-archive-actions.ts`.
 *
 * `purge` на backend доступен только `ADMIN` (необратимо); для
 * `SHOP_MANAGER` вернётся 403 с понятным текстом — показываем как есть.
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/operations';
const PAGE = '/admin/operations';

export async function archiveOperationsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGE);
}

export async function restoreOperationsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGE);
}

export async function purgeOperationsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGE);
}
