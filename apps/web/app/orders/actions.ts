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
import {
  OrderApplicationInputSchema,
  type OrderApplicationInput,
} from '@sewing/shared/order-applications';
import {
  BulkUpsertOrderCutIssueRulesSchema,
  type BulkUpsertOrderCutIssueRulesDto,
  type OrderCutIssueRulesSummaryDto,
} from '@sewing/shared';
import { ApiRequestError } from '@/lib/api';
import {
  cancelOrder,
  completeOrder,
  completeOrderCalculation,
  createOrder,
  recalculateOrderOperationPlan,
  reopenOrderCalculation,
  startCalculationOrder,
  startOrder,
  updateOrder,
  updateOrderMaterialRequirementColor,
  updateOrderOutsourceRequirementStatus,
} from '@/lib/orders-api';
import {
  disableOrderCutIssueQueue,
  disableOrderCutIssueRules,
  saveOrderCutIssueRules,
} from '@/lib/order-cut-issue-rules-api';

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
 * Подразделение заказа — FK на master-справочник `CompanyDivision`
 * (см. `docs/domain.md §«Подразделения заказа»`).
 *
 * Семантика парсинга:
 *   - поля нет в FormData → `undefined` → backend не трогает колонку
 *     (актуально для форм без селекта подразделения);
 *   - есть и пустое → `null` → backend снимает привязку (только в
 *     update-flow, на create эквивалентно «не задан»);
 *   - есть и непустое → строка с id.
 */
function parseCompanyDivisionId(
  form: FormData,
): string | null | undefined {
  const raw = form.get('companyDivisionId');
  if (raw === null) return undefined;
  const v = String(raw).trim();
  return v === '' ? null : v;
}

/**
 * Этап «Нанесение на заказе покупателя»: на `/admin/orders/new`
 * редактор `OrderApplicationsEditor` пишет в FormData hidden input
 * `applicationsJson` со своим локальным state-ом
 * (`JSON.stringify(rows.map(rowToInput))`). Здесь читаем JSON,
 * валидируем каждую строку через `OrderApplicationInputSchema`
 * (тот же контракт, что у PUT-эндпоинта) и возвращаем
 * нормализованный массив. Невалидный JSON / пустое поле / поле
 * отсутствует → undefined: backend получит DTO без `applications`
 * и продолжит как раньше (полная backward-compatibility со старой
 * `/orders/new`-формой).
 *
 * Жёстких ошибок здесь не бросаем — финальную валидацию делает
 * `CreateOrderSchema`, чтобы все ошибки полей (включая нанесения)
 * попали в один `fieldErrors`-payload и UI мог показать их рядом.
 */
function parseApplicationsJson(
  form: FormData,
): OrderApplicationInput[] | undefined {
  const raw = form.get('applicationsJson');
  if (raw === null) return undefined;
  const text = String(raw).trim();
  if (text === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  if (parsed.length === 0) return undefined;
  const out: OrderApplicationInput[] = [];
  for (const raw of parsed) {
    const row = OrderApplicationInputSchema.safeParse(raw);
    if (row.success) out.push(row.data);
    // Невалидную строку молча пропускаем — финальная Zod-валидация
    // в `CreateOrderSchema.applications` перепроверит массив целиком
    // и отдаст fieldErrors с правильными path-ами, если что-то ещё
    // не так. Просто JSON.parse-ный raw нельзя класть в DTO без
    // нормализации (числа из строк, пустые строки в null и т.д.).
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Этап «Цена продажи за единицу»: парсим оба поля из FormData по
 * единому контракту:
 *   - поля нет в форме → undefined → backend не трогает колонку
 *     (актуально только для legacy `/orders/new`, который вообще
 *     не шлёт customerUnitPrice);
 *   - поле есть и пустое → null → backend стирает значение;
 *   - поле есть и непустое → строка/валюта.
 */
function parseCustomerPriceFromForm(
  form: FormData,
): {
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

function buildCreateDto(form: FormData): CreateOrderDto {
  const items = extractItems(form);
  const orderDate = String(form.get('orderDate') ?? '').trim();
  // Этап «Номенклатура = Лекала» (см. `docs/recon-soft-integration.md
  // §«Номенклатура = Лекала»»): в новой admin-форме `productId` в
  // FormData не приходит — пользователь выбирает только лекало,
  // backend сам подставит legacy Product через
  // `OrdersService.ensureLegacyProductForPattern()`. Старый flow
  // (легаси `/orders/new`, прямой POST) продолжает работать с
  // явным `productId`. Поле опционально и в DTO попадает только
  // если действительно есть в FormData.
  const productIdRaw = form.get('productId');
  const productId =
    productIdRaw === null
      ? undefined
      : String(productIdRaw).trim() === ''
        ? undefined
        : String(productIdRaw).trim();
  const color = String(form.get('color') ?? '').trim() || undefined;
  const comment = String(form.get('comment') ?? '').trim() || undefined;
  const routeTemplateId =
    String(form.get('routeTemplateId') ?? '').trim() || undefined;
  // Tech card MVP (ADR-0022): пустой select = «без техкарты».
  const techCardId =
    String(form.get('techCardId') ?? '').trim() || undefined;
  // Soft-pattern MVP (этап 2 «Лекала»): пустой select = «без лекала».
  // Семантика идентична techCardId/routeTemplateId.
  const patternItemId =
    String(form.get('patternItemId') ?? '').trim() || undefined;
  // Client ref MVP: select клиента может отсутствовать в форме (легаси
  // `/orders/new`) — тогда поля просто нет, FormData вернёт null, и DTO
  // не подставит значение. Пустая строка = «без клиента».
  const clientRaw = form.get('clientId');
  const clientId =
    clientRaw === null
      ? undefined
      : String(clientRaw).trim() === ''
        ? undefined
        : String(clientRaw).trim();
  // Срок сдачи: аналогично clientId, поле опциональное; в новой админ-
  // форме приходит как `YYYY-MM-DD` из `<input type="date">`. Пустое
  // значение → undefined (а не null) — на create семантика «не задано»
  // покрывается отсутствием поля.
  const dueRaw = form.get('dueDate');
  const dueDate =
    dueRaw === null
      ? undefined
      : String(dueRaw).trim() === ''
        ? undefined
        : String(dueRaw).trim();
  // Этап «Нанесение на заказе покупателя» (см. `model OrderApplication`,
  // `OrdersService.create`): подбираем JSON-поле `applicationsJson`
  // от editor-а, чтобы создание заказа с нанесениями было атомарным.
  // Поле опциональное: legacy-форма `/orders/new` его не передаёт —
  // backend получит DTO без `applications` и поведёт себя как раньше.
  const applications = parseApplicationsJson(form);
  const { customerUnitPrice, customerCurrency } =
    parseCustomerPriceFromForm(form);
  // Inline-сценарий «Создать изделие → Сохранить изделие» (см.
  // `apps/web/app/admin/orders/new/create-product-inline.tsx`).
  // Hidden input `newProductCalculationJson` несёт JSON со снимком
  // inline-формы. Если поле есть — переключаем DTO в режим
  // `CREATE_FOR_CALCULATION` и шлём `newProductCalculation`
  // (backend сам создаст PatternItem / PatternMaterialArea / Product).
  const inlineCalc = parseNewProductCalculationJson(form);
  return {
    orderDate,
    productId,
    color,
    comment,
    items,
    routeTemplateId,
    techCardId,
    patternItemId,
    clientId,
    dueDate,
    // На create `null` равносилен «не задан» (создание не знает «снять»).
    companyDivisionId:
      parseCompanyDivisionId(form) === null
        ? undefined
        : parseCompanyDivisionId(form),
    // Этап «Склад выпуска готовой продукции»: на create
    // `null`/`undefined` означают «не выбран» — попадает в БД как
    // `null`. Семантика идентична `companyDivisionId`.
    finishedGoodsWarehouseId: parseFinishedGoodsWarehouseId(form),
    // Упрощённый MVP давальческого сырья / фурнитуры клиента: на
    // create поле опционально; backend подставит `INCLUDE`, если
    // FormData ничего не прислала.
    materialsAndHardwareCostPolicy:
      parseMaterialsAndHardwareCostPolicy(form),
    applications,
    customerUnitPrice,
    customerCurrency,
    ...(inlineCalc
      ? {
          productMode: 'CREATE_FOR_CALCULATION' as const,
          newProductCalculation: inlineCalc,
        }
      : {}),
  };
}

/**
 * Inline-сценарий «Создать изделие → Сохранить изделие»: hidden
 * input `newProductCalculationJson` содержит JSON со снимком inline-
 * формы (`SavedInlineProductPayload`). Здесь:
 *   - читаем строку, парсим JSON;
 *   - выкидываем UI-only поля (`categoryName`, `techCardName`,
 *     `sizeCode`, `areas[i].label`) — backend их не ждёт;
 *   - возвращаем DTO, ожидаемый
 *     `CreateOrderNewProductCalculationSchema` в shared.
 *
 * Любой невалидный/пустой JSON → `null` — заказ создаётся как
 * обычный EXISTING_PATTERN.
 */
function parseNewProductCalculationJson(form: FormData): {
  categoryId?: string | null;
  techCardId?: string | null;
  patternDevelopmentCostRub?: string | null;
  sizes: {
    sizeId: string;
    qtyPlan: number;
    areas: { roleKey: string; areaM2: string }[];
  }[];
} | null {
  const raw = form.get('newProductCalculationJson');
  if (raw === null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const rawSizes = Array.isArray(p.sizes) ? p.sizes : [];
  const sizes: {
    sizeId: string;
    qtyPlan: number;
    areas: { roleKey: string; areaM2: string }[];
  }[] = [];
  for (const s of rawSizes) {
    if (!s || typeof s !== 'object') continue;
    const sr = s as Record<string, unknown>;
    const sizeId = typeof sr.sizeId === 'string' ? sr.sizeId : '';
    const qty = Number(sr.qtyPlan);
    if (!sizeId || !Number.isFinite(qty) || qty <= 0) continue;
    const areasRaw = Array.isArray(sr.areas) ? sr.areas : [];
    const areas: { roleKey: string; areaM2: string }[] = [];
    for (const a of areasRaw) {
      if (!a || typeof a !== 'object') continue;
      const ar = a as Record<string, unknown>;
      const roleKey = typeof ar.roleKey === 'string' ? ar.roleKey : '';
      const areaM2 =
        typeof ar.areaM2 === 'string'
          ? ar.areaM2
          : typeof ar.areaM2 === 'number'
            ? String(ar.areaM2)
            : '';
      if (roleKey && areaM2) areas.push({ roleKey, areaM2 });
    }
    sizes.push({ sizeId, qtyPlan: Math.trunc(qty), areas });
  }
  return {
    categoryId:
      typeof p.categoryId === 'string' && p.categoryId.length > 0
        ? p.categoryId
        : null,
    techCardId:
      typeof p.techCardId === 'string' && p.techCardId.length > 0
        ? p.techCardId
        : null,
    patternDevelopmentCostRub:
      typeof p.patternDevelopmentCostRub === 'string' &&
      p.patternDevelopmentCostRub.length > 0
        ? p.patternDevelopmentCostRub
        : null,
    sizes,
  };
}

/**
 * Этап «Склад выпуска готовой продукции» (см.
 * `prisma/schema.prisma::Order.finishedGoodsWarehouseId`).
 *
 * Семантика парсинга совпадает с `parseCompanyDivisionId`:
 *   - поля нет в FormData → `undefined` (backend не трогает колонку);
 *   - есть и пустое → `null` (снять привязку);
 *   - есть и непустое → строка с `Warehouse.id`.
 */
function parseFinishedGoodsWarehouseId(
  form: FormData,
): string | null | undefined {
  const raw = form.get('finishedGoodsWarehouseId');
  if (raw === null) return undefined;
  const v = String(raw).trim();
  return v === '' ? null : v;
}

/**
 * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
 * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
 * `packages/shared/src/orders.ts::OrderMaterialsAndHardwareCostPolicy`).
 *
 *   - поля нет в FormData → `undefined` (backend не трогает / на create
 *     подставит default `INCLUDE`);
 *   - есть и пустое → `INCLUDE` (default);
 *   - есть `'EXCLUDE'` → не учитывать материалы и фурнитуру в
 *     себестоимости (давальческое сырьё клиента);
 *   - всё остальное → `INCLUDE` (защитный fallback).
 */
function parseMaterialsAndHardwareCostPolicy(
  form: FormData,
): 'INCLUDE' | 'EXCLUDE' | undefined {
  const raw = form.get('materialsAndHardwareCostPolicy');
  if (raw === null) return undefined;
  const v = String(raw).trim().toUpperCase();
  if (v === 'EXCLUDE') return 'EXCLUDE';
  return 'INCLUDE';
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
  // Soft-pattern MVP (этап 2 «Лекала»): семантика идентична
  // routeTemplateId / techCardId.
  const patternRaw = form.get('patternItemId');
  let patternItemId: string | null | undefined;
  if (patternRaw === null) {
    patternItemId = undefined;
  } else {
    const v = String(patternRaw).trim();
    patternItemId = v === '' ? null : v;
  }
  // Client ref MVP: семантика идентична routeTemplateId/techCardId —
  // поля нет = не трогать, пустая строка = очистить, иначе =
  // переустановить.
  const clientRaw = form.get('clientId');
  let clientId: string | null | undefined;
  if (clientRaw === null) {
    clientId = undefined;
  } else {
    const v = String(clientRaw).trim();
    clientId = v === '' ? null : v;
  }
  // Срок сдачи: та же семантика — поля нет = не трогать, пустая
  // строка = снять, иначе ISO `YYYY-MM-DD`.
  const dueRaw = form.get('dueDate');
  let dueDate: string | null | undefined;
  if (dueRaw === null) {
    dueDate = undefined;
  } else {
    const v = String(dueRaw).trim();
    dueDate = v === '' ? null : v;
  }
  const { customerUnitPrice, customerCurrency } =
    parseCustomerPriceFromForm(form);
  const dto: UpdateOrderDto = {
    orderDate: String(form.get('orderDate') ?? '').trim() || undefined,
    productId: String(form.get('productId') ?? '').trim() || undefined,
    color: optionalString(form.get('color')),
    comment: optionalString(form.get('comment')),
    items: items.length > 0 ? items : undefined,
    routeTemplateId,
    techCardId,
    patternItemId,
    clientId,
    dueDate,
    // Подразделение заказа. Семантика та же, что у `routeTemplateId`
    // / `techCardId`: поля нет = не трогать, пустая строка = снять,
    // иначе = переустановить.
    companyDivisionId: parseCompanyDivisionId(form),
    // Этап «Склад выпуска готовой продукции»: семантика та же —
    // поля нет = не трогать, пустая строка = снять, иначе =
    // переустановить (backend валидирует existence + isActive).
    finishedGoodsWarehouseId: parseFinishedGoodsWarehouseId(form),
    // Упрощённый MVP давальческого сырья: при PATCH поля нет →
    // backend не трогает колонку, иначе пишем `INCLUDE` / `EXCLUDE`.
    materialsAndHardwareCostPolicy:
      parseMaterialsAndHardwareCostPolicy(form),
    customerUnitPrice,
    customerCurrency,
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

/**
 * Inline-создание изделия из формы заказа (см.
 * `apps/web/app/admin/orders/new/admin-create-order-form.tsx`,
 * `apps/api/src/modules/orders/orders.service.ts::createWithInlinePattern`).
 *
 * Принимает уже собранный `CreateOrderDto` (с `productMode =
 * CREATE_FOR_CALCULATION` и непустым `newProductCalculation`),
 * валидирует через тот же Zod-контракт, что использует обычная
 * `createOrderAction`, и редиректит на admin-карточку нового заказа.
 *
 * Сознательно НЕ через FormData: клиент собирает структурированный
 * объект (категория, техкарта, размерная матрица, стоимость разработки)
 * и шлёт его JSON-ом в server action — парсить такое из FormData
 * было бы громоздко и ненадёжно по точности Decimal.
 */
export interface CreateOrderForCalculationResult {
  ok?: boolean;
  error?: string;
  orderId?: string;
  /** Адресные `missingRoleKeys` для UI техкарты. */
  missingRoleKeys?: string[];
}

export async function createOrderForCalculationAction(
  dtoRaw: unknown,
): Promise<CreateOrderForCalculationResult> {
  const parsed = CreateOrderSchema.safeParse(dtoRaw);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? 'Невалидные данные заказа',
    };
  }
  try {
    const created = await createOrder(parsed.data);
    revalidatePath('/orders');
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${created.id}`);
    return { ok: true, orderId: created.id };
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    if (e instanceof ApiRequestError) {
      // Извлекаем `missingRoleKeys`, если backend отдал
      // `TECH_CARD_NOT_COMPATIBLE_WITH_CATEGORY`.
      const payload = (e as { payload?: unknown }).payload as
        | { missingRoleKeys?: unknown }
        | undefined;
      const rawList =
        payload && Array.isArray(payload.missingRoleKeys)
          ? payload.missingRoleKeys
          : undefined;
      const missing =
        rawList && rawList.every((x) => typeof x === 'string')
          ? (rawList as string[])
          : undefined;
      return { error: explainApiError(e), missingRoleKeys: missing };
    }
    return { error: explainApiError(e) };
  }
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
  // Куда редиректить после успешного создания. Поле опциональное:
  //   - старая `/orders/new` его не передаёт → fallback `/orders/<id>`
  //     (полная backward-compatibility);
  //   - новая `/admin/orders/new` шлёт hidden `redirectTo="admin"` →
  //     попадаем в новую карточку `/admin/orders/<id>`.
  // Любое неизвестное значение трактуем как legacy, чтобы случайный
  // мусор в FormData не уводил пользователя «не туда».
  const redirectTo = String(form.get('redirectTo') ?? '').trim();
  // TODO(orders-status-on-create): `CreateOrderSchema` пока НЕ принимает
  // `status`, заказ всегда создаётся как DRAFT (см. OrdersService.create
  // → Prisma default). Поле в FormData (`status="DRAFT"`) приходит из
  // admin-формы как visual-only, и сознательно не пробрасывается в DTO,
  // пока backend/Zod не разрешит создавать заказ сразу в IN_PRODUCTION.
  // Когда разрешит — добавить `status: parseOrderStatus(form)` в
  // `buildCreateDto` и dropdown в `admin-create-order-form.tsx` снять
  // `disabled`. До этого момента UI держит «Черновик» как единственное
  // допустимое значение.
  try {
    const created = await createOrder(parsed.data);
    revalidatePath('/orders');
    if (redirectTo === 'admin') {
      revalidatePath('/admin/orders');
      revalidatePath(`/admin/orders/${created.id}`);
      redirect(`/admin/orders/${created.id}`);
    }
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
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
}

/**
 * Этап «Расчёт»: server-action для кнопки «Перевести в расчёт» в
 * карточке заказа `/admin/orders/[id]`.
 *
 * Дёргает `POST /api/orders/:id/start-calculation` через типизированную
 * обёртку `startCalculationOrder`. Ошибки backend-а (адресные коды
 * `ORDER_PATTERN_REQUIRED` / `ORDER_TECH_CARD_REQUIRED` /
 * `ORDER_ITEMS_REQUIRED` / `ORDER_INVALID_STATUS_TRANSITION` /
 * `WORKSHOP_NEEDS_ALREADY_REVIEWED`) пробрасываются через
 * `explainApiError`. Client-component сам решает, как их показать.
 *
 * После успеха ревалидируем как новый admin-роут карточки заказа
 * (там кнопка живёт), так и список и легаси-карточку.
 */
export async function startCalculationOrderAction(id: string): Promise<void> {
  try {
    await startCalculationOrder(id);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  revalidatePath('/orders');
  revalidatePath(`/orders/${id}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
}

export async function completeOrderAction(id: string): Promise<void> {
  try {
    await completeOrder(id);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  // Ревалидируем оба раздела: legacy `/orders` (CUTTER_ASSISTANT
  // ходит сюда за выпуском паспортов) и admin `/admin/orders` (новая
  // управленческая карточка `OrderManagementHeader` зовёт этот
  // action из своей кнопки «Завершить»).
  revalidatePath('/orders');
  revalidatePath(`/orders/${id}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
}

/**
 * Этап «Себестоимость заказа»: server-action под кнопку
 * «Завершить расчёт» (грид-вид `/admin/workshop-needs` и блок
 * «Себестоимость» в карточке заказа). Дёргает
 * `POST /api/orders/:id/complete-calculation`.
 *
 * Возвращает `FormActionState` с `error`, чтобы UI мог inline-ом
 * показать `ORDER_CALCULATION_INCOMPLETE` /
 * `ORDER_CALCULATION_USD_RATE_REQUIRED` /
 * `ORDER_CALCULATION_INVALID_STATUS` без редиректа.
 */
export interface CompleteCalculationActionState extends FormActionState {
  ok?: boolean;
}

export async function completeOrderCalculationAction(
  orderId: string,
  _prev: CompleteCalculationActionState,
  form: FormData,
): Promise<CompleteCalculationActionState> {
  const usdRateRubRaw = String(form.get('usdRateRub') ?? '').trim();
  const commentRaw = String(form.get('comment') ?? '').trim();
  try {
    await completeOrderCalculation(orderId, {
      usdRateRub: usdRateRubRaw === '' ? null : usdRateRubRaw,
      comment: commentRaw === '' ? null : commentRaw,
    });
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
  revalidatePath('/admin/workshop-needs');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * Этап «Себестоимость заказа»: server-action под кнопку «Вернуть на
 * пересчёт» в карточке заказа (`CALCULATION_DONE → CALCULATION`).
 * `WorkshopNeed`/`PurchaseOrder`/`PurchaseReceipt` не трогаются —
 * закупщик правит существующие строки.
 */
export interface ReopenCalculationActionState extends FormActionState {
  ok?: boolean;
}

export async function reopenOrderCalculationAction(
  orderId: string,
  _prev: ReopenCalculationActionState,
  form: FormData,
): Promise<ReopenCalculationActionState> {
  const reasonRaw = String(form.get('reason') ?? '').trim();
  try {
    await reopenOrderCalculation(orderId, {
      reason: reasonRaw === '' ? null : reasonRaw,
    });
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
  revalidatePath('/admin/workshop-needs');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * Этап 2 «План операций на заказе» (см.
 * `docs/operation-time-norms-recon.md §11`,
 * `apps/api/src/modules/orders/orders.controller.ts::recalculateOperationPlan`):
 * server-action под кнопку «Пересчитать план операций» в карточке
 * заказа `/admin/orders/[id]`.
 *
 * Не использует `useFormState` — здесь нет формы с полями, action
 * принимает только `orderId` через bind. Возвращает `{ ok }` или
 * `{ error }`, чтобы client-component мог inline-ом показать
 * `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED` (для
 * `CALCULATION_DONE` / `IN_PRODUCTION` / …) без редиректа.
 */
export interface RecalculateOperationPlanActionState extends FormActionState {
  ok?: boolean;
}

export async function recalculateOrderOperationPlanAction(
  orderId: string,
): Promise<RecalculateOperationPlanActionState> {
  try {
    await recalculateOrderOperationPlan(orderId);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
  revalidatePath('/orders');
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true };
}

export async function cancelOrderAction(id: string): Promise<void> {
  try {
    await cancelOrder(id);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  // Ревалидируем оба раздела: legacy `/orders` и admin `/admin/orders`
  // (новая `OrderManagementHeader` зовёт этот action из своей кнопки
  // «Отменить»). Без revalidate новой страницы баннер «Отменён» в
  // шапке появится только на следующем reload.
  revalidatePath('/orders');
  revalidatePath(`/orders/${id}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
}

/**
 * MVP-3 техкарт (ADR-0022 §«Manual execution status»): server-actions
 * под две кнопки в блоке «Внешние потребности» карточки заказа.
 *
 * Сознательно не используем `useFormState` — здесь нет формы с
 * множеством полей, action принимает только пару `(orderId,
 * requirementId)` через bind. Ошибки пробрасываются как
 * `Error(explainApiError(e))` — consumer (client component) ловит
 * и показывает в общем error-box.
 */
export async function markOutsourceRequirementOrderedAction(
  orderId: string,
  requirementId: string,
): Promise<void> {
  try {
    await updateOrderOutsourceRequirementStatus(
      orderId,
      requirementId,
      'ORDERED',
    );
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  revalidatePath(`/orders/${orderId}`);
}

export async function markOutsourceRequirementReceivedAction(
  orderId: string,
  requirementId: string,
): Promise<void> {
  try {
    await updateOrderOutsourceRequirementStatus(
      orderId,
      requirementId,
      'RECEIVED',
    );
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    throw new Error(explainApiError(e));
  }
  revalidatePath(`/orders/${orderId}`);
}

/**
 * Этап «Указать в заказе» (см. ТЗ §4): сохранить цвет, выбранный
 * менеджером для конкретной строки материала заказа.
 *
 * Возвращает `{ ok }` или `{ error }`, чтобы UI inline-ом мог
 * показать `ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED` /
 * `ORDER_MATERIAL_REQUIREMENT_NOT_FOUND` без редиректа.
 */
export interface UpdateOrderMaterialRequirementColorActionState
  extends FormActionState {
  ok?: boolean;
}

export async function updateOrderMaterialRequirementColorAction(
  orderId: string,
  requirementId: string,
  _prev: UpdateOrderMaterialRequirementColorActionState,
  form: FormData,
): Promise<UpdateOrderMaterialRequirementColorActionState> {
  const raw = form.get('selectedColorText');
  const value =
    raw === null
      ? null
      : (() => {
          const v = String(raw).trim();
          return v === '' ? null : v;
        })();
  try {
    await updateOrderMaterialRequirementColor(orderId, requirementId, value);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// «Очередь выдачи кроя по размерам» (см.
// `apps/api/src/modules/order-cut-issue-rules/*`,
// `apps/web/components/orders/order-cut-issue-rules-card.tsx`,
// `docs/order-flow.md §«Очередь выдачи кроя»`).
// ---------------------------------------------------------------------------

export interface OrderCutIssueRulesActionState extends FormActionState {
  ok?: boolean;
  summary?: OrderCutIssueRulesSummaryDto;
}

/**
 * Bulk-сохранение формы очереди выдачи кроя из карточки заказа.
 *
 * FormData-контракт:
 *   - `queueIndex` — индекс очереди (1-based), которую сохраняем;
 *   - `rows` — JSON-массив `{ sizeId, requiredQty, sortOrder? }`.
 *
 * Парсим в action, валидируем `BulkUpsertOrderCutIssueRulesSchema`,
 * чтобы не доверять JSON из формы. После успеха ревалидируем legacy
 * `/orders/[id]` и admin `/admin/orders/[id]` — карточка живёт в обоих.
 */
export async function saveOrderCutIssueRulesAction(
  orderId: string,
  _prev: OrderCutIssueRulesActionState,
  form: FormData,
): Promise<OrderCutIssueRulesActionState> {
  const queueIndexRaw = form.get('queueIndex');
  const queueIndex = Number(queueIndexRaw);
  if (!Number.isInteger(queueIndex) || queueIndex < 1) {
    return { error: 'Не указан индекс очереди.' };
  }
  const raw = form.get('rows');
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: 'Список строк очереди не передан.' };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { error: 'Не удалось разобрать список строк очереди.' };
  }
  if (!Array.isArray(parsedJson)) {
    return { error: 'Список строк должен быть массивом.' };
  }
  const dto: BulkUpsertOrderCutIssueRulesDto = {
    queueIndex,
    rows: parsedJson as BulkUpsertOrderCutIssueRulesDto['rows'],
  };
  const parsed = BulkUpsertOrderCutIssueRulesSchema.safeParse(dto);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? 'Невалидные данные очереди.',
    };
  }
  let summary: OrderCutIssueRulesSummaryDto;
  try {
    summary = await saveOrderCutIssueRules(orderId, parsed.data);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, summary };
}

/**
 * Отключить одну конкретную очередь выдачи кроя. FormData-контракт:
 *   - `queueIndex` — индекс отключаемой очереди.
 * `isActive = false` для всех её активных строк, `issuedQty`
 * сохраняется (нужен для аудита). Идемпотентно.
 */
export async function disableOrderCutIssueQueueAction(
  orderId: string,
  _prev: OrderCutIssueRulesActionState,
  form: FormData,
): Promise<OrderCutIssueRulesActionState> {
  const queueIndexRaw = form.get('queueIndex');
  const queueIndex = Number(queueIndexRaw);
  if (!Number.isInteger(queueIndex) || queueIndex < 1) {
    return { error: 'Не указан индекс очереди.' };
  }
  let summary: OrderCutIssueRulesSummaryDto;
  try {
    summary = await disableOrderCutIssueQueue(orderId, queueIndex);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, summary };
}

/**
 * Полностью отключить очередь выдачи кроя по заказу
 * («Снять ограничение по размерам»). Идемпотентно.
 */
export async function disableOrderCutIssueRulesAction(
  orderId: string,
  _prev: OrderCutIssueRulesActionState,
  _form: FormData,
): Promise<OrderCutIssueRulesActionState> {
  let summary: OrderCutIssueRulesSummaryDto;
  try {
    summary = await disableOrderCutIssueRules(orderId);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, summary };
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
