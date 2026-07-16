'use server';

/**
 * Server actions ряда вкладок «Варианты просчёта» карточки заказа
 * (фича `FEATURE_ORDER_CALCULATIONS`).
 *
 * Клиентский компонент (`components/orders/calculations/order-calc-tabs.tsx`)
 * вызывает эти действия; каждое возвращает свежий полный
 * `OrderCalculationsDto`, из которого ряд обновляет своё состояние.
 * После записи — `revalidatePath` карточки заказа (данные ВСЕХ вкладок
 * окна заказа зависят от активного варианта).
 *
 * Контракт — `@sewing/shared/order-calculations`, веб-обёртки —
 * `apps/web/lib/order-calculations-api.ts`.
 */

import { revalidatePath } from 'next/cache';
import {
  CreateOrderCalculationSchema,
  RenameOrderCalculationSchema,
  type OrderCalculationsDto,
} from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  activateOrderCalculation,
  createOrderCalculation,
  deleteOrderCalculation,
  renameOrderCalculation,
} from '@/lib/order-calculations-api';

export interface CalculationsActionResult {
  ok: boolean;
  error?: string;
  data?: OrderCalculationsDto;
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}/edit`);
}

export async function createCalculationAction(
  orderId: string,
  payload: unknown,
): Promise<CalculationsActionResult> {
  const parsed = CreateOrderCalculationSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const data = await createOrderCalculation(orderId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e, 'Не удалось создать вариант просчёта')
          : 'Не удалось создать вариант просчёта',
    };
  }
}

export async function activateCalculationAction(
  orderId: string,
  calcId: string,
): Promise<CalculationsActionResult> {
  try {
    const data = await activateOrderCalculation(orderId, calcId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e, 'Не удалось переключить вариант')
          : 'Не удалось переключить вариант',
    };
  }
}

export async function renameCalculationAction(
  orderId: string,
  calcId: string,
  payload: unknown,
): Promise<CalculationsActionResult> {
  const parsed = RenameOrderCalculationSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const data = await renameOrderCalculation(orderId, calcId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e, 'Не удалось переименовать вариант')
          : 'Не удалось переименовать вариант',
    };
  }
}

export async function deleteCalculationAction(
  orderId: string,
  calcId: string,
): Promise<CalculationsActionResult> {
  try {
    const data = await deleteOrderCalculation(orderId, calcId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e, 'Не удалось удалить вариант')
          : 'Не удалось удалить вариант',
    };
  }
}
