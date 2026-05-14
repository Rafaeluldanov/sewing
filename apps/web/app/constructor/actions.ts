'use server';

/**
 * Server actions кабинета конструктора (`apps/web/app/constructor/`).
 *
 * Бизнес-валидация и RBAC сидят в backend (`ConstructorTasksController` +
 * `AuthGuard`). Эти actions:
 *   - оборачивают сетевую ошибку в стабильный `{ ok, error }`-формат,
 *     который legко рендерить в client-компонентах через `useTransition`;
 *   - вызывают `revalidatePath('/constructor*')`, чтобы серверная
 *     страница со списком задач/деталями обновилась после действия.
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import {
  assignSelfConstructorTask,
  completeConstructorTask,
  updateConstructorTaskComment,
} from '@/lib/constructor-tasks-api';
import { COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX } from '@sewing/shared/constructor-tasks';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function explainError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    return e.message || fallback;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export async function assignSelfAction(taskId: string): Promise<ActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id заявки' };
  }
  try {
    await assignSelfConstructorTask(taskId);
    revalidatePath('/constructor');
    revalidatePath(`/constructor/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось взять задачу') };
  }
}

export async function updateCommentAction(
  taskId: string,
  formData: FormData,
): Promise<ActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id заявки' };
  }
  const raw = formData.get('comment');
  const comment = typeof raw === 'string' ? raw : '';
  try {
    await updateConstructorTaskComment(taskId, comment);
    revalidatePath(`/constructor/${taskId}`);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: explainError(e, 'Не удалось сохранить комментарий'),
    };
  }
}

/**
 * Завершить задачу: собрать multipart с готовыми DXF-лекалами по
 * каждому размеру. Вход — FormData из client-формы:
 *   - `sizeIds` (несколько) — список sizeId-ов из `task.sizeRows`,
 *     для которых пользователь выбрал файлы;
 *   - `file_<sizeId>` — реальный файл (один на размер).
 *
 * Здесь мы:
 *   1) фильтруем sizeIds, для которых реально есть `File` в форме;
 *   2) собираем `payload.sizeFiles[]` с маппингом sizeId → fileFieldName;
 *   3) создаём НОВЫЙ FormData (передавать оригинальный через сеть нельзя
 *      — там много лишнего), кладём JSON-payload + сами файлы.
 */
export async function completeTaskAction(
  taskId: string,
  formData: FormData,
): Promise<ActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id заявки' };
  }
  const sizeIdsRaw = formData.getAll('sizeIds');
  const sizeIds = sizeIdsRaw.filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  if (sizeIds.length === 0) {
    return {
      ok: false,
      error: 'Список размеров пуст — обновите страницу и попробуйте снова',
    };
  }

  const out = new FormData();
  const sizeFiles: Array<{ sizeId: string; fileFieldName: string }> = [];

  for (const sizeId of sizeIds) {
    const fieldName = `${COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX}${sizeId}`;
    const file = formData.get(fieldName);
    if (!(file instanceof File) || file.size === 0) {
      return {
        ok: false,
        error: `Не выбран файл для размера ${sizeId}`,
      };
    }
    out.append(fieldName, file, file.name);
    sizeFiles.push({ sizeId, fileFieldName: fieldName });
  }

  out.append('payload', JSON.stringify({ sizeFiles }));

  try {
    await completeConstructorTask(taskId, out);
    revalidatePath('/constructor');
    revalidatePath(`/constructor/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось завершить задачу') };
  }
}
