'use server';

/**
 * Server actions вкладок «Активные» / «Архив» на `/admin/roles`.
 * Механика — в `lib/bulk-archive-actions.ts`, контракт —
 * `@sewing/shared/archive`.
 *
 * Ревалидируем ещё и список сотрудников: архивная роль пропадает из
 * селектов назначения, а восстановленная — возвращается.
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/app-roles';
const PAGES = ['/admin/roles', '/admin/employees'];

export async function archiveAppRolesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGES);
}

export async function restoreAppRolesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGES);
}

export async function purgeAppRolesAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGES);
}
