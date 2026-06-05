'use server';

/**
 * Server actions блока «Заказы поставщикам» (Этап 6А).
 *
 * RBAC — на backend (`@Roles('ADMIN', 'SHOP_MANAGER')` в
 * `PurchaseOrdersController`). Frontend дополнительно прячет
 * навигацию через `NEXT_PUBLIC_FEATURE_PURCHASE_ORDERS=1`
 * (см. `admin-sidebar.tsx`).
 */

import { revalidatePath } from 'next/cache';
import {
  CreatePurchaseOrderFromNeedsSchema,
  UpdatePurchaseOrderLineSchema,
  UpdatePurchaseOrderSchema,
  type CreatePurchaseOrderFromNeedsDto,
  type UpdatePurchaseOrderDto,
  type UpdatePurchaseOrderLineDto,
} from '@sewing/shared/purchase-orders';
import { ApiRequestError } from '@/lib/api';
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrderFromNeeds,
  reopenPurchaseOrder,
  sendPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderLine,
} from '@/lib/purchase-orders-api';
import type {
  CreatePurchaseOrderFromNeedsState,
  PurchaseOrderActionState,
  UpdatePurchaseOrderLineState,
  UpdatePurchaseOrderState,
} from './form-state';

function explainApiError(e: unknown): {
  error: string;
  code?: string;
  requestId?: string;
} {
  if (e instanceof ApiRequestError) {
    return {
      error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
      code: e.code,
      requestId: e.requestId,
    };
  }
  return { error: 'Не удалось выполнить запрос' };
}

function buildCreateDto(form: FormData): CreatePurchaseOrderFromNeedsDto {
  const ids: string[] = [];
  for (const v of form.getAll('workshopNeedIds')) {
    const s = String(v ?? '').trim();
    if (s !== '') ids.push(s);
  }
  // Поддерживаем альтернативное имя поля, если форма прислала
  // одиночный id (`workshopNeedId`).
  if (form.has('workshopNeedId')) {
    const single = String(form.get('workshopNeedId') ?? '').trim();
    if (single !== '') ids.push(single);
  }
  const dto: CreatePurchaseOrderFromNeedsDto = {
    workshopNeedIds: ids,
  };
  if (form.has('comment')) {
    dto.comment = String(form.get('comment') ?? '');
  }
  if (form.has('expectedDeliveryDate')) {
    const v = String(form.get('expectedDeliveryDate') ?? '').trim();
    dto.expectedDeliveryDate = v === '' ? null : v;
  }
  return dto;
}

export async function createPurchaseOrderFromNeedsAction(
  _prev: CreatePurchaseOrderFromNeedsState,
  form: FormData,
): Promise<CreatePurchaseOrderFromNeedsState> {
  const parsed = CreatePurchaseOrderFromNeedsSchema.safeParse(
    buildCreateDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const created = await createPurchaseOrderFromNeeds(parsed.data);
    revalidatePath('/admin/purchase-orders');
    revalidatePath('/admin/workshop-needs');
    if (created.customerOrderId) {
      revalidatePath(`/admin/orders/${created.customerOrderId}`);
    }
    for (const id of parsed.data.workshopNeedIds) {
      revalidatePath(`/admin/workshop-needs/${id}`);
    }
    return {
      ok: true,
      redirectTo: `/admin/purchase-orders/${created.id}`,
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorCode: x.code, errorRequestId: x.requestId };
  }
}

function buildUpdateDto(form: FormData): UpdatePurchaseOrderDto {
  const dto: UpdatePurchaseOrderDto = {};
  if (form.has('comment')) {
    dto.comment = String(form.get('comment') ?? '');
  }
  if (form.has('expectedDeliveryDate')) {
    const v = String(form.get('expectedDeliveryDate') ?? '').trim();
    dto.expectedDeliveryDate = v === '' ? null : v;
  }
  if (form.has('status')) {
    const v = String(form.get('status') ?? '').trim();
    if (v !== '') dto.status = v as UpdatePurchaseOrderDto['status'];
  }
  return dto;
}

export async function updatePurchaseOrderAction(
  id: string,
  _prev: UpdatePurchaseOrderState,
  form: FormData,
): Promise<UpdatePurchaseOrderState> {
  const parsed = UpdatePurchaseOrderSchema.safeParse(buildUpdateDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const updated = await updatePurchaseOrder(id, parsed.data);
    revalidatePath('/admin/purchase-orders');
    revalidatePath(`/admin/purchase-orders/${id}`);
    if (updated.customerOrderId) {
      revalidatePath(`/admin/orders/${updated.customerOrderId}`);
    }
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

function buildLineDto(form: FormData): UpdatePurchaseOrderLineDto {
  const dto: UpdatePurchaseOrderLineDto = {};
  if (form.has('qty')) {
    const v = String(form.get('qty') ?? '').trim();
    if (v !== '') dto.qty = v;
  }
  if (form.has('price')) {
    const v = String(form.get('price') ?? '').trim();
    dto.price = v === '' ? null : v;
  }
  if (form.has('currency')) {
    dto.currency = String(form.get('currency') ?? '');
  }
  if (form.has('expectedDeliveryDate')) {
    const v = String(form.get('expectedDeliveryDate') ?? '').trim();
    dto.expectedDeliveryDate = v === '' ? null : v;
  }
  if (form.has('confirmedQty')) {
    const v = String(form.get('confirmedQty') ?? '').trim();
    dto.confirmedQty = v === '' ? null : v;
  }
  if (form.has('confirmedPrice')) {
    const v = String(form.get('confirmedPrice') ?? '').trim();
    dto.confirmedPrice = v === '' ? null : v;
  }
  if (form.has('confirmedDeliveryDate')) {
    const v = String(form.get('confirmedDeliveryDate') ?? '').trim();
    dto.confirmedDeliveryDate = v === '' ? null : v;
  }
  if (form.has('comment')) {
    dto.comment = String(form.get('comment') ?? '');
  }
  if (form.has('status')) {
    const v = String(form.get('status') ?? '').trim();
    if (v !== '') dto.status = v as UpdatePurchaseOrderLineDto['status'];
  }
  return dto;
}

export async function updatePurchaseOrderLineAction(
  orderId: string,
  lineId: string,
  _prev: UpdatePurchaseOrderLineState,
  form: FormData,
): Promise<UpdatePurchaseOrderLineState> {
  const parsed = UpdatePurchaseOrderLineSchema.safeParse(buildLineDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updatePurchaseOrderLine(orderId, lineId, parsed.data);
    revalidatePath(`/admin/purchase-orders/${orderId}`);
    return { ok: true, successMessage: 'Строка сохранена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function sendPurchaseOrderAction(
  id: string,
  _prev: PurchaseOrderActionState,
  _form: FormData,
): Promise<PurchaseOrderActionState> {
  try {
    const sent = await sendPurchaseOrder(id);
    revalidatePath('/admin/purchase-orders');
    revalidatePath(`/admin/purchase-orders/${id}`);
    if (sent.customerOrderId) {
      revalidatePath(`/admin/orders/${sent.customerOrderId}`);
    }
    return { ok: true, successMessage: 'Отправлено поставщику.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function confirmPurchaseOrderAction(
  id: string,
  _prev: PurchaseOrderActionState,
  _form: FormData,
): Promise<PurchaseOrderActionState> {
  try {
    const confirmed = await confirmPurchaseOrder(id, {});
    revalidatePath('/admin/purchase-orders');
    revalidatePath(`/admin/purchase-orders/${id}`);
    if (confirmed.customerOrderId) {
      revalidatePath(`/admin/orders/${confirmed.customerOrderId}`);
    }
    return { ok: true, successMessage: 'Подтверждено поставщиком.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function reopenPurchaseOrderAction(
  id: string,
  _prev: PurchaseOrderActionState,
  _form: FormData,
): Promise<PurchaseOrderActionState> {
  try {
    const reopened = await reopenPurchaseOrder(id);
    revalidatePath('/admin/purchase-orders');
    revalidatePath(`/admin/purchase-orders/${id}`);
    if (reopened.customerOrderId) {
      revalidatePath(`/admin/orders/${reopened.customerOrderId}`);
    }
    const label =
      reopened.status === 'DRAFT'
        ? 'Заказ возвращён в черновик.'
        : 'Подтверждение снято — заказ снова «Отправлен».';
    return { ok: true, successMessage: label };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function cancelPurchaseOrderAction(
  id: string,
  _prev: PurchaseOrderActionState,
  _form: FormData,
): Promise<PurchaseOrderActionState> {
  try {
    const cancelled = await cancelPurchaseOrder(id);
    revalidatePath('/admin/purchase-orders');
    revalidatePath(`/admin/purchase-orders/${id}`);
    revalidatePath('/admin/workshop-needs');
    if (cancelled.customerOrderId) {
      revalidatePath(`/admin/orders/${cancelled.customerOrderId}`);
    }
    for (const line of cancelled.lines) {
      if (line.workshopNeedId) {
        revalidatePath(`/admin/workshop-needs/${line.workshopNeedId}`);
      }
    }
    return { ok: true, successMessage: 'Заказ поставщику отменён.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
