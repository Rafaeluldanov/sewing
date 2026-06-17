'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ROUTE_TEMPLATE_CODE_PATTERN,
  type RouteTemplateStepInputDto,
} from '@sewing/shared/routes';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  createRouteTemplate,
  deleteRouteTemplate,
  updateRouteTemplate,
} from '@/lib/routes-api';
import type {
  CreateRouteTemplateState,
  UpdateRouteTemplateState,
} from './form-state';

/**
 * Парсит шаги маршрута из FormData. UI рендерит чек-лист операций со
 * скрытым «порядком выбора» (`stepOrder[<operationId>]`); неотмеченные
 * операции в FormData не приходят, отмеченные — приходят как пары
 * `operationIds=<id>` + `stepOrder[<id>]=<n>` + (опционально)
 * `stepOptional[<id>]=on`. Сортировка по `stepOrder` даёт финальный
 * порядок шагов; пустой/неотмеченный список даёт пустой `steps[]`.
 */
function parseSteps(form: FormData): RouteTemplateStepInputDto[] {
  const ids = form
    .getAll('operationIds')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);

  const orderByOpId = new Map<string, number>();
  for (const opId of ids) {
    const raw = form.get(`stepOrder[${opId}]`);
    const n = raw === null ? Number.POSITIVE_INFINITY : Number(raw);
    orderByOpId.set(opId, Number.isFinite(n) ? n : Number.POSITIVE_INFINITY);
  }

  const sortedIds = [...new Set(ids)].sort((a, b) => {
    const na = orderByOpId.get(a) ?? Number.POSITIVE_INFINITY;
    const nb = orderByOpId.get(b) ?? Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });

  return sortedIds.map((operationId) => ({
    operationId,
    isOptional: form.get(`stepOptional[${operationId}]`) === 'on',
    // «↕ параллельно с соседним»: шаг идёт параллельно с предыдущим в
    // финальном порядке. Backend свернёт связанные соседние шаги в одну
    // параллельную группу (`RoutesService.computeParallelGroups`).
    parallelWithPrev: form.get(`stepParallel[${operationId}]`) === 'on',
    // Переопределение сдельной расценки операции для изделия. Пустое
    // поле / не FIXED-операция (input не отрендерен) → null = дефолт
    // операции. Бэкенд игнорирует override для BY_SIZE / SALARY_ONLY.
    rateOverride: parseRate(form.get(`stepRate[${operationId}]`)),
  }));
}

/**
 * Парсит сдельную расценку из FormData. Пустая строка / `null` /
 * невалидное число → `null` (значит «по умолчанию операции»).
 * Отрицательные значения отбрасываем в `null` — Zod на бэкенде всё
 * равно отвергнет, но так UI не отправит заведомо мусор.
 */
function parseRate(raw: FormDataEntryValue | null): number | null {
  if (raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export async function createRouteTemplateAction(
  _prev: CreateRouteTemplateState,
  form: FormData,
): Promise<CreateRouteTemplateState> {
  const code = String(form.get('code') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const isActive = form.get('isActive') !== 'off';

  if (code.length === 0) return { error: 'Код шаблона обязателен' };
  if (!ROUTE_TEMPLATE_CODE_PATTERN.test(code)) {
    return {
      error:
        'Код шаблона: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
    };
  }
  if (name.length === 0) return { error: 'Название шаблона обязательно' };

  const steps = parseSteps(form);

  let createdId: string | null = null;
  try {
    const created = await createRouteTemplate({
      code,
      name,
      isActive,
      steps,
    });
    createdId = created.id;
    revalidatePath('/admin/routes');
    revalidatePath('/orders/new');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: errorText(e),
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать шаблон маршрута' };
  }
  if (createdId) {
    redirect(`/admin/routes/${createdId}`);
  }
  return { ok: true, successMessage: 'Шаблон маршрута создан' };
}

export async function updateRouteTemplateAction(
  _prev: UpdateRouteTemplateState,
  form: FormData,
): Promise<UpdateRouteTemplateState> {
  const id = String(form.get('id') ?? '').trim();
  if (id.length === 0) return { error: 'Не указан id шаблона' };

  const code = String(form.get('code') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const isActive = form.get('isActive') !== 'off';

  if (code.length === 0) return { error: 'Код шаблона обязателен' };
  if (!ROUTE_TEMPLATE_CODE_PATTERN.test(code)) {
    return {
      error:
        'Код шаблона: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
    };
  }
  if (name.length === 0) return { error: 'Название шаблона обязательно' };

  const steps = parseSteps(form);

  try {
    await updateRouteTemplate(id, { code, name, isActive, steps });
    revalidatePath('/admin/routes');
    revalidatePath(`/admin/routes/${id}`);
    revalidatePath('/orders/new');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: errorText(e),
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось обновить шаблон маршрута' };
  }
  return { ok: true, successMessage: 'Шаблон маршрута обновлён' };
}

/**
 * Жёсткое удаление шаблона. Snapshot маршрута (`OrderRouteStep[]`) на
 * запущенных заказах остаётся живым — он самодостаточный и не
 * зависит от существования шаблона.
 */
export async function deleteRouteTemplateAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (id.length === 0) return;
  try {
    await deleteRouteTemplate(id);
  } catch (e) {
    if (e instanceof ApiRequestError) {
      // Бросаем дальше, чтобы Next.js показал ошибку в UI (action
      // вызывается из формы без useFormState — Next отрендерит
      // error.tsx). На MVP этого достаточно.
      throw e;
    }
    throw new Error('Не удалось удалить шаблон маршрута');
  }
  revalidatePath('/admin/routes');
  revalidatePath('/orders/new');
  redirect('/admin/routes');
}
