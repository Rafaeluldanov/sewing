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
 *   - `clientId`         (string, REQUIRED — этап «Клиент —
 *                         обязательный атрибут заказа»: пусто = ошибка
 *                         поля, снять клиента нельзя)
 *   - `patternItemId`    (string, optional, пусто = снять — главная
 *                         номенклатура; этап «Номенклатура = Лекала»)
 *   - `companyDivisionId` (string, optional, пусто = снять — FK на
 *                         `CompanyDivision`)
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
 *     companyDivisionId) допустимы только в DRAFT — иначе 409 ORDER_LOCKED;
 *   - смена `status` делегируется в `start/complete/cancel` через те же
 *     инварианты, что и существующие endpoints; недопустимый переход
 *     возвращает 409 ORDER_INVALID_TRANSITION.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ORDER_STATUSES,
  UpdateOrderSchema,
  type OrderStatus,
  type UpdateOrderDto,
} from '@sewing/shared/orders';
import { ApiRequestError, errorText } from '@/lib/api';
import { updateOrder } from '@/lib/orders-api';
// Этап «Клиент — обязательный атрибут заказа»: единый текст ошибки и
// гейт на все формы заказа.
import { clientRequiredError } from '@/lib/order-client-required';

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

/**
 * Фича «Расцветки» (FEATURE_COLORWAYS): парсим hidden `variantsJson`,
 * который рисует edit-форма при включённом флаге, в
 * `UpdateOrderDto['variants']`. Каждая расцветка — цвет + опциональная
 * техкарта + поразмерный план (`{sizeId, qtyPlan}`). Зеркалит
 * `parseVariantsJson` из `apps/web/app/orders/actions.ts` (форма
 * создания). Мусор молча отбрасываем — финальную валидацию делает
 * `UpdateOrderSchema.variants`. Пусто / нет поля / пустой массив →
 * `undefined`: backend расцветки не трогает (правки только скалярных
 * полей / статуса).
 */
function parseVariantsJson(form: FormData): UpdateOrderDto['variants'] {
  const raw = form.get('variantsJson');
  if (raw === null) return undefined;
  const text = String(raw).trim();
  if (text === '' || text === '[]') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

  const out: NonNullable<UpdateOrderDto['variants']> = [];
  for (const v of parsed) {
    if (!v || typeof v !== 'object') continue;
    const rec = v as Record<string, unknown>;
    const color = typeof rec.color === 'string' ? rec.color.trim() : '';
    if (color === '') continue;
    const techCardId =
      typeof rec.techCardId === 'string' && rec.techCardId.length > 0
        ? rec.techCardId
        : null;
    const sizesRaw = Array.isArray(rec.sizes) ? rec.sizes : [];
    const sizes: { sizeId: string; qtyPlan: number }[] = [];
    for (const s of sizesRaw) {
      if (!s || typeof s !== 'object') continue;
      const sr = s as Record<string, unknown>;
      const sizeId = typeof sr.sizeId === 'string' ? sr.sizeId : '';
      const qtyPlan = Number(sr.qtyPlan);
      if (sizeId === '' || !Number.isFinite(qtyPlan) || qtyPlan <= 0) continue;
      sizes.push({ sizeId, qtyPlan: Math.trunc(qtyPlan) });
    }
    out.push({ color, techCardId, sizes });
  }
  return out.length > 0 ? out : undefined;
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
  // Фича «Расцветки»: под флагом форма шлёт `variantsJson` ВМЕСТО
  // размерной матрицы. Когда расцветки есть — не шлём `items`: агрегат
  // `OrderItem` = Σ по цветам backend пересоберёт сам через
  // `resyncColorwayDerived`, а прямая запись `items` конфликтовала бы с
  // ресинком (обратная рассинхронизация, ровно тот баг, что чиним).
  const variants = parseVariantsJson(form);
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

  // Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
  // `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
  // `packages/shared/src/orders.ts::OrderMaterialsAndHardwareCostPolicy`).
  // Семантика парсинга: поля нет = не трогать (`undefined`), есть и
  // пустое = `INCLUDE` (default), `'EXCLUDE'` = давальческое сырьё /
  // фурнитура клиента, всё остальное = `INCLUDE` (защитный fallback).
  const policyRaw = form.get('materialsAndHardwareCostPolicy');
  let materialsAndHardwareCostPolicy: 'INCLUDE' | 'EXCLUDE' | undefined;
  if (policyRaw === null) {
    materialsAndHardwareCostPolicy = undefined;
  } else {
    const v = String(policyRaw).trim().toUpperCase();
    materialsAndHardwareCostPolicy = v === 'EXCLUDE' ? 'EXCLUDE' : 'INCLUDE';
  }

  const dto: UpdateOrderDto = {
    orderDate: optionalString(form.get('orderDate')),
    color: optionalNullableString(form.get('color')),
    comment: optionalNullableString(form.get('comment')),
    customer: optionalNullableString(form.get('customer')),
    items: variants ? undefined : items.length > 0 ? items : undefined,
    variants,
    routeTemplateId: optionalNullableString(form.get('routeTemplateId')),
    techCardId: optionalNullableString(form.get('techCardId')),
    // Этап «Номенклатура = Лекала»: семантика та же — поля нет
    // = не трогать, пустая строка = снять, иначе переустановить.
    // При смене лекала backend атомарно пересинхронизирует
    // `OrderItem.productId` со скрытым legacy Product этого лекала.
    patternItemId: optionalNullableString(form.get('patternItemId')),
    clientId: optionalNullableString(form.get('clientId')),
    dueDate: optionalNullableString(form.get('dueDate')),
    // Подразделение заказа — FK на `CompanyDivision` (см.
    // `docs/domain.md §«Подразделения заказа»`). Семантика та же,
    // что у `routeTemplateId` / `techCardId`.
    companyDivisionId: optionalNullableString(form.get('companyDivisionId')),
    // Этап «Склад выпуска готовой продукции» (см.
    // `prisma/schema.prisma::Order.finishedGoodsWarehouseId`).
    // Семантика та же — поля нет = не трогать, пустая строка = снять,
    // иначе = переустановить.
    finishedGoodsWarehouseId: optionalNullableString(
      form.get('finishedGoodsWarehouseId'),
    ),
    materialsAndHardwareCostPolicy,
    status: parseStatus(form),
    customerUnitPrice,
    customerCurrency,
  };
  return dto;
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
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
  // Этап «Клиент — обязательный атрибут заказа»: пустой селект = попытка
  // снять клиента, backend отбил бы это как `ORDER_CLIENT_REQUIRED`.
  // Ловим на шаг раньше и адресно — на поле.
  const clientMissing = clientRequiredError(form);
  if (clientMissing) return clientMissing;
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
