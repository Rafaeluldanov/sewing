'use server';

import { revalidatePath } from 'next/cache';
import {
  CreateCuttingClosureRequestSchema,
  ReviewCuttingClosureRequestSchema,
  type CreateCuttingClosureRequestDto,
  type ReviewCuttingClosureRequestDto,
} from '@sewing/shared/cutting-closure';
import { ApiRequestError } from '@/lib/api';
import {
  approveCuttingClosureRequest,
  createCuttingClosureRequest,
  rejectCuttingClosureRequest,
} from '@/lib/cutting-closure-api';

export interface CuttingClosureFormState {
  error?: string;
  ok?: boolean;
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить запрос';
}

/**
 * Помощник раскройщика подаёт заявку на закрытие раскроя по строке
 * `(orderId, productId, sizeId)`. После успеха перерисовываем
 * страницу паспорта и заказа — там обновятся блок заявки и
 * (опционально) cutting closure summary.
 */
export async function requestCuttingClosureAction(
  passportId: string,
  orderId: string,
  productId: string,
  sizeId: string,
  _prev: CuttingClosureFormState,
  form: FormData,
): Promise<CuttingClosureFormState> {
  const raw: CreateCuttingClosureRequestDto = {
    orderId,
    productId,
    sizeId,
    reason: String(form.get('reason') ?? '').trim() || undefined,
  };
  const parsed = CreateCuttingClosureRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await createCuttingClosureRequest(parsed.data);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/passports/${passportId}`);
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

export async function approveCuttingClosureAction(
  requestId: string,
  passportId: string,
  orderId: string,
  form: FormData,
): Promise<CuttingClosureFormState> {
  const raw: ReviewCuttingClosureRequestDto = {
    note: String(form.get('note') ?? '').trim() || undefined,
  };
  const parsed = ReviewCuttingClosureRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await approveCuttingClosureRequest(requestId, parsed.data);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/passports/${passportId}`);
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

export async function rejectCuttingClosureAction(
  requestId: string,
  passportId: string,
  orderId: string,
  form: FormData,
): Promise<CuttingClosureFormState> {
  const raw: ReviewCuttingClosureRequestDto = {
    note: String(form.get('note') ?? '').trim() || undefined,
  };
  const parsed = ReviewCuttingClosureRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await rejectCuttingClosureRequest(requestId, parsed.data);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/passports/${passportId}`);
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
