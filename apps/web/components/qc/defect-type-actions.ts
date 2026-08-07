'use server';

/**
 * Inline server action «＋ Добавить вид брака» для цеховых форм фиксации
 * брака (ОТК-карточка, страница паспорта ОТК, шит мастера).
 *
 * Контракт — как у `components/admin/ref-create/actions.ts`: без
 * redirect, возвращает созданный DTO. В отличие от админских
 * справочников здесь ЕСТЬ ревалидация — список видов брака кэшируется
 * тегом `defect-types` (см. `lib/qc-api.ts`, revalidate 300), без
 * сброса тега новый вид не попал бы на соседние ОТК-страницы до 5 минут.
 */

import { revalidateTag } from 'next/cache';
import {
  CreateDefectTypeSchema,
  type DefectTypeDto,
} from '@sewing/shared/qc';
import { ApiRequestError, errorText } from '@/lib/api';
import { createDefectType } from '@/lib/qc-api';

export interface CreateDefectTypeInlineResult {
  ok?: boolean;
  defectType?: DefectTypeDto;
  error?: string;
}

export async function createDefectTypeInlineAction(
  raw: unknown,
): Promise<CreateDefectTypeInlineResult> {
  const parsed = CreateDefectTypeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Не удалось создать вид брака',
    };
  }
  try {
    const created = await createDefectType(parsed.data);
    revalidateTag('defect-types');
    return { ok: true, defectType: created };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e) };
    }
    return { error: 'Не удалось создать вид брака' };
  }
}
