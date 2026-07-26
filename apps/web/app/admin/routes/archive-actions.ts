'use server';

/**
 * Server actions вкладок «Активные» / «Архив» на `/admin/routes`.
 * Механика — в `lib/bulk-archive-actions.ts`.
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/routes';
const PAGE = '/admin/routes';

export async function archiveRoutesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGE);
}

export async function restoreRoutesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGE);
}

export async function purgeRoutesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGE);
}
