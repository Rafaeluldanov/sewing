'use server';

/**
 * Server action фичи «Правка заказа в производстве» (order amendments) —
 * ФАЗА 1: количество по размерам.
 *
 * См. `apps/api/src/modules/order-amendments/*`
 * (`POST /orders/:id/amendments/quantities`), `apps/web/lib/amendments-api.ts`,
 * `apps/web/components/orders/amendments/*`.
 *
 * После успеха — `revalidatePath('/admin/orders/[id]')`, чтобы RSC
 * перечитал план по размерам (`OrderSizeBreakdownRow`), снимок материалов
 * и плановую стоимость операций.
 */

import { revalidatePath } from 'next/cache';
import {
  ApplyOperationAmendmentSchema,
  ApplyQuantityAmendmentSchema,
  ApplyRouteAmendmentSchema,
  ApplySizeAmendmentSchema,
} from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  applyOperationAmendment,
  applyQuantityAmendment,
  applyRouteAmendment,
  applySizeAmendment,
} from '@/lib/amendments-api';
// Типы и initial state живут в отдельном модуле: `'use server'` файл
// может экспортировать только async-функции.
import type {
  OperationAmendmentFormState,
  QuantityAmendmentFormState,
  RouteAmendmentFormState,
  SizeAmendmentFormState,
} from './amendment-form-state';

export async function applyQuantityAmendmentAction(
  orderId: string,
  _prev: QuantityAmendmentFormState,
  form: FormData,
): Promise<QuantityAmendmentFormState> {
  const raw = form.get('payload');
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(String(raw)) : null;
  } catch {
    json = null;
  }

  const parsed = ApplyQuantityAmendmentSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }

  try {
    const result = await applyQuantityAmendment(orderId, parsed.data);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, result, doneToken: `saved:${Date.now()}` };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось применить правку количества',
    };
  }
}

export async function applySizeAmendmentAction(
  orderId: string,
  _prev: SizeAmendmentFormState,
  form: FormData,
): Promise<SizeAmendmentFormState> {
  const raw = form.get('payload');
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(String(raw)) : null;
  } catch {
    json = null;
  }

  const parsed = ApplySizeAmendmentSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }

  try {
    const result = await applySizeAmendment(orderId, parsed.data);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, result, doneToken: `saved:${Date.now()}` };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось применить правку размерности',
    };
  }
}

export async function applyOperationAmendmentAction(
  orderId: string,
  _prev: OperationAmendmentFormState,
  form: FormData,
): Promise<OperationAmendmentFormState> {
  const raw = form.get('payload');
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(String(raw)) : null;
  } catch {
    json = null;
  }

  const parsed = ApplyOperationAmendmentSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }

  try {
    const result = await applyOperationAmendment(orderId, parsed.data);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, result, doneToken: `saved:${Date.now()}` };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось добавить операцию',
    };
  }
}

/**
 * ФАЗА 3.1 — правка маршрута целиком (вкладка «Маршрут» drawer-а).
 * `payload` — весь целевой маршрут (`ApplyRouteAmendmentSchema`), дельту
 * считает бэкенд: он же стережёт замороженный префикс до фронта.
 */
export async function applyRouteAmendmentAction(
  orderId: string,
  _prev: RouteAmendmentFormState,
  form: FormData,
): Promise<RouteAmendmentFormState> {
  const raw = form.get('payload');
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(String(raw)) : null;
  } catch {
    json = null;
  }

  const parsed = ApplyRouteAmendmentSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }

  try {
    const result = await applyRouteAmendment(orderId, parsed.data);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, result, doneToken: `saved:${Date.now()}` };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось сохранить маршрут',
    };
  }
}
