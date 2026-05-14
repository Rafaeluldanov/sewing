'use server';

/**
 * Server action для вкладки `constructor` модалки «Изделие» на
 * `/admin/orders/new` (см. `create-product-inline.tsx`).
 *
 * Клиент собирает `FormData`:
 *   - `payload` — JSON-строка с `sizeRows / comment / categoryId`
 *     (валидируется backend-ом через `SaveConstructorDraftSchema`);
 *   - `files` — повторяющееся поле с прикреплёнными документами
 *     (любой формат, лимит на размер и количество в `@sewing/shared/
 *     constructor-tasks`).
 *
 * Action форвардит multipart в `POST /api/constructor-tasks`,
 * получает `SaveConstructorDraftResultDto` и отдаёт родительской форме
 * через React state — родитель кладёт `patternItemId` в hidden input
 * и показывает summary-карточку «Заявка конструктору №…».
 */

import { saveConstructorTaskDraft } from '@/lib/constructor-tasks-api';
import { ApiRequestError } from '@/lib/api';
import {
  SaveConstructorDraftSchema,
  type SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';

export interface SaveConstructorDraftActionResult {
  ok: boolean;
  result?: SaveConstructorDraftResultDto;
  error?: string;
}

/**
 * Принимает структурированный payload и массив `File`-ов из client-
 * component-а (CreateProductInline собирает их в state, не в DOM-
 * input-ах). Action упаковывает всё в FormData и отправляет backend-у.
 *
 * Перед отправкой payload прогоняется через shared zod-схему. Это
 * убирает UI-only поля (например, `categoryName` / `techCardName`
 * из saved-payload родительской формы) и сразу даёт менеджеру понятную
 * ошибку, если данные в state модалки неполные.
 */
export async function saveConstructorDraftAction(
  rawPayload: unknown,
  files: File[],
): Promise<SaveConstructorDraftActionResult> {
  const parsed = SaveConstructorDraftSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Невалидные данные изделия для отправки конструктору',
    };
  }
  try {
    const fd = new FormData();
    fd.append('payload', JSON.stringify(parsed.data));
    for (const f of files) {
      fd.append('files', f, f.name);
    }
    const result = await saveConstructorTaskDraft(fd);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: e.message || 'Не удалось сохранить заявку конструктору',
      };
    }
    return {
      ok: false,
      error:
        (e as Error)?.message ??
        'Не удалось сохранить заявку конструктору (неизвестная ошибка)',
    };
  }
}
