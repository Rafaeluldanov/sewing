'use server';

/**
 * Server action режима «Редактировать маршрут заказа» в блоке
 * «Операции» карточки заказа: правка расценок / норм времени операций
 * **в рамках заказа** одним сабмитом («Сохранить всё»).
 *
 * См. `apps/api/src/modules/orders/orders.controller.ts`
 * (`PUT /orders/:id/route-overrides`), `apps/web/lib/orders-api.ts`
 * (`updateOrderRouteOverrides`),
 * `apps/web/components/orders/operations/order-route-overrides-editor.tsx`.
 *
 * Не трогает справочник `Operation` и шаблон маршрута — переопределения
 * живут только на снимке маршрута заказа. После успеха —
 * `revalidatePath('/admin/orders/[id]')`, чтобы RSC-таблица операций
 * перечитала снимок и пересчитала итог.
 */

import { revalidatePath } from 'next/cache';
import { UpdateOrderRouteOverridesSchema } from '@sewing/shared/routes';
import { ApiRequestError, errorText } from '@/lib/api';
import { updateOrderRouteOverrides } from '@/lib/orders-api';
import type { RouteOverridesFormState } from './route-overrides-form-state';

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
}

export async function saveOrderRouteOverridesAction(
  orderId: string,
  _prev: RouteOverridesFormState,
  form: FormData,
): Promise<RouteOverridesFormState> {
  const raw = form.get('payload');
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(String(raw)) : null;
  } catch {
    json = null;
  }

  const parsed = UpdateOrderRouteOverridesSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }

  try {
    await updateOrderRouteOverrides(orderId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, doneToken: `saved:${Date.now()}` };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось сохранить расценки/нормы заказа',
    };
  }
}
