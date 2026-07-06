'use server';

/**
 * Server actions блока «Расцветки» карточки заказа (фича
 * `FEATURE_COLORWAYS`).
 *
 * Клиентский компонент (`order-colorways-block.tsx`) вызывает эти
 * действия; каждое возвращает свежий полный `OrderColorwaysDto`, из
 * которого блок обновляет своё состояние. После записи —
 * `revalidatePath` карточки заказа.
 *
 * Контракт — `@sewing/shared/colorways`, веб-обёртки —
 * `apps/web/lib/colorways-api.ts`.
 */

import { revalidatePath } from 'next/cache';
import {
  UpsertOrderColorwaySchema,
  type OrderColorwaysDto,
} from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  createOrderColorway,
  deleteOrderColorway,
  updateOrderColorway,
} from '@/lib/colorways-api';

export interface ColorwaysActionResult {
  ok: boolean;
  error?: string;
  data?: OrderColorwaysDto;
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
}

export async function createColorwayAction(
  orderId: string,
  payload: unknown,
): Promise<ColorwaysActionResult> {
  const parsed = UpsertOrderColorwaySchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    const data = await createOrderColorway(orderId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e, 'Не удалось создать расцветку')
          : 'Не удалось создать расцветку',
    };
  }
}

export async function updateColorwayAction(
  orderId: string,
  variantId: string,
  payload: unknown,
): Promise<ColorwaysActionResult> {
  const parsed = UpsertOrderColorwaySchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    const data = await updateOrderColorway(orderId, variantId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e, 'Не удалось сохранить расцветку')
          : 'Не удалось сохранить расцветку',
    };
  }
}

export async function deleteColorwayAction(
  orderId: string,
  variantId: string,
): Promise<ColorwaysActionResult> {
  try {
    const data = await deleteOrderColorway(orderId, variantId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e, 'Не удалось удалить расцветку')
          : 'Не удалось удалить расцветку',
    };
  }
}
