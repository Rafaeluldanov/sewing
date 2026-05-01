'use server';

/**
 * Server actions для admin-формы редактирования заказа
 * (`/admin/orders/[id]/edit`).
 *
 * Назначение:
 *   - распарсить `FormData` admin-формы в `UpdateOrderDto`;
 *   - провалидировать `UpdateOrderSchema`;
 *   - вызвать `orders-api.updateOrder(id, dto)`;
 *   - после успеха — вернуть `{ success: true }` и редиректнуть в
 *     карточку `/admin/orders/<id>`.
 *
 * FormData-контракт совпадает с тем, что собирает клиентский компонент
 * `AdminEditOrderForm` (см. соседний файл):
 *   - `orderDate`        (date, required)
 *   - `dueDate`          (date, optional, пусто = снять)
 *   - `clientId`         (string, optional, пусто = снять)
 *   - `patternItemId`    (string, optional, пусто = снять — главная
 *                         номенклатура; этап «Номенклатура = Лекала»)
 *   - `division`         (`MARKETPLACE | OTHER`, required)
 *   - `color`            (string, optional)
 *   - `comment`          (string, optional)
 *   - `routeTemplateId`  (string, optional, пусто = снять)
 *   - `techCardId`       (string, optional, пусто = снять)
 *   - `status`           (`DRAFT | IN_PRODUCTION | DONE | CANCELLED`)
 *   - `qty[<sizeId>]`    (number, только > 0 идут в `items`)
 *
 * Поле `productId` admin-форма больше НЕ шлёт — backend сам
 * пересинхронизирует `OrderItem.productId` со скрытым legacy Product
 * выбранного лекала в `OrdersService.update()` (см. этап
 * «Номенклатура = Лекала»). На уровне action это значит, что
 * `dto.productId` всегда `undefined`, а `OrdersService.update`
 * либо использует `currentProductId` (если лекало не менялось),
 * либо derived `patternLegacyProductId` (если менялось).
 *
 * Семантика «поле есть и пустое = снять / поле нет = не трогать»
 * наследована от `buildUpdateDto` в `apps/web/app/orders/actions.ts`,
 * чтобы backend (см. `OrdersService.update`) видел согласованный
 * контракт и от admin-формы, и от легаси `/orders/[id]/edit`.
 *
 * Бэкенд сам решает безопасность изменений (см. `OrdersService.update`):
 *   - «опасные» поля (items / productId / routeTemplateId / techCardId /
 *     division) допустимы только в DRAFT — иначе 409 ORDER_LOCKED;
 *   - смена `status` делегируется в `start/complete/cancel` через те же
 *     инварианты, что и существующие endpoints; недопустимый переход
 *     возвращает 409 ORDER_INVALID_TRANSITION.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ORDER_DIVISIONS,
  ORDER_STATUSES,
  UpdateOrderSchema,
  type OrderDivision,
  type OrderStatus,
  type UpdateOrderDto,
} from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { updateOrder } from '@/lib/orders-api';

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

function parseDivision(form: FormData): OrderDivision | undefined {
  const raw = String(form.get('division') ?? '').trim();
  if (raw === '') return undefined;
  return (ORDER_DIVISIONS as readonly string[]).includes(raw)
    ? (raw as OrderDivision)
    : undefined;
}

function parseStatus(form: FormData): OrderStatus | undefined {
  const raw = String(form.get('status') ?? '').trim();
  if (raw === '') return undefined;
  return (ORDER_STATUSES as readonly string[]).includes(raw)
    ? (raw as OrderStatus)
    : undefined;
}

function optionalNullableString(
  v: FormDataEntryValue | null,
): string | null | undefined {
  if (v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function optionalString(v: FormDataEntryValue | null): string | undefined {
  if (v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function buildUpdateDto(form: FormData): UpdateOrderDto {
  const items = extractItems(form);
  // Этап «Номенклатура = Лекала»: `productId` admin-форма больше не
  // шлёт. Старая «backward-compat» ветка (`form.get('productId')`)
  // здесь сознательно не нужна: даже если случайный вызов придёт
  // с `productId` (например, debug-скрипт), `OrdersService.update`
  // всё равно использует derived legacy Product из выбранного
  // лекала. Чтобы не зависеть от внешнего шума, не пробрасываем
  // поле в DTO — `currentProductId` подхватится сервисом.
  //
  // Этап «Цена продажи за единицу»: те же правила «поля нет = не
  // трогать», «поле есть и пустое = снять» (см.
  // `apps/web/app/orders/actions.ts::parseCustomerPriceFromForm`,
  // здесь дублируем локально, чтобы admin-edit-форма оставалась
  // независимой от actions.ts).
  const priceRaw = form.get('customerUnitPrice');
  let customerUnitPrice: string | null | undefined;
  if (priceRaw === null) {
    customerUnitPrice = undefined;
  } else {
    const v = String(priceRaw).trim();
    customerUnitPrice = v === '' ? null : v;
  }
  const currencyRaw = form.get('customerCurrency');
  let customerCurrency: 'RUB' | 'USD' | null | undefined;
  if (currencyRaw === null) {
    customerCurrency = undefined;
  } else {
    const v = String(currencyRaw).trim().toUpperCase();
    if (v === '') customerCurrency = null;
    else if (v === 'RUB' || v === 'USD') customerCurrency = v;
    else customerCurrency = null;
  }

  const dto: UpdateOrderDto = {
    orderDate: optionalString(form.get('orderDate')),
    color: optionalNullableString(form.get('color')),
    comment: optionalNullableString(form.get('comment')),
    customer: optionalNullableString(form.get('customer')),
    items: items.length > 0 ? items : undefined,
    routeTemplateId: optionalNullableString(form.get('routeTemplateId')),
    techCardId: optionalNullableString(form.get('techCardId')),
    // Этап «Номенклатура = Лекала»: семантика та же — поля нет
    // = не трогать, пустая строка = снять, иначе переустановить.
    // При смене лекала backend атомарно пересинхронизирует
    // `OrderItem.productId` со скрытым legacy Product этого лекала.
    patternItemId: optionalNullableString(form.get('patternItemId')),
    clientId: optionalNullableString(form.get('clientId')),
    dueDate: optionalNullableString(form.get('dueDate')),
    division: parseDivision(form),
    status: parseStatus(form),
    customerUnitPrice,
    customerCurrency,
  };
  return dto;
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить запрос';
}

function isNextRedirect(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'digest' in e &&
    typeof (e as { digest?: unknown }).digest === 'string' &&
    (e as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

/**
 * Server-action submit-а admin-формы редактирования заказа.
 *
 * Контракт result-shape повторяет легаси `updateOrderAction`
 * (`apps/web/app/orders/actions.ts`): возвращаем `{ error }` при
 * ошибке валидации/API, либо ничего не возвращаем (и редиректим)
 * при успехе.
 */
export async function updateAdminOrderAction(
  orderId: string,
  _prev: FormActionState,
  form: FormData,
): Promise<FormActionState> {
  const raw = buildUpdateDto(form);
  const parsed = UpdateOrderSchema.safeParse(raw);
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
    await updateOrder(orderId, parsed.data);
    // Инвалидируем оба варианта карточки (новая admin + легаси), а
    // также списки — чтобы изменения были видны сразу.
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath('/orders');
    revalidatePath(`/orders/${orderId}`);
    redirect(`/admin/orders/${orderId}`);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
}
