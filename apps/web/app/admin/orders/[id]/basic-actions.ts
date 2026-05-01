'use server';

/**
 * `updateOrderBasicsAction` — server action для inline-формы
 * «Основное» в верхнем блоке карточки заказа `/admin/orders/[id]`.
 *
 * Назначение: позволить менеджеру редактировать управленческие
 * поля заказа (подразделение / срок / клиент / цена-валюта / комментарий)
 * прямо из hero-блока, не открывая отдельный edit-page. Сами поля
 * существовали и раньше — раньше их можно было править только через
 * `/admin/orders/[id]/edit`. Этот action — лёгкий «inline»-аналог
 * `updateAdminOrderAction` без «опасных» полей (items / route /
 * techCard / pattern / status), которые требуют отдельной формы
 * редактирования продукции.
 *
 * Backend / DTO / Prisma не меняли: action собирает тот же
 * `UpdateOrderDto`, что и существующий `updateAdminOrderAction` —
 * просто с подмножеством полей. Бизнес-инварианты `OrdersService.update`
 * (например, ORDER_LOCKED для items) нас тут не блокируют, потому что
 * basics-поля разрешены на любом статусе.
 *
 * Контракт FormData (см. UI hero-формы в `order-hero-card.tsx`):
 *   - `division`           — `MARKETPLACE | OTHER`;
 *   - `dueDate`            — ISO `YYYY-MM-DD` или пусто (= снять);
 *   - `clientId`           — `ulid` либо пусто (= без клиента);
 *   - `customer`           — free-text заказчик (для совместимости со
 *                            старым `customer`-полем; пусто = снять);
 *   - `customerUnitPrice`  — цена за 1 изделие (decimal-string),
 *                            пусто = снять;
 *   - `customerCurrency`   — `RUB | USD`, пусто = снять;
 *   - `comment`            — free-text комментарий (max 2000), пусто = снять.
 *
 * Семантика «поле есть и пустое = снять / поле нет = не трогать»
 * наследована от `buildUpdateDto` в `apps/web/app/orders/actions.ts`.
 *
 * После успеха — revalidatePath обоих admin/legacy-карточек заказа,
 * `revalidatePath('/admin/orders')` для списка, и возвращаем
 * `{ ok: true, successMessage }`. Никаких redirect-ов: мы остаёмся
 * на той же карточке, чтобы пользователь видел обновлённые поля
 * сразу.
 */

import { revalidatePath } from 'next/cache';
import {
  ORDER_DIVISIONS,
  UpdateOrderSchema,
  type OrderDivision,
  type UpdateOrderDto,
} from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { updateOrder } from '@/lib/orders-api';

export interface UpdateOrderBasicsActionState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

function parseDivision(form: FormData): OrderDivision | undefined {
  const raw = String(form.get('division') ?? '').trim();
  if (raw === '') return undefined;
  return (ORDER_DIVISIONS as readonly string[]).includes(raw)
    ? (raw as OrderDivision)
    : undefined;
}

function parseNullableString(
  form: FormData,
  key: string,
): string | null | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseCustomerPrice(form: FormData): {
  customerUnitPrice: string | null | undefined;
  customerCurrency: 'RUB' | 'USD' | null | undefined;
} {
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
  return { customerUnitPrice, customerCurrency };
}

function buildBasicsDto(form: FormData): UpdateOrderDto {
  const { customerUnitPrice, customerCurrency } = parseCustomerPrice(form);
  return {
    division: parseDivision(form),
    dueDate: parseNullableString(form, 'dueDate'),
    clientId: parseNullableString(form, 'clientId'),
    customer: parseNullableString(form, 'customer'),
    comment: parseNullableString(form, 'comment'),
    customerUnitPrice,
    customerCurrency,
  };
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось сохранить «Основное»';
}

export async function updateOrderBasicsAction(
  orderId: string,
  _prev: UpdateOrderBasicsActionState,
  form: FormData,
): Promise<UpdateOrderBasicsActionState> {
  const raw = buildBasicsDto(form);
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
  } catch (e) {
    return { error: explainApiError(e) };
  }

  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, successMessage: 'Основное сохранено' };
}
