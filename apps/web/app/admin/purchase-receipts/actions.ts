'use server';

/**
 * Server actions блока «Приёмка поставок» (Этап 7А).
 *
 * RBAC — на backend (`@Roles('ADMIN', 'SHOP_MANAGER')` в
 * `PurchaseReceiptsController`). Frontend дополнительно прячет
 * навигацию через `NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS=1`
 * (см. `admin-sidebar.tsx`).
 */

import { revalidatePath } from 'next/cache';
import {
  CancelPurchaseReceiptSchema,
  CreatePurchaseReceiptFromPurchaseOrderSchema,
  type CancelPurchaseReceiptDto,
} from '@sewing/shared/purchase-receipts';
import { ApiRequestError } from '@/lib/api';
import {
  cancelPurchaseReceipt,
  createPurchaseReceiptFromPurchaseOrder,
} from '@/lib/purchase-receipts-api';
import type {
  CancelPurchaseReceiptState,
  CreatePurchaseReceiptState,
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

function readOptionalText(form: FormData, name: string): string | null {
  const v = form.get(name);
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function readOptionalNumber(form: FormData, name: string): string | null {
  const v = form.get(name);
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Сырое тело запроса, которое мы отдаём в Zod-схему. Поля
 * `actualWidthCm`/`actualDensityGsm` принимаем как строки —
 * Zod-трансформ сам превратит их в `number | null`.
 */
type RawCreateInput = {
  purchaseOrderId: string;
  receivedAt: string | null;
  comment: string | null;
  lines: Array<{
    purchaseOrderLineId: string;
    receivedQty: string;
    cellId: string | null;
    batchNumber: string | null;
    rollNumber: string | null;
    shade: string | null;
    actualWidthCm: string | null;
    actualDensityGsm: string | null;
    locationNote: string | null;
    comment: string | null;
  }>;
};

function buildCreateDto(
  purchaseOrderId: string,
  form: FormData,
): RawCreateInput {
  const lineIds = new Set<string>();
  for (const v of form.getAll('lineId')) {
    const s = String(v ?? '').trim();
    if (s !== '') lineIds.add(s);
  }
  const lines: RawCreateInput['lines'] = [];
  for (const lineId of lineIds) {
    const qtyRaw = String(form.get(`receivedQty:${lineId}`) ?? '').trim();
    if (qtyRaw === '') {
      // Пропускаем строки без количества — закупщик не хочет принимать
      // эту позицию в этом документе.
      continue;
    }
    lines.push({
      purchaseOrderLineId: lineId,
      receivedQty: qtyRaw,
      cellId: readOptionalText(form, `cellId:${lineId}`),
      batchNumber: readOptionalText(form, `batchNumber:${lineId}`),
      rollNumber: readOptionalText(form, `rollNumber:${lineId}`),
      shade: readOptionalText(form, `shade:${lineId}`),
      actualWidthCm: readOptionalNumber(form, `actualWidthCm:${lineId}`),
      actualDensityGsm: readOptionalNumber(
        form,
        `actualDensityGsm:${lineId}`,
      ),
      locationNote: readOptionalText(form, `locationNote:${lineId}`),
      comment: readOptionalText(form, `lineComment:${lineId}`),
    });
  }
  const receivedAtRaw = String(form.get('receivedAt') ?? '').trim();
  return {
    purchaseOrderId,
    receivedAt: receivedAtRaw === '' ? null : receivedAtRaw,
    comment: readOptionalText(form, 'comment'),
    lines,
  };
}

export async function createPurchaseReceiptFromPurchaseOrderAction(
  purchaseOrderId: string,
  _prev: CreatePurchaseReceiptState,
  form: FormData,
): Promise<CreatePurchaseReceiptState> {
  const candidate = buildCreateDto(purchaseOrderId, form);
  if (candidate.lines.length === 0) {
    return {
      error:
        'Заполните «Принято» хотя бы по одной строке — иначе принимать нечего.',
    };
  }
  const parsed = CreatePurchaseReceiptFromPurchaseOrderSchema.safeParse(
    candidate,
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const created = await createPurchaseReceiptFromPurchaseOrder(parsed.data);
    revalidatePath('/admin/purchase-receipts');
    revalidatePath('/admin/purchase-orders');
    revalidatePath(`/admin/purchase-orders/${purchaseOrderId}`);
    revalidatePath(`/admin/purchase-orders/${purchaseOrderId}/receive`);
    if (created.customerOrderId) {
      revalidatePath(`/admin/orders/${created.customerOrderId}`);
    }
    revalidatePath('/admin/workshop-needs');
    return {
      ok: true,
      redirectTo: `/admin/purchase-receipts/${created.id}`,
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorCode: x.code, errorRequestId: x.requestId };
  }
}

function buildCancelDto(form: FormData): CancelPurchaseReceiptDto {
  const reason = readOptionalText(form, 'reason');
  return { reason };
}

export async function cancelPurchaseReceiptAction(
  id: string,
  _prev: CancelPurchaseReceiptState,
  form: FormData,
): Promise<CancelPurchaseReceiptState> {
  const parsed = CancelPurchaseReceiptSchema.safeParse(buildCancelDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const cancelled = await cancelPurchaseReceipt(id, parsed.data);
    revalidatePath('/admin/purchase-receipts');
    revalidatePath(`/admin/purchase-receipts/${id}`);
    revalidatePath('/admin/purchase-orders');
    if (cancelled.purchaseOrderId) {
      revalidatePath(`/admin/purchase-orders/${cancelled.purchaseOrderId}`);
    }
    if (cancelled.customerOrderId) {
      revalidatePath(`/admin/orders/${cancelled.customerOrderId}`);
    }
    revalidatePath('/admin/workshop-needs');
    return { ok: true, successMessage: 'Приёмка отменена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
