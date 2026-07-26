'use server';

/**
 * Server actions вкладок «Номенклатура» / «Архив» на `/admin/patterns`.
 *
 * Раздел получил архив первым и успел обзавестись собственным шейпом
 * запроса/ответа (`{ patternIds }`, `skipped[].patternId` — см.
 * `@sewing/shared/patterns`). Когда тот же контур раскатали ещё на
 * девять справочников, общим стал `@sewing/shared/archive`
 * (`{ ids }`, `skipped[].id`). Backend номенклатуры не переписываем —
 * он рабочий и уже в main; вместо этого переводим ответ в общий вид
 * ЗДЕСЬ, чтобы страница пользовалась тем же `BulkArchiveProvider`, что
 * и остальные разделы (иначе пришлось бы держать два одинаковых UI).
 *
 * Единственное отличие в причинах: у номенклатуры `USED_BY_ORDERS`
 * вместо общего `IN_USE` — переносим в `detail`, там текст точнее.
 */

import { revalidatePath } from 'next/cache';
import type { PatternsArchiveResultDto } from '@sewing/shared/patterns';
import type { BulkArchiveActionResult } from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  archivePatterns,
  purgePatterns,
  restorePatterns,
} from '@/lib/patterns-api';

function toBulkResult(res: PatternsArchiveResultDto): BulkArchiveActionResult {
  return {
    ok: true,
    processed: res.processed.length,
    skipped: res.skipped.map((s) => ({
      id: s.patternId,
      reason: s.reason === 'USED_BY_ORDERS' ? 'IN_USE' : s.reason,
      detail:
        s.reason === 'USED_BY_ORDERS'
          ? 'номенклатуру используют заказы — оставьте её в архиве'
          : undefined,
    })),
  };
}

async function run(
  op: (patternIds: string[]) => Promise<PatternsArchiveResultDto>,
  ids: string[],
): Promise<BulkArchiveActionResult> {
  if (!ids || ids.length === 0) {
    return {
      ok: false,
      processed: 0,
      skipped: [],
      error: 'Не выбрано ни одной номенклатуры.',
    };
  }
  try {
    const res = await op(ids);
    // Карточка тоже показывает статус — ревалидируем и её, чтобы после
    // операции из списка не остался устаревший бейдж «Активна».
    revalidatePath('/admin/patterns');
    for (const id of ids) revalidatePath(`/admin/patterns/${id}`);
    return toBulkResult(res);
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
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return run(archivePatterns, ids);
}

export async function restorePatternsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return run(restorePatterns, ids);
}

export async function purgePatternsAction(
  ids: string[],
): Promise<BulkArchiveActionResult> {
  return run(purgePatterns, ids);
}
