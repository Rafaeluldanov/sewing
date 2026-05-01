'use server';

/**
 * Server actions для блока «Нанесение» в DRAFT-карточке заказа
 * (`/admin/orders/[id]`).
 *
 * Контракт сабмита (через `<form action>` + `useFormState`):
 *   - hidden `applicationsJson` — `JSON.stringify(rows)`, сериализованный
 *     `OrderApplicationsEditor`-ом (см. `apps/web/components/orders/
 *     order-applications-editor.tsx`). Полный список нанесений
 *     заказа (full replace).
 *
 * Действия:
 *   1. Прочитать `applicationsJson`, JSON.parse;
 *   2. Прогнать через `ReplaceOrderApplicationsSchema` (Zod
 *      нормализует поля — пустые строки в null, числа из строк и т.д.);
 *   3. Вызвать `replaceOrderApplications(orderId, dto)` →
 *      `PUT /api/orders/:id/applications`;
 *   4. После успеха — `revalidatePath('/admin/orders/[id]')` +
 *      легаси-карточку, чтобы серверные RSC-ы перерисовались с
 *      актуальными нанесениями.
 *
 * Почему `applicationsJson` вместо `applications[i].field`-полей:
 *   - убираем хрупкий ручной парсинг FormData-ключей (regex по
 *     индексам, отдельный `pickNumber` / `pickString`);
 *   - редактор контролирует сериализацию рядом с UI, а сервер
 *     получает уже нормализованный JSON — Zod на серверной стороне
 *     максимально предсказуемо валидирует.
 *
 * До этого изменения форма использовала нестандартный путь
 * (`startTransition` + `new FormData(currentTarget)` + прямой
 * вызов server action из onSubmit). При некоторых рендерах
 * Next.js не доносил FormData до server action в полном виде, и
 * сохранение «молча» не происходило. Теперь форма идёт через
 * `<form action={formAction}>` — это blessed-путь Next.js 14.
 */

import { revalidatePath } from 'next/cache';
import {
  ReplaceOrderApplicationsSchema,
  type ReplaceOrderApplicationsDto,
} from '@sewing/shared/order-applications';
import { ApiRequestError } from '@/lib/api';
import { replaceOrderApplications } from '@/lib/order-applications-api';

export interface OrderApplicationsFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  successMessage?: string;
}

export const initialOrderApplicationsFormState: OrderApplicationsFormState = {};

function parseApplicationsJson(form: FormData): unknown {
  const raw = form.get('applicationsJson');
  if (raw === null) return { applications: [] };
  const text = String(raw).trim();
  if (text === '') return { applications: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return { applications: parsed };
    return parsed;
  } catch {
    // Невалидный JSON — отдадим пустой массив, Zod-валидация
    // ниже отдаст осмысленную ошибку через issues.
    return { applications: [] };
  }
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось сохранить нанесения';
}

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId)`:
 * `(orderId, prev, formData) → next`.
 */
export async function saveOrderApplicationsAction(
  orderId: string,
  _prev: OrderApplicationsFormState,
  form: FormData,
): Promise<OrderApplicationsFormState> {
  const raw = parseApplicationsJson(form);
  const parsed = ReplaceOrderApplicationsSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      fieldErrors[path] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }
  const dto: ReplaceOrderApplicationsDto = parsed.data;
  try {
    const next = await replaceOrderApplications(orderId, dto);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    return {
      ok: true,
      successMessage:
        next.length === 0
          ? 'Список нанесений очищен.'
          : `Сохранено нанесений: ${next.length}.`,
    };
  } catch (e) {
    return { ok: false, error: explainApiError(e) };
  }
}
