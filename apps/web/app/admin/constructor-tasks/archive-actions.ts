'use server';

/**
 * Server actions вкладок «Активные» / «Архив» на
 * `/admin/constructor-tasks`. Механика — в `lib/bulk-archive-actions.ts`.
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/constructor-tasks';
const PAGE = '/admin/constructor-tasks';

export async function archiveConstructorTasksAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGE);
}

export async function restoreConstructorTasksAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGE);
}

export async function purgeConstructorTasksAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGE);
}
