'use server';

/**
 * Server actions для модуля заказов.
 *
 * Мы парсим `FormData`, собираем DTO согласно `@sewing/shared/orders`,
 * и делегируем Nest API. Ошибки API пробрасываем в вызывающий компонент
 * в виде `{ error: string }` — компонент сам рендерит.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreateOrderSchema,
  UpdateOrderSchema,
  type CreateOrderDto,
  type UpdateOrderDto,
} from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import {
  cancelOrder,
  completeOrder,
  createOrder,
  startOrder,
  updateOrder,
} from '@/lib/orders-api';

export interface FormActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

function extractItems(form: FormData): { sizeId: string; qtyPlan: number }[] {
  const items: { sizeId: string; qtyPlan: number }[] = [];
  for (const [key, value] of form.entries()) {
    const m = /^qty\[(.+)]$/.exec(key);
    if (!m) continue;
    const sizeId = m[1];
    const raw = String(value ?? '').trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    items.push({ sizeId, qtyPlan: Math.trunc(n) });
  }
  return items;
}

function buildCreateDto(form: FormData): CreateOrderDto {
  const items = extractItems(form);
  const orderDate = String(form.get('orderDate') ?? '').trim();
  const productId = String(form.get('productId') ?? '').trim();
  const color = String(form.get('color') ?? '').trim() || undefined;
  const comment = String(form.get('comment') ?? '').trim() || undefined;
  const routeTemplateId =
    String(form.get('routeTemplateId') ?? '').trim() || undefined;
  // Tech card MVP (ADR-0022): пустой select = «без техкарты».
  const techCardId =
    String(form.get('techCardId') ?? '').trim() || undefined;
  return {
    orderDate,
    productId,
    color,
    comment,
    items,
    routeTemplateId,
    techCardId,
  };
}

function buildUpdateDto(form: FormData): UpdateOrderDto {
  const items = extractItems(form);
  /**
   * Семантика `routeTemplateId` в редактировании:
   *   - поле в форме отсутствует → undefined → backend не трогает привязку;
   *   - поле есть и пустое → null → backend снимает привязку;
   *   - поле есть и непустое → string → backend меняет/ставит шаблон.
   * Первый кейс важен, чтобы случайный submit формы без поля «маршрута»
   * (например, на странице, где маршрут не редактируется) не сбрасывал
   * привязку.
   */
  const routeRaw = form.get('routeTemplateId');
  let routeTemplateId: string | null | undefined;
  if (routeRaw === null) {
    routeTemplateId = undefined;
  } else {
    const v = String(routeRaw).trim();
    routeTemplateId = v === '' ? null : v;
  }
  // Tech card MVP (ADR-0022): семантика идентична routeTemplateId —
  // отсутствие поля = не трогать, пустая строка = очистить, иначе =
  // переустановить.
  const techCardRaw = form.get('techCardId');
  let techCardId: string | null | undefined;
  if (techCardRaw === null) {
    techCardId = undefined;
  } else {
    const v = String(techCardRaw).trim();
    techCardId = v === '' ? null : v;
  }
  const dto: UpdateOrderDto = {
    orderDate: String(form.get('orderDate') ?? '').trim() || undefined,
    productId: String(form.get('productId') ?? '').trim() || undefined,
    color: optionalString(form.get('color')),
    comment: optionalString(form.get('comment')),
    items: items.length > 0 ? items : undefined,
    routeTemplateId,
    techCardId,
  };
  return dto;
}

function optionalString(v: FormDataEntryValue | null): string | undefined {
  if (v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить запрос';
}

export async function createOrderAction(
  _prev: FormActionState,
  form: FormData,
): Promise<FormActionState> {
  const raw = buildCreateDto(form);
  const parsed = CreateOrderSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      fieldErrors[path] = issue.message;
    }
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }
  try {
    const created = await createOrder(parsed.data);
    revalidatePath('/orders');
    redirect(`/orders/${created.id}`);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
}

export async function updateOrderAction(
  id: string,
  _prev: FormActionState,
  form: FormData,
): Promise<FormActionState> {
  const raw = buildUpdateDto(form);
  const parsed = UpdateOrderSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateOrder(id, parsed.data);
    revalidatePath('/orders');
    revalidatePath(`/orders/${id}`);
    redirect(`/orders/${id}`);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
}

export async function startOrderAction(id: string): Promise<void> {
  try {
    await startOrder(id);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  revalidatePath('/orders');
  revalidatePath(`/orders/${id}`);
}

export async function completeOrderAction(id: string): Promise<void> {
  try {
    await completeOrder(id);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  revalidatePath('/orders');
  revalidatePath(`/orders/${id}`);
}

export async function cancelOrderAction(id: string): Promise<void> {
  try {
    await cancelOrder(id);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  revalidatePath('/orders');
  revalidatePath(`/orders/${id}`);
}

function isNextRedirect(e: unknown): boolean {
  // `redirect()` в Next.js 14 бросает специальный error с `digest` вида 'NEXT_REDIRECT;...'.
  return (
    typeof e === 'object' &&
    e !== null &&
    'digest' in e &&
    typeof (e as { digest?: unknown }).digest === 'string' &&
    (e as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}
