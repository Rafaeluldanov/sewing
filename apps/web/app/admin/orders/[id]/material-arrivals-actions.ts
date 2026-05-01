'use server';

/**
 * Server actions для блока «Материал поступил» в карточке заказа
 * (`/admin/orders/[id]`).
 *
 * См. `apps/api/src/modules/order-material-arrivals/*`,
 * `apps/web/lib/order-material-arrivals-api.ts`,
 * `apps/web/components/orders/cut-readiness-card.tsx`.
 *
 * Действия:
 *   1. `markOrderMaterialArrivedAction` — POST `/api/orders/:id/material-arrived`
 *      с `comment` (обязательно) и опциональными `workshopNeedIds`
 *      (через несколько `formData.getAll('workshopNeedId')`).
 *   2. `revokeOrderMaterialArrivalOverrideAction` — POST
 *      `/api/orders/:id/material-arrival-overrides/:overrideId/revoke`
 *      с `reason` (обязательно).
 *
 * После успеха — `revalidatePath('/admin/orders/[id]')` +
 * `revalidatePath('/orders/[id]')`, чтобы серверные RSC-ы
 * (`CutReadinessCard`) перерисовались с актуальным состоянием.
 */

import { revalidatePath } from 'next/cache';
import {
  CreateOrderMaterialArrivalOverrideSchema,
  RevokeOrderMaterialArrivalOverrideSchema,
  type CreateOrderMaterialArrivalOverrideDto,
  type RevokeOrderMaterialArrivalOverrideDto,
} from '@sewing/shared/order-material-arrivals';
import { ApiRequestError } from '@/lib/api';
import {
  markOrderMaterialArrived,
  revokeOrderMaterialArrivalOverride,
} from '@/lib/order-material-arrivals-api';

export interface OrderMaterialArrivalsFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  successMessage?: string;
}

export const initialOrderMaterialArrivalsFormState: OrderMaterialArrivalsFormState =
  {};

function explainApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return fallback;
}

function pickStrings(form: FormData, name: string): string[] {
  const out: string[] = [];
  for (const v of form.getAll(name)) {
    const text = String(v ?? '').trim();
    if (text !== '') out.push(text);
  }
  return out;
}

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId)`:
 * `(orderId, prev, formData) → next`.
 *
 * Поля FormData:
 *   - `comment` (required, min 2 символа на сервере и в Zod);
 *   - `workshopNeedId` — несколько значений (опционально). Если не
 *     передано ни одного — backend применит ко всем blocking-потребностям.
 */
export async function markOrderMaterialArrivedAction(
  orderId: string,
  _prev: OrderMaterialArrivalsFormState,
  form: FormData,
): Promise<OrderMaterialArrivalsFormState> {
  const comment = String(form.get('comment') ?? '').trim();
  const workshopNeedIds = pickStrings(form, 'workshopNeedId');

  const raw: Record<string, unknown> = { comment };
  if (workshopNeedIds.length > 0) raw.workshopNeedIds = workshopNeedIds;

  const parsed = CreateOrderMaterialArrivalOverrideSchema.safeParse(raw);
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
  const dto: CreateOrderMaterialArrivalOverrideDto = parsed.data;

  try {
    const overrides = await markOrderMaterialArrived(orderId, dto);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    return {
      ok: true,
      successMessage:
        overrides.length === 0
          ? 'Ручная отметка применена.'
          : `Отмечено материалов: ${overrides.length}.`,
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось зафиксировать отметку поступления'),
    };
  }
}

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId, overrideId)`:
 * `(orderId, overrideId, prev, formData) → next`.
 *
 * Поля FormData:
 *   - `reason` (required, min 2 символа).
 */
export async function revokeOrderMaterialArrivalOverrideAction(
  orderId: string,
  overrideId: string,
  _prev: OrderMaterialArrivalsFormState,
  form: FormData,
): Promise<OrderMaterialArrivalsFormState> {
  const reason = String(form.get('reason') ?? '').trim();

  const parsed = RevokeOrderMaterialArrivalOverrideSchema.safeParse({ reason });
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
  const dto: RevokeOrderMaterialArrivalOverrideDto = parsed.data;

  try {
    await revokeOrderMaterialArrivalOverride(orderId, overrideId, dto);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    return {
      ok: true,
      successMessage: 'Ручная отметка отменена.',
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось отменить ручную отметку'),
    };
  }
}
