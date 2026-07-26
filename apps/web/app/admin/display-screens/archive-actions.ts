'use server';

/**
 * Server actions вкладок «Активные» / «Архив» на
 * `/admin/display-screens`. Механика — в `lib/bulk-archive-actions.ts`.
 *
 * Архивация экрана гасит и его DISPLAY-учётку (см.
 * `DisplayScreensService.archiveMany`), поэтому ревалидируем ещё и
 * список сотрудников — там эта учётка тоже видна.
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/display-screens';
const PAGES = ['/admin/display-screens', '/admin/employees'];

export async function archiveDisplayScreensAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGES);
}

export async function restoreDisplayScreensAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGES);
}

export async function purgeDisplayScreensAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGES);
}
