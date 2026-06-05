'use server';

/**
 * Server action «Отправить конструктору» для УЖЕ существующего лекала.
 *
 * В отличие от `saveConstructorDraftAction` (создаёт новое DRAFT-лекало
 * из формы заказа), эта ветка привязывает заявку КБ к существующему
 * `PatternItem` — используется кнопкой «Отправить конструктору» на:
 *   - карточке заказа `/admin/orders/[id]/edit` (изделие создано через
 *     «Сохранить изделие», файла лекала ещё нет);
 *   - карточке номенклатуры `/admin/patterns/[id]`.
 *
 * Клиент собирает `FormData` (так же, как остальные multipart-флоу КБ —
 * Next 14 не принимает `File[]` top-level аргументом, см. memory
 * `feedback-server-action-file-array`):
 *   - `payload` — JSON `CreateConstructorTaskForPatternDto`;
 *   - `files`   — повторяющееся поле с прикреплёнными `File`-ами.
 */

import { revalidatePath } from 'next/cache';
import { createConstructorTaskForPattern } from '@/lib/constructor-tasks-api';
import { ApiRequestError } from '@/lib/api';
import {
  CreateConstructorTaskForPatternSchema,
  type SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';

export interface SendPatternToConstructorActionResult {
  ok: boolean;
  result?: SaveConstructorDraftResultDto;
  error?: string;
}

export async function sendPatternToConstructorAction(
  formData: FormData,
): Promise<SendPatternToConstructorActionResult> {
  const payloadRaw = formData.get('payload');
  if (typeof payloadRaw !== 'string') {
    return {
      ok: false,
      error:
        'Поле payload обязательно — передайте JSON с patternItemId, sizeRows и комментарием.',
    };
  }
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadRaw);
  } catch {
    return { ok: false, error: 'Невалидный JSON в payload.' };
  }
  const parsed = CreateConstructorTaskForPatternSchema.safeParse(payloadJson);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Невалидные данные для отправки конструктору',
    };
  }
  try {
    // Пересобираем FormData, чтобы payload был ровно тот, что прошёл
    // через zod (без UI-only полей).
    const out = new FormData();
    out.append('payload', JSON.stringify(parsed.data));
    for (const entry of formData.getAll('files')) {
      if (entry instanceof File) {
        out.append('files', entry, entry.name);
      }
    }
    const result = await createConstructorTaskForPattern(out);
    // Заявка видна на карточке номенклатуры и (через
    // patternItem.constructorTask) на карточке заказа.
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${parsed.data.patternItemId}`);
    revalidatePath('/admin/constructor-tasks');
    revalidatePath('/admin/orders');
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: e.message || 'Не удалось отправить лекало конструктору',
      };
    }
    return {
      ok: false,
      error:
        (e as Error)?.message ??
        'Не удалось отправить лекало конструктору (неизвестная ошибка)',
    };
  }
}
