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
  UpdatePurchaseReceiptLineSchema,
  type CancelPurchaseReceiptDto,
} from '@sewing/shared/purchase-receipts';
import { ApiRequestError } from '@/lib/api';
import {
  cancelPurchaseReceipt,
  createPurchaseReceiptFromPurchaseOrder,
  postPurchaseReceipt,
  updatePurchaseReceiptLine,
} from '@/lib/purchase-receipts-api';
import type {
  CancelPurchaseReceiptState,
  CreatePurchaseReceiptState,
  PostPurchaseReceiptState,
  UpdatePurchaseReceiptLineState,
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
  draft: boolean;
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
  // `intent=draft` приходит от кнопки «Сохранить черновик». Кнопка
  // «Принять поступление» отправляет `intent=post` (или ничего).
  const draft = String(form.get('intent') ?? '').trim() === 'draft';
  return {
    purchaseOrderId,
    receivedAt: receivedAtRaw === '' ? null : receivedAtRaw,
    comment: readOptionalText(form, 'comment'),
    draft,
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

/**
 * Провести черновик приёмки (`DRAFT → POSTED`). Здесь же на backend
 * проверяется лимит переприёмки и двигаются остатки.
 */
export async function postPurchaseReceiptAction(
  id: string,
  _prev: PostPurchaseReceiptState,
  _form: FormData,
): Promise<PostPurchaseReceiptState> {
  try {
    const posted = await postPurchaseReceipt(id);
    revalidatePath('/admin/purchase-receipts');
    revalidatePath(`/admin/purchase-receipts/${id}`);
    revalidatePath('/admin/purchase-orders');
    if (posted.purchaseOrderId) {
      revalidatePath(`/admin/purchase-orders/${posted.purchaseOrderId}`);
    }
    if (posted.customerOrderId) {
      revalidatePath(`/admin/orders/${posted.customerOrderId}`);
    }
    revalidatePath('/admin/workshop-needs');
    return { ok: true, successMessage: 'Приёмка проведена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Правка одной строки приёмки. Состав полей собирается в самой
 * форме; здесь только то, что пришло (не передаём `undefined`-поля,
 * чтобы не затирать значения).
 */
export async function updatePurchaseReceiptLineAction(
  receiptId: string,
  lineId: string,
  _prev: UpdatePurchaseReceiptLineState,
  form: FormData,
): Promise<UpdatePurchaseReceiptLineState> {
  const candidate: Record<string, string | null> = {};
  // Поля, которые форма реально показывает. Пустая строка → null
  // (очистить), отсутствие ключа в форме → поле не трогаем.
  const textFields = [
    'batchNumber',
    'rollNumber',
    'shade',
    'locationNote',
    'comment',
  ] as const;
  for (const f of textFields) {
    if (form.has(f)) candidate[f] = readOptionalText(form, f);
  }
  for (const f of ['actualWidthCm', 'actualDensityGsm'] as const) {
    if (form.has(f)) candidate[f] = readOptionalNumber(form, f);
  }
  // Складские поля приходят только для черновика (форма их прячет у
  // проведённого документа).
  if (form.has('receivedQty')) {
    const v = String(form.get('receivedQty') ?? '').trim();
    if (v !== '') candidate.receivedQty = v;
  }
  if (form.has('cellId')) candidate.cellId = readOptionalText(form, 'cellId');

  const parsed = UpdatePurchaseReceiptLineSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const updated = await updatePurchaseReceiptLine(
      receiptId,
      lineId,
      parsed.data,
    );
    revalidatePath('/admin/purchase-receipts');
    revalidatePath(`/admin/purchase-receipts/${receiptId}`);
    if (updated.purchaseOrderId) {
      revalidatePath(`/admin/purchase-orders/${updated.purchaseOrderId}`);
    }
    return { ok: true, successMessage: 'Строка обновлена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
