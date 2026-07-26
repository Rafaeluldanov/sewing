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
 *   - `companyDivisionId`  — id карточки `CompanyDivision` либо пусто (= без подразделения);
 *   - `dueDate`            — ISO `YYYY-MM-DD` или пусто (= снять);
 *   - `clientId`           — `ulid`, ОБЯЗАТЕЛЬНО (этап «Клиент —
 *                            обязательный атрибут заказа»: пусто =
 *                            ошибка поля, снять клиента нельзя);
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
  ROUTE_MODE_OVERRIDES,
  UpdateOrderSchema,
  type RouteModeOverride,
  type UpdateOrderDto,
} from '@sewing/shared/orders';
import { ApiRequestError, errorText } from '@/lib/api';
// Этап «Клиент — обязательный атрибут заказа»: единый текст ошибки и
// гейт на все формы заказа.
import { clientRequiredError } from '@/lib/order-client-required';
import { setOrderRouteMode, updateOrder } from '@/lib/orders-api';

export interface UpdateOrderBasicsActionState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
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
    // Подразделение заказа — FK на `CompanyDivision` (см.
    // `docs/domain.md §«Подразделения заказа»`).
    companyDivisionId: parseNullableString(form, 'companyDivisionId'),
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
    return errorText(e);
  }
  return 'Не удалось сохранить «Основное»';
}

export async function updateOrderBasicsAction(
  orderId: string,
  _prev: UpdateOrderBasicsActionState,
  form: FormData,
): Promise<UpdateOrderBasicsActionState> {
  // Этап «Клиент — обязательный атрибут заказа»: пустой селект = попытка
  // снять клиента (backend отбил бы это как `ORDER_CLIENT_REQUIRED`).
  // Историческим заказам без клиента это и означает «дозаполнить при
  // следующей правке»: сохранить блок «Основное», не выбрав клиента,
  // нельзя.
  const clientMissing = clientRequiredError(form);
  if (clientMissing) return clientMissing;
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

export interface SetRouteModeActionState {
  ok?: boolean;
  error?: string;
}

/**
 * Server action тумблера адаптивного режима сплит-распошива (AUTO /
 * FORCE_SPLIT / FORCE_COLLAPSED). См. `OrdersService.setRouteModeOverride`
 * и `route-mode.ts`. Меняет только трактовку распошива и монитор цеха —
 * снапшот маршрута не трогается.
 */
export async function setOrderRouteModeAction(
  orderId: string,
  _prev: SetRouteModeActionState,
  form: FormData,
): Promise<SetRouteModeActionState> {
  const value = String(form.get('routeModeOverride') ?? '');
  if (!ROUTE_MODE_OVERRIDES.includes(value as RouteModeOverride)) {
    return { error: 'Недопустимый режим распошива' };
  }
  try {
    await setOrderRouteMode(orderId, {
      routeModeOverride: value as RouteModeOverride,
    });
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
