'use server';

/**
 * Server actions для блока «Сигнальный образец» в карточке заказа.
 *
 * См. `apps/api/src/modules/order-samples/*`,
 * `apps/web/lib/order-samples-api.ts`,
 * `apps/web/components/orders/samples/*`,
 * `docs/order-signal-sample-flow.md`.
 *
 * Контракт sumbit-а / state-объекта совпадает с другими actions
 * блока заказа (`material-issues-actions.ts`,
 * `applications-actions.ts`): `ok`, `error`, `fieldErrors`,
 * `successMessage`. Совместим с `useFormState`.
 */

import { revalidatePath } from 'next/cache';
import {
  ApproveOrderSampleSchema,
  CancelOrderSampleSchema,
  RejectOrderSampleSchema,
  StartOrderSampleSchema,
  type ApproveOrderSampleDto,
  type CancelOrderSampleDto,
  type RejectOrderSampleDto,
  type StartOrderSampleDto,
} from '@sewing/shared/order-samples';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  approveOrderSample,
  cancelOrderSample,
  rejectOrderSample,
  startOrderSample,
} from '@/lib/order-samples-api';
import type { OrderSampleFormState } from '@/lib/order-samples-domain';

// `OrderSampleFormState` и `initialOrderSampleFormState` сознательно
// живут в `@/lib/order-samples-domain` — Next.js App Router запрещает
// не-async exports из файла с `'use server'` (runtime: «A "use server"
// file can only export async functions, found object»).

function explainApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return fallback;
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId)`:
 * `(orderId, prev, formData) → next`.
 *
 * Поля FormData (`<form>`-сабмит из start-order-sample-modal):
 *   - `productId`, `sizeId`, `routeTemplateId?`
 *   - `qty` (int)
 *   - `materialMode` (SAMPLE_ONLY | FULL_ORDER)
 *   - `countsTowardOrderQty` — checkbox-switch. Form FormData
 *     возвращает `"on"` при включении, отсутствие при выключении.
 *   - `comment?`, `cutterId?`
 */
export async function startOrderSampleAction(
  orderId: string,
  _prev: OrderSampleFormState,
  form: FormData,
): Promise<OrderSampleFormState> {
  const candidate = {
    productId: (() => {
      const v = form.get('productId');
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    })(),
    sizeId: String(form.get('sizeId') ?? '').trim(),
    qty: Number(form.get('qty') ?? '1'),
    routeTemplateId: (() => {
      const v = form.get('routeTemplateId');
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    })(),
    materialMode: String(form.get('materialMode') ?? '').trim(),
    countsTowardOrderQty: form.get('countsTowardOrderQty') === 'on',
    comment: (() => {
      const v = form.get('comment');
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    })(),
    cutterId: (() => {
      const v = form.get('cutterId');
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    })(),
  };

  const parsed = StartOrderSampleSchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.')] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }
  const dto: StartOrderSampleDto = parsed.data;

  try {
    const created = await startOrderSample(orderId, dto);
    revalidateOrder(orderId);
    return {
      ok: true,
      createdId: created.id,
      successMessage: `Сигнальный образец запущен (паспорт ${created.passport?.number ?? '—'})`,
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось запустить сигнальный образец'),
    };
  }
}

// ---------------------------------------------------------------------------
// APPROVE / REJECT / CANCEL
// ---------------------------------------------------------------------------

export async function approveOrderSampleAction(
  orderId: string,
  id: string,
  _prev: OrderSampleFormState,
  form: FormData,
): Promise<OrderSampleFormState> {
  const candidate = {
    comment: (() => {
      const v = form.get('comment');
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    })(),
  };
  const parsed = ApproveOrderSampleSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  const dto: ApproveOrderSampleDto = parsed.data;
  try {
    await approveOrderSample(id, dto);
    revalidateOrder(orderId);
    return { ok: true, successMessage: 'Сигнальный образец согласован.' };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось согласовать образец'),
    };
  }
}

export async function rejectOrderSampleAction(
  orderId: string,
  id: string,
  _prev: OrderSampleFormState,
  form: FormData,
): Promise<OrderSampleFormState> {
  const reasonRaw = form.get('reason');
  const candidate = {
    reason: typeof reasonRaw === 'string' ? reasonRaw.trim() : '',
  };
  const parsed = RejectOrderSampleSchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.')] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }
  const dto: RejectOrderSampleDto = parsed.data;
  try {
    await rejectOrderSample(id, dto);
    revalidateOrder(orderId);
    return { ok: true, successMessage: 'Сигнальный образец отклонён.' };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось отклонить образец'),
    };
  }
}

export async function cancelOrderSampleAction(
  orderId: string,
  id: string,
  _prev: OrderSampleFormState,
  form: FormData,
): Promise<OrderSampleFormState> {
  const candidate = {
    comment: (() => {
      const v = form.get('comment');
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    })(),
  };
  const parsed = CancelOrderSampleSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  const dto: CancelOrderSampleDto = parsed.data;
  try {
    await cancelOrderSample(id, dto);
    revalidateOrder(orderId);
    return { ok: true, successMessage: 'Сигнальный образец отменён.' };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось отменить образец'),
    };
  }
}
