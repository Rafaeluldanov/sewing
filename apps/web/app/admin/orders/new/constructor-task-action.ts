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
 * Принимает уже собранный `FormData` с двумя полями:
 *   - `payload` — JSON-строка с `calcPayload / sizeRows / comment`;
 *   - `files`   — повторяющееся поле с прикреплёнными `File`-ами.
 *
 * Раньше action принимал два аргумента — объект-payload и `File[]`.
 * Next.js 14 server actions требует, чтобы все аргументы были
 * сериализуемыми по «React Server Components serialization rules».
 * Top-level `File[]` (массив `File`-ов как ОТДЕЛЬНЫЙ аргумент) этим
 * правилам не соответствует и падает с `Only plain objects, and a
 * few built-ins, can be passed to Server Actions` (см. инциденте
 * 14.05.2026, форма «Отправить конструктору» на edit-странице
 * заказа). `FormData` — один из явно поддерживаемых типов, и файлы
 * внутри него передаются корректно.
 *
 * Парсинг JSON-payload-а и валидация через shared zod-схему остаются
 * на server-стороне action-а — UI получает понятную ошибку, если
 * данные в state модалки неполные.
 */
export async function saveConstructorDraftAction(
  formData: FormData,
): Promise<SaveConstructorDraftActionResult> {
  const payloadRaw = formData.get('payload');
  if (typeof payloadRaw !== 'string') {
    return {
      ok: false,
      error: 'Поле payload обязательно — передайте JSON со sizeRows и комментарием.',
    };
  }
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadRaw);
  } catch {
    return { ok: false, error: 'Невалидный JSON в payload.' };
  }
  const parsed = SaveConstructorDraftSchema.safeParse(payloadJson);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Невалидные данные изделия для отправки конструктору',
    };
  }
  try {
    // Пересобираем FormData, чтобы payload был ровно тот, что прошёл
    // через zod (без UI-only полей вроде `categoryName`).
    const out = new FormData();
    out.append('payload', JSON.stringify(parsed.data));
    for (const entry of formData.getAll('files')) {
      if (entry instanceof File) {
        out.append('files', entry, entry.name);
      }
    }
    const result = await saveConstructorTaskDraft(out);
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
