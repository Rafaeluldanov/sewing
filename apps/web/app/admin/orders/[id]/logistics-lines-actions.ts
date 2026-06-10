'use server';

/**
 * Server actions для ручных строк логистики в таблице «Операции»
 * карточки заказа (`/admin/orders/[id]?tab=operations`).
 *
 * См. `apps/api/src/modules/orders/orders.controller.ts`
 * (`POST/PATCH/DELETE /orders/:id/logistics-lines[/:lineId]`),
 * `apps/web/lib/orders-api.ts`,
 * `apps/web/components/orders/operations/*`.
 *
 * Контракт сабмита:
 *   - create / update идут через `<form action>` + hidden `payload`
 *     (JSON, сериализованный диалогом `OrderLogisticsLineDialog`);
 *   - delete — маленькая `<form>` без полей (id зашит в bind-аргумент).
 *
 * После успеха — `revalidatePath('/admin/orders/[id]')`, чтобы RSC
 * таблицы операций перечитал строки и пересчитал итог стоимости.
 */

import { revalidatePath } from 'next/cache';
import {
  CreateOrderLogisticsLineSchema,
  UpdateOrderLogisticsLineSchema,
  type CreateOrderLogisticsLineDto,
  type UpdateOrderLogisticsLineDto,
} from '@sewing/shared/orders';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  addOrderLogisticsLine,
  deleteOrderLogisticsLine,
  updateOrderLogisticsLine,
} from '@/lib/orders-api';
// Тип + начальное состояние живут в отдельном модуле — `'use server'`
// файл может экспортировать только async-функции (иначе прод-сборка
// падает с «can only export async functions, found object»).
import type { LogisticsLineFormState } from './logistics-lines-form-state';

function explainApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return fallback;
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
}

function parsePayload(form: FormData): unknown {
  const raw = form.get('payload');
  if (raw === null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fieldErrorsFromZod(
  issues: { path: (string | number)[]; message: string }[],
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    fieldErrors[issue.path.join('.')] = issue.message;
  }
  return fieldErrors;
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

export async function createOrderLogisticsLineAction(
  orderId: string,
  _prev: LogisticsLineFormState,
  form: FormData,
): Promise<LogisticsLineFormState> {
  const raw = parsePayload(form);
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Невалидные данные строки логистики' };
  }

  const parsed = CreateOrderLogisticsLineSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors: fieldErrorsFromZod(parsed.error.issues),
    };
  }
  const dto: CreateOrderLogisticsLineDto = parsed.data;

  try {
    await addOrderLogisticsLine(orderId, dto);
    revalidateOrder(orderId);
    return {
      ok: true,
      doneToken: `created:${dto.name}`,
      successMessage: 'Строка логистики добавлена.',
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось добавить строку логистики'),
    };
  }
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

export async function updateOrderLogisticsLineAction(
  orderId: string,
  lineId: string,
  _prev: LogisticsLineFormState,
  form: FormData,
): Promise<LogisticsLineFormState> {
  const raw = parsePayload(form);
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Невалидные данные строки логистики' };
  }

  const parsed = UpdateOrderLogisticsLineSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors: fieldErrorsFromZod(parsed.error.issues),
    };
  }
  const dto: UpdateOrderLogisticsLineDto = parsed.data;

  try {
    await updateOrderLogisticsLine(orderId, lineId, dto);
    revalidateOrder(orderId);
    return {
      ok: true,
      doneToken: `updated:${lineId}`,
      successMessage: 'Строка логистики обновлена.',
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось обновить строку логистики'),
    };
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function deleteOrderLogisticsLineAction(
  orderId: string,
  lineId: string,
  _prev: LogisticsLineFormState,
  _form: FormData,
): Promise<LogisticsLineFormState> {
  try {
    await deleteOrderLogisticsLine(orderId, lineId);
    revalidateOrder(orderId);
    return {
      ok: true,
      doneToken: `deleted:${lineId}`,
      successMessage: 'Строка логистики удалена.',
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось удалить строку логистики'),
    };
  }
}
