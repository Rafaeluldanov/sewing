'use server';

/**
 * Server actions вкладок «Активные» / «Архив» на `/admin/tech-cards`.
 * Вся механика — в `lib/bulk-archive-actions.ts`, здесь только адрес
 * раздела на backend и пути ревалидации.
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/tech-cards';
const PAGE = '/admin/tech-cards';

export async function archiveTechCardsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGE);
}

export async function restoreTechCardsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGE);
}

export async function purgeTechCardsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGE);
}
