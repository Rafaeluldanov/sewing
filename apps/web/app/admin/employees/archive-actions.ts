'use server';

/**
 * Server actions вкладок «Активные» / «Архив» на `/admin/employees`.
 * Механика — в `lib/bulk-archive-actions.ts`.
 *
 * Backend оборачивает одиночные archive/restore/hardDelete со всеми
 * гейтами раздела, поэтому пропущенные строки приходят с точной
 * причиной («нельзя на себе», «открыта смена», «есть история»).
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/employees';
const PAGE = '/admin/employees';

export async function archiveEmployeesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGE);
}

export async function restoreEmployeesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGE);
}

export async function purgeEmployeesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGE);
}
