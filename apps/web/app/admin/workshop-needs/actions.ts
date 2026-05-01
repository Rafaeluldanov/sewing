'use server';

/**
 * Server actions блока «Потребность цеха».
 *
 * RBAC — на backend (`@Roles('ADMIN', 'SHOP_MANAGER')` в
 * `WorkshopNeedsController` / `WorkshopNeedsOrderController`).
 * Frontend дополнительно прячет навигацию через
 * `NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS=1` (см. admin-sidebar.tsx).
 */

import { revalidatePath } from 'next/cache';
import {
  UpdateWorkshopNeedSchema,
  type UpdateWorkshopNeedDto,
} from '@sewing/shared/workshop-needs';
import { ApiRequestError } from '@/lib/api';
import {
  calculateOrderWorkshopNeeds,
  cancelWorkshopNeed,
  updateWorkshopNeed,
} from '@/lib/workshop-needs-api';
import type {
  CalculateWorkshopNeedsState,
  CancelWorkshopNeedState,
  UpdateWorkshopNeedState,
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

/**
 * Снимает одно поле формы в DTO `UpdateWorkshopNeedDto`. Если ключа
 * в форме нет — поле не идёт в DTO (Backend оставит колонку как есть).
 * Если ключ есть, но значение пустое — отправляем пустую строку, Zod
 * нормализует её в `null` (стирание поля).
 */
function buildUpdateDto(form: FormData): UpdateWorkshopNeedDto {
  const dto: UpdateWorkshopNeedDto = {};
  if (form.has('purchaseQty')) {
    const v = String(form.get('purchaseQty') ?? '').trim();
    dto.purchaseQty = v === '' ? null : v;
  }
  if (form.has('status')) {
    const v = String(form.get('status') ?? '').trim();
    if (v !== '') dto.status = v as UpdateWorkshopNeedDto['status'];
  }
  if (form.has('supplierNameText')) {
    dto.supplierNameText = String(form.get('supplierNameText') ?? '');
  }
  if (form.has('purchaseItemNameText')) {
    dto.purchaseItemNameText = String(form.get('purchaseItemNameText') ?? '');
  }
  if (form.has('quotedPrice')) {
    const v = String(form.get('quotedPrice') ?? '').trim();
    dto.quotedPrice = v === '' ? null : v;
  }
  if (form.has('quotedCurrency')) {
    // Этап «Себестоимость заказа»: валюта строки сужена до RUB/USD
    // (см. `MoneyCurrencySchema`). Zod-схема `UpdateWorkshopNeedSchema`
    // сама нормализует пустую строку в `null` и `lowercase` → uppercase,
    // поэтому передаём как есть.
    const v = String(form.get('quotedCurrency') ?? '').trim();
    dto.quotedCurrency = v === '' ? null : (v as 'RUB' | 'USD');
  }
  if (form.has('expectedDeliveryDate')) {
    const v = String(form.get('expectedDeliveryDate') ?? '').trim();
    dto.expectedDeliveryDate = v === '' ? null : v;
  }
  if (form.has('comment')) {
    dto.comment = String(form.get('comment') ?? '');
  }
  // Этап 5 «Поставщики»: пустая строка → null (закупщик очищает связь).
  if (form.has('selectedSupplierId')) {
    const v = String(form.get('selectedSupplierId') ?? '').trim();
    dto.selectedSupplierId = v === '' ? null : v;
  }
  if (form.has('selectedSupplierCatalogItemId')) {
    const v = String(form.get('selectedSupplierCatalogItemId') ?? '').trim();
    dto.selectedSupplierCatalogItemId = v === '' ? null : v;
  }
  return dto;
}

export async function updateWorkshopNeedAction(
  needId: string,
  _prev: UpdateWorkshopNeedState,
  form: FormData,
): Promise<UpdateWorkshopNeedState> {
  const parsed = UpdateWorkshopNeedSchema.safeParse(buildUpdateDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const updated = await updateWorkshopNeed(needId, parsed.data);
    revalidatePath('/admin/workshop-needs');
    revalidatePath(`/admin/workshop-needs/${needId}`);
    revalidatePath(`/admin/orders/${updated.orderId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function cancelWorkshopNeedAction(
  needId: string,
  _prev: CancelWorkshopNeedState,
  _form: FormData,
): Promise<CancelWorkshopNeedState> {
  try {
    const cancelled = await cancelWorkshopNeed(needId);
    revalidatePath('/admin/workshop-needs');
    revalidatePath(`/admin/workshop-needs/${needId}`);
    revalidatePath(`/admin/orders/${cancelled.orderId}`);
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function calculateOrderWorkshopNeedsAction(
  orderId: string,
  _prev: CalculateWorkshopNeedsState,
  form: FormData,
): Promise<CalculateWorkshopNeedsState> {
  const force = form.get('force') === '1';
  try {
    const result = await calculateOrderWorkshopNeeds(orderId, { force });
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/admin/workshop-needs');
    return {
      ok: true,
      successMessage: `Рассчитано строк: ${result.count}`,
      summary: {
        count: result.count,
        methods: result.methods,
        warnings: result.warnings,
      },
    };
  } catch (e) {
    const x = explainApiError(e);
    return {
      error: x.error,
      errorCode: x.code,
      alreadyReviewed: x.code === 'WORKSHOP_NEEDS_ALREADY_REVIEWED',
    };
  }
}
