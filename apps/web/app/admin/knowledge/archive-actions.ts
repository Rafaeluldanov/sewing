'use server';

/**
 * Server actions вкладок «Активные» / «Черновики» / «Архив» на
 * `/admin/knowledge`. Механика — в `lib/bulk-archive-actions.ts`,
 * общая с остальными разделами админки.
 *
 * Восстановление из архива возвращает статью в ЧЕРНОВИКИ (так решает
 * backend): её отправили в архив, потому что ей не доверяли, и молча
 * показать её сотрудникам обратно — худшее, что можно сделать.
 */
import type { BulkArchiveActionResult } from '@/components/admin';
import { runBulkArchiveAction } from '@/lib/bulk-archive-actions';

const API = '/knowledge';
const PAGE = '/admin/knowledge';

export async function archiveKnowledgeAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'archive', ids, PAGE);
}

export async function restoreKnowledgeAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'restore', ids, PAGE);
}

export async function purgeKnowledgeAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return runBulkArchiveAction(API, 'purge', ids, PAGE);
}
