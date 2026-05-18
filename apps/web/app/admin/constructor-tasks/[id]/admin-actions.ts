'use server';

/**
 * Server actions для admin-страницы детали задачи конструктору
 * (`/admin/constructor-tasks/[id]`).
 *
 * Закрывают workflow-приёмки лекала на стороне менеджера:
 *   - `acceptConstructorTaskAction` — `PENDING_ACCEPT` → `DONE`,
 *     `PatternItem.status` → `ACTIVE`. Это явный гейт качества:
 *     заказ нельзя запустить в производство, пока менеджер не
 *     принял лекало (см. `OrdersService.assertPatternUsable`).
 *   - `requestReworkConstructorTaskAction` — `PENDING_ACCEPT` → `REWORK`
 *     с приложенным комментарием замечаний и любыми файлами
 *     (сохраняются как `ConstructorTaskFile` с `direction='REWORK'`).
 *
 * Кеши страницы заказа, списка заказов и страницы лекала тоже
 * ревалидируем — везде показываем актуальный статус задачи.
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import {
  acceptConstructorTask,
  getConstructorTask,
  requestReworkConstructorTask,
} from '@/lib/constructor-tasks-api';
import { REWORK_CONSTRUCTOR_TASK_FILE_FIELD } from '@sewing/shared/constructor-tasks';

export interface AdminTaskActionResult {
  ok: boolean;
  error?: string;
}

function explainError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) return e.message || fallback;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/**
 * Перед revalidatePath нам нужен `patternItemId` — без него не сможем
 * сбросить кеш `/admin/patterns/[id]`. Берём его одним лёгким GET-ом
 * перед action — задача всё равно загружена на странице, лишней
 * нагрузки нет.
 */
async function revalidateRelated(taskId: string): Promise<void> {
  try {
    const task = await getConstructorTask(taskId);
    revalidatePath('/admin/constructor-tasks');
    revalidatePath(`/admin/constructor-tasks/${taskId}`);
    revalidatePath(`/admin/patterns/${task.patternItemId}`);
    revalidatePath('/admin/orders');
    // Поиск всех заказов с этим patternItemId — отдельный запрос, на
    // MVP делаем общий broad-revalidate `/admin/orders` (достаточно для
    // списка); карточка конкретного заказа подхватится при следующем
    // открытии (`force-dynamic` на странице).
  } catch {
    // Если getConstructorTask упал, ревалидация не критична —
    // пользователь увидит результат после ручного refresh.
  }
}

export async function acceptConstructorTaskAction(
  taskId: string,
): Promise<AdminTaskActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id заявки' };
  }
  try {
    await acceptConstructorTask(taskId);
    await revalidateRelated(taskId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось принять задачу') };
  }
}

export async function requestReworkConstructorTaskAction(
  taskId: string,
  formData: FormData,
): Promise<AdminTaskActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id заявки' };
  }

  const commentRaw = formData.get('comment');
  const comment = typeof commentRaw === 'string' ? commentRaw.trim() : '';
  if (comment.length === 0) {
    return {
      ok: false,
      error: 'Комментарий обязателен — опишите, что нужно поправить',
    };
  }

  // Собираем outgoing FormData строго с теми полями, которые ждёт
  // backend — `payload` (JSON) + повторяющееся `rework_files`. Файлы
  // в client-форме лежат под именем `rework_files` (см. UI-компонент).
  const out = new FormData();
  out.append('payload', JSON.stringify({ comment }));
  for (const file of formData.getAll(REWORK_CONSTRUCTOR_TASK_FILE_FIELD)) {
    if (file instanceof File && file.size > 0) {
      out.append(REWORK_CONSTRUCTOR_TASK_FILE_FIELD, file, file.name);
    }
  }

  try {
    await requestReworkConstructorTask(taskId, out);
    await revalidateRelated(taskId);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: explainError(e, 'Не удалось вернуть задачу на доработку'),
    };
  }
}
