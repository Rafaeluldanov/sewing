'use server';

/**
 * Server actions мастера создания заказа (`/admin/orders/new`).
 *
 * Мастер отличается от прежней одностраничной формы тем, что **заказ
 * создаётся посреди пути, а не по финальному сабмиту**. Дальше каждый
 * шаг дописывает свой кусок в уже существующий черновик. Отсюда набор
 * ручек:
 *
 *   - `createOrderDraftAction`   — переход 3 → 4 → `POST /orders` (DRAFT);
 *   - `patchOrderDraftAction`    — шаги 3–4 → `PATCH /orders/:id`;
 *   - `saveDraftApplicationsAction` — шаг 5 → `PUT /orders/:id/applications`
 *     (нанесения живут отдельной ручкой, не полем заказа);
 *   - `finishOrderDraftAction`   — шаг 6 → `POST /orders/:id/start-calculation`.
 *
 * Момент создания задан контрактом, а не вкусом: `CreateOrderSchema`
 * в `superRefine` требует непустой `items` («Заказ должен содержать
 * хотя бы одну строку по размеру»), поэтому раньше шага «Расцветки и
 * размеры» черновик родиться не может.
 *
 * Почему JSON, а не FormData. Прежняя форма собирала один большой
 * `FormData` и парсила его в `buildCreateDto` — оправданно, когда весь
 * заказ уходит одним сабмитом. У мастера каждый шаг шлёт свой маленький
 * кусок, и структурные поля (расцветки с поразмерным планом, нанесения)
 * в FormData пришлось бы снова сериализовать в скрытый JSON. Тот же
 * приём уже используют `createOrderForCalculationAction` и
 * amendment-ручки: клиент собирает объект, action валидирует его тем же
 * Zod-контрактом.
 *
 * Валидация — `CreateOrderSchema` / `UpdateOrderSchema` из
 * `@sewing/shared/orders`, ровно те же, что у прежней формы. Никаких
 * новых эндпоинтов и изменений backend/DTO/Prisma здесь нет.
 *
 * Обязательность клиента (этап «Клиент — обязательный атрибут заказа»)
 * проверяется на шаге 1 в самом мастере и ещё раз здесь: без клиента
 * черновик создавать нельзя, иначе заказ упрётся в
 * `ORDER_CLIENT_REQUIRED` при отправке в расчёт.
 */

import { revalidatePath } from 'next/cache';
import {
  CreateOrderSchema,
  UpdateOrderSchema,
  type CreateOrderDto,
  type UpdateOrderDto,
} from '@sewing/shared/orders';
import {
  ReplaceOrderApplicationsSchema,
  type ReplaceOrderApplicationsDto,
} from '@sewing/shared/order-applications';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  orderGateFixLink,
  orderGateReturnStep,
  type OrderGateFixLink,
} from '@/lib/order-gate-fix';
import {
  createOrder,
  startCalculationOrder,
  updateOrder,
} from '@/lib/orders-api';
import { replaceOrderApplications } from '@/lib/order-applications-api';
import type { WizardStepId } from './wizard-steps';

/**
 * Единый результат шага мастера. `fieldErrors` — по тем же путям, что
 * отдаёт Zod (`clientId`, `patternItemId`, `variants.0.color`, …),
 * чтобы шаг подсветил конкретное поле, а не только общий баннер.
 */
export interface WizardStepResult {
  ok: boolean;
  orderId?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /**
   * Адресный возврат: на каком шаге мастера лечится ошибка гейта
   * (`ORDER_TECH_CARD_REQUIRED` → «Изделие», `ORDER_ITEMS_REQUIRED` →
   * «Расцветки и размеры», …). Баннер ошибки рисует по нему кнопку
   * «Вернуться на шаг …» вместо того, чтобы оставлять менеджера на
   * «Проверке» гадать, что именно не так.
   */
  returnStep?: WizardStepId;
  /**
   * Ссылка «где исправить», если это не в мастере: пустая
   * спецификация лечится в карточке номенклатуры
   * (`/admin/patterns/:id`), а не в заказе.
   */
  fixLink?: OrderGateFixLink;
}

function zodFieldErrors(
  issues: { path: (string | number)[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    out[issue.path.join('.')] = issue.message;
  }
  return out;
}

function apiError(e: unknown): WizardStepResult {
  if (e instanceof ApiRequestError) {
    const returnStep = orderGateReturnStep(e);
    const fixLink = orderGateFixLink(e);
    return {
      ok: false,
      error: errorText(e),
      ...(returnStep ? { returnStep } : {}),
      ...(fixLink ? { fixLink } : {}),
    };
  }
  return { ok: false, error: 'Не удалось выполнить запрос' };
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/orders');
}

/**
 * Переход 3 → 4: создание черновика.
 *
 * С этого момента заказ существует в БД и виден в списке: уход со
 * страницы, перезагрузка и закрытая вкладка больше ничего не теряют.
 * Прежняя форма создавала заказ либо в самом конце, либо неявно
 * кнопкой «Сохранить изделие» — по экрану предсказать это было нельзя.
 *
 * Раньше этого момента вызывать бессмысленно: без `items` backend
 * отдаст 400 (см. шапку файла).
 */
export async function createOrderDraftAction(
  dtoRaw: unknown,
): Promise<WizardStepResult> {
  const parsed = CreateOrderSchema.safeParse(dtoRaw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные заказа',
      fieldErrors: zodFieldErrors(parsed.error.issues),
    };
  }
  const dto: CreateOrderDto = parsed.data;
  // Второй контур поверх обязательного селекта на шаге 1: без клиента
  // заказ создать можно (DTO это допускает ради легаси-flow), но он
  // упрётся в `ORDER_CLIENT_REQUIRED` при отправке в расчёт — то есть
  // менеджер узнает о проблеме через пять шагов. Ловим сразу.
  if (!dto.clientId) {
    return {
      ok: false,
      error: 'Выберите клиента — без него заказ не уйдёт в расчёт.',
      fieldErrors: { clientId: 'Выберите клиента' },
    };
  }
  try {
    const created = await createOrder(dto);
    revalidateOrder(created.id);
    return { ok: true, orderId: created.id };
  } catch (e) {
    return apiError(e);
  }
}

/**
 * Шаги 3–5 → дозапись в существующий черновик.
 *
 * Каждый шаг шлёт ТОЛЬКО свои поля: шаг «Расцветки» — `variants`,
 * шаг «Маршрут» — `routeTemplateId`. Это принципиально: снимка «всей
 * формы» у мастера нет, поэтому нет и полной перезаписи, которая в
 * прежней паре «карточка + /edit» затирала параллельные правки.
 */
export async function patchOrderDraftAction(
  orderId: string,
  dtoRaw: unknown,
): Promise<WizardStepResult> {
  if (!orderId) {
    return { ok: false, error: 'Черновик заказа ещё не создан' };
  }
  const parsed = UpdateOrderSchema.safeParse(dtoRaw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные заказа',
      fieldErrors: zodFieldErrors(parsed.error.issues),
    };
  }
  const dto: UpdateOrderDto = parsed.data;
  try {
    await updateOrder(orderId, dto);
    revalidateOrder(orderId);
    return { ok: true, orderId };
  } catch (e) {
    return apiError(e);
  }
}

/**
 * Шаг 5 → нанесения.
 *
 * Отдельная ручка `PUT /orders/:id/applications` (backend сам
 * пересобирает потребность цеха на `CALCULATION`), поэтому и action
 * отдельный. Пустой массив — валидное значение: «нанесения нет».
 */
export async function saveDraftApplicationsAction(
  orderId: string,
  inputRaw: unknown,
): Promise<WizardStepResult> {
  if (!orderId) {
    return { ok: false, error: 'Черновик заказа ещё не создан' };
  }
  const payload = Array.isArray(inputRaw)
    ? { applications: inputRaw }
    : inputRaw;
  const parsed = ReplaceOrderApplicationsSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? 'Невалидные параметры нанесения',
      fieldErrors: zodFieldErrors(parsed.error.issues),
    };
  }
  const dto: ReplaceOrderApplicationsDto = parsed.data;
  try {
    await replaceOrderApplications(orderId, dto);
    revalidateOrder(orderId);
    return { ok: true, orderId };
  } catch (e) {
    return apiError(e);
  }
}

/**
 * Шаг 6 → «Отправить в расчёт».
 *
 * Заказ уже создан (шаг 2), поэтому финальная кнопка мастера не
 * «Создать заказ», а переход по статусу. Редиректа здесь нет
 * намеренно: мастер сам решает, куда вести после успеха, и умеет
 * показать ошибку гейта (`ORDER_ITEMS_REQUIRED`,
 * `ORDER_CLIENT_REQUIRED`, `ORDER_TECH_CARD_REQUIRED`) прямо на шаге
 * проверки — до перехода, с адресным `returnStep` / `fixLink`
 * (см. `apiError` и `lib/order-gate-fix.ts`).
 */
export async function finishOrderDraftAction(
  orderId: string,
): Promise<WizardStepResult> {
  if (!orderId) {
    return { ok: false, error: 'Черновик заказа ещё не создан' };
  }
  try {
    await startCalculationOrder(orderId);
    revalidateOrder(orderId);
    return { ok: true, orderId };
  } catch (e) {
    return apiError(e);
  }
}
