'use server';

/**
 * Server actions окна «Параметры техкарты» карточки заказа.
 *
 * Зеркало `colorways-actions.ts`: каждое действие возвращает свежий полный
 * DTO, из которого окно обновляет своё состояние, и ревалидирует карточку —
 * значение параметра меняет снимок материалов и потребность цеха, а они
 * рендерятся серверными компонентами.
 *
 * Контракт — `@sewing/shared/order-tech-cards`, обёртки —
 * `apps/web/lib/order-tech-card-api.ts`.
 */

import { revalidatePath } from 'next/cache';
import {
  CreateOrderTechCardLineSchema,
  CreateOrderTechCardLinesSchema,
  CreateOrderTechCardParameterSchema,
  SaveOrderTechCardAsTemplateSchema,
  SetOrderTechCardParameterValueSchema,
  UpdateOrderTechCardLineSchema,
  type OrderTechCardParametersDto,
} from '@sewing/shared/order-tech-cards';

import { ApiRequestError, errorText } from '@/lib/api';
import {
  applyOrderTechCardParameterToAll,
  createOrderTechCardLine,
  createOrderTechCardLines,
  createOrderTechCardParameter,
  deleteOrderTechCardLine,
  deleteOrderTechCardParameter,
  getOrderTechCardParameters,
  reloadOrderTechCardFromTemplate,
  reloadOrderTechCardNorms,
  saveOrderTechCardAsTemplate,
  setOrderTechCardParameterValue,
  updateOrderTechCardLine,
} from '@/lib/order-tech-card-api';

export interface TechCardParamsActionResult {
  ok: boolean;
  error?: string;
  data?: OrderTechCardParametersDto;
  /** Для «сохранить как шаблон»: что получилось. */
  savedTemplate?: { id: string; code: string; name: string };
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
}

/**
 * Перечитать параметры + материалы техкарт заказа (свежий снимок).
 * Нужен блоку расцветок: смена техкарты расцветки пересобирает
 * спецификацию на бэке (`resyncColorwayDerived` → материалы), но
 * `updateColorwayAction` возвращает только расцветки. Раньше материалы
 * подтягивались лишь через `router.refresh()` → проп → useEffect, и это
 * срабатывало ненадёжно (материалы «появлялись только после F5»).
 * Блок вызывает этот action сразу после сохранения расцветки и
 * обновляет спецификацию явно.
 */
export async function refreshTechCardParamsAction(
  orderId: string,
): Promise<TechCardParamsActionResult> {
  try {
    const data = await getOrderTechCardParameters(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось обновить материалы') };
    }
    throw e;
  }
}

export async function setTechCardParamValueAction(
  orderId: string,
  parameterId: string,
  payload: unknown,
): Promise<TechCardParamsActionResult> {
  const parsed = SetOrderTechCardParameterValueSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидное значение',
    };
  }
  try {
    const data = await setOrderTechCardParameterValue(
      orderId,
      parameterId,
      parsed.data,
    );
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось сохранить значение') };
    }
    throw e;
  }
}

export async function applyTechCardParamToAllAction(
  orderId: string,
  parameterId: string,
): Promise<TechCardParamsActionResult> {
  try {
    const data = await applyOrderTechCardParameterToAll(orderId, parameterId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: errorText(e, 'Не удалось применить ко всем расцветкам'),
      };
    }
    throw e;
  }
}

export async function createTechCardParamAction(
  orderId: string,
  payload: unknown,
): Promise<TechCardParamsActionResult> {
  const parsed = CreateOrderTechCardParameterSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные параметра',
    };
  }
  try {
    const data = await createOrderTechCardParameter(orderId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось добавить параметр') };
    }
    throw e;
  }
}

export async function deleteTechCardParamAction(
  orderId: string,
  parameterId: string,
): Promise<TechCardParamsActionResult> {
  try {
    const data = await deleteOrderTechCardParameter(orderId, parameterId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось удалить параметр') };
    }
    throw e;
  }
}

/** Добавить строку материала прямо в заказ (её нет в шаблоне). */
export async function createTechCardLineAction(
  orderId: string,
  payload: unknown,
): Promise<TechCardParamsActionResult> {
  const parsed = CreateOrderTechCardLineSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные строки',
    };
  }
  try {
    const data = await createOrderTechCardLine(orderId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось добавить материал') };
    }
    throw e;
  }
}

/**
 * Завести ПАЧКУ строк материала: заведение идёт черновыми строками прямо в
 * таблице, и уезжают они одним запросом — на бэке это одна транзакция и одна
 * пересборка производных вместо N.
 */
export async function createTechCardLinesAction(
  orderId: string,
  payload: unknown,
): Promise<TechCardParamsActionResult> {
  const parsed = CreateOrderTechCardLinesSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные строк',
    };
  }
  try {
    const data = await createOrderTechCardLines(orderId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: errorText(e, 'Не удалось добавить материалы'),
      };
    }
    throw e;
  }
}

/**
 * Правка строки материала — любой, и шаблонной, и ручной («техкарта живёт
 * в заказе», решение 16.07). Ячейку под параметром backend отбивает 409 —
 * UI такие ячейки ведёт через значение параметра.
 */
export async function updateTechCardLineAction(
  orderId: string,
  requirementId: string,
  payload: unknown,
): Promise<TechCardParamsActionResult> {
  const parsed = UpdateOrderTechCardLineSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные строки',
    };
  }
  try {
    const data = await updateOrderTechCardLine(orderId, requirementId, parsed.data);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось сохранить материал') };
    }
    throw e;
  }
}

export async function deleteTechCardLineAction(
  orderId: string,
  requirementId: string,
): Promise<TechCardParamsActionResult> {
  try {
    const data = await deleteOrderTechCardLine(orderId, requirementId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось убрать материал') };
    }
    throw e;
  }
}

/**
 * «Обновить из шаблона»: подтянуть изменившийся справочник в этот заказ.
 * Действие РАЗРУШИТЕЛЬНОЕ — правки структуры, сделанные в заказе, теряются;
 * значения параметров переживают. Эндпоинт отдаёт {ok}, поэтому свежий DTO
 * перечитываем отдельно — окно обновляется из одного источника, как везде.
 */
export async function reloadTechCardFromTemplateAction(
  orderId: string,
): Promise<TechCardParamsActionResult> {
  try {
    await reloadOrderTechCardFromTemplate(orderId);
    const data = await getOrderTechCardParameters(orderId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { ok: false, error: errorText(e, 'Не удалось обновить из шаблона') };
    }
    throw e;
  }
}

/**
 * «Обновить нормы из номенклатуры»: перечитать числа норм из карточки
 * номенклатуры. Структуру строк, параметры и характеристики не трогает —
 * в отличие от «Обновить из шаблона». Ручные строки остаются со своими
 * числами: в номенклатуре их нет.
 */
export async function reloadTechCardNormsAction(
  orderId: string,
): Promise<TechCardParamsActionResult> {
  try {
    const data = await reloadOrderTechCardNorms(orderId);
    revalidateOrder(orderId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: errorText(e, 'Не удалось обновить нормы из номенклатуры'),
      };
    }
    throw e;
  }
}

export async function saveTechCardAsTemplateAction(
  orderId: string,
  payload: unknown,
): Promise<TechCardParamsActionResult> {
  const parsed = SaveOrderTechCardAsTemplateSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Укажите код и название',
    };
  }
  try {
    const tpl = await saveOrderTechCardAsTemplate(orderId, parsed.data);
    // Справочник техкарт изменился — его страницы тоже надо освежить.
    revalidatePath('/admin/tech-cards');
    return {
      ok: true,
      savedTemplate: { id: tpl.id, code: tpl.code, name: tpl.name },
    };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: errorText(e, 'Не удалось сохранить как шаблон'),
      };
    }
    throw e;
  }
}
