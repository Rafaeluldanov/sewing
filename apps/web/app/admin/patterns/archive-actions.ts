'use server';

/**
 * Server actions вкладок «Номенклатура» / «Архив» на `/admin/patterns`.
 *
 * Три императивные операции над карточками номенклатуры — ровно тот же
 * контур, что у архива расчётов цеха
 * (`apps/web/app/admin/workshop-needs/archive-actions.ts`):
 *   - archive — мягко скрыть в архив (обратимо, данные сохраняются);
 *   - restore — вернуть из архива;
 *   - purge   — удалить безвозвратно (только из архива).
 *
 * Вызываются напрямую из клиентского компонента (`pattern-archive.tsx`),
 * поэтому это обычные async-функции с типом результата
 * `PatternsArchiveActionResult`, а не form-state экшены. RBAC — на
 * backend (`@Roles('ADMIN','SHOP_MANAGER')` на `PatternsController`).
 */

import { revalidatePath } from 'next/cache';
import type {
  PatternArchiveSkipDto,
  PatternsArchiveResultDto,
} from '@sewing/shared/patterns';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  archivePatterns,
  purgePatterns,
  restorePatterns,
} from '@/lib/patterns-api';

export interface PatternsArchiveActionResult {
  ok: boolean;
  /** Сколько карточек реально обработано. */
  processed: number;
  /** Пропущенные с причиной (частичный успех). */
  skipped: PatternArchiveSkipDto[];
  error?: string;
}

async function runArchiveOp(
  op: (patternIds: string[]) => Promise<PatternsArchiveResultDto>,
  patternIds: string[],
): Promise<PatternsArchiveActionResult> {
  if (!patternIds || patternIds.length === 0) {
    return {
      ok: false,
      processed: 0,
      skipped: [],
      error: 'Не выбрано ни одной номенклатуры.',
    };
  }
  try {
    const res = await op(patternIds);
    // Карточка тоже показывает статус — ревалидируем и её, чтобы после
    // операции из списка не остался устаревший бейдж «Активна».
    revalidatePath('/admin/patterns');
    for (const id of patternIds) revalidatePath(`/admin/patterns/${id}`);
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

export async function archivePatternsAction(
  patternIds: string[],
): Promise<PatternsArchiveActionResult> {
  return runArchiveOp(archivePatterns, patternIds);
}

export async function restorePatternsAction(
  patternIds: string[],
): Promise<PatternsArchiveActionResult> {
  return runArchiveOp(restorePatterns, patternIds);
}

export async function purgePatternsAction(
  patternIds: string[],
): Promise<PatternsArchiveActionResult> {
  return runArchiveOp(purgePatterns, patternIds);
}
