'use server';

/**
 * Server action создания заявки на оплату по заказу поставщику.
 *
 * Клиент (`CreatePaymentRequestDialog`) собирает `FormData`:
 *   - `payload` — JSON `CreateSupplierPaymentRequestDto` (сумма,
 *     реквизиты, этапы);
 *   - `files`   — повторяющееся поле с прикреплёнными `File` (счёт и
 *     доп. документы).
 *
 * FormData форвардится одним аргументом (Next 14 не принимает `File[]`
 * top-level — см. memory `feedback-server-action-file-array`).
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  CreateSupplierPaymentRequestSchema,
  UpdateSupplierPaymentRequestSchema,
  type SupplierPaymentRequestDetailDto,
} from '@sewing/shared/supplier-payment-requests';
import {
  createSupplierPaymentRequest,
  deleteSupplierPaymentRequest,
  getSupplierPaymentRequest,
  updateSupplierPaymentRequest,
} from '@/lib/supplier-payment-requests-api';

export interface CreatePaymentRequestActionResult {
  ok: boolean;
  error?: string;
  errorRequestId?: string;
}

export async function createSupplierPaymentRequestAction(
  purchaseOrderId: string,
  formData: FormData,
): Promise<CreatePaymentRequestActionResult> {
  const payloadRaw = formData.get('payload');
  if (typeof payloadRaw !== 'string') {
    return { ok: false, error: 'Поле payload обязательно.' };
  }
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadRaw);
  } catch {
    return { ok: false, error: 'Невалидный JSON в payload.' };
  }
  const parsed = CreateSupplierPaymentRequestSchema.safeParse(payloadJson);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные заявки.',
    };
  }
  try {
    // Пересобираем FormData: payload — ровно тот, что прошёл zod (без
    // UI-only полей), плюс файлы как есть.
    const out = new FormData();
    out.append('payload', JSON.stringify(parsed.data));
    for (const entry of formData.getAll('files')) {
      if (entry instanceof File) {
        out.append('files', entry, entry.name);
      }
    }
    await createSupplierPaymentRequest(purchaseOrderId, out);
    revalidatePath(`/admin/purchase-orders/${purchaseOrderId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e), errorRequestId: e.requestId };
    }
    return { ok: false, error: 'Не удалось создать заявку на оплату.' };
  }
}

/**
 * Загрузить детальную карточку заявки (для предзаполнения формы
 * редактирования из клиентского компонента — `apiFetch` ходит в API
 * только с сервера).
 */
export async function getSupplierPaymentRequestDetailAction(
  requestId: string,
): Promise<{
  ok: boolean;
  request?: SupplierPaymentRequestDetailDto;
  error?: string;
}> {
  try {
    const request = await getSupplierPaymentRequest(requestId);
    return { ok: true, request };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e) };
    }
    return { ok: false, error: 'Не удалось загрузить заявку на оплату.' };
  }
}

/**
 * Редактировать заявку. Как и при создании, `formData` собирается на
 * клиенте (`payload` JSON + новые `files`), валидируется и пересобирается
 * здесь (без UI-only полей).
 */
export async function updateSupplierPaymentRequestAction(
  purchaseOrderId: string,
  requestId: string,
  formData: FormData,
): Promise<CreatePaymentRequestActionResult> {
  const payloadRaw = formData.get('payload');
  if (typeof payloadRaw !== 'string') {
    return { ok: false, error: 'Поле payload обязательно.' };
  }
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadRaw);
  } catch {
    return { ok: false, error: 'Невалидный JSON в payload.' };
  }
  const parsed = UpdateSupplierPaymentRequestSchema.safeParse(payloadJson);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные заявки.',
    };
  }
  try {
    const out = new FormData();
    out.append('payload', JSON.stringify(parsed.data));
    for (const entry of formData.getAll('files')) {
      if (entry instanceof File) {
        out.append('files', entry, entry.name);
      }
    }
    await updateSupplierPaymentRequest(requestId, out);
    revalidatePath(`/admin/purchase-orders/${purchaseOrderId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e), errorRequestId: e.requestId };
    }
    return { ok: false, error: 'Не удалось сохранить заявку на оплату.' };
  }
}

/** Удалить заявку на оплату. */
export async function deleteSupplierPaymentRequestAction(
  purchaseOrderId: string,
  requestId: string,
): Promise<{ ok: boolean; error?: string; errorRequestId?: string }> {
  try {
    await deleteSupplierPaymentRequest(requestId);
    revalidatePath(`/admin/purchase-orders/${purchaseOrderId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e), errorRequestId: e.requestId };
    }
    return { ok: false, error: 'Не удалось удалить заявку на оплату.' };
  }
}
