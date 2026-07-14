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
  CreateOrderTechCardParameterSchema,
  SaveOrderTechCardAsTemplateSchema,
  SetOrderTechCardParameterValueSchema,
  type OrderTechCardParametersDto,
} from '@sewing/shared/order-tech-cards';

import { ApiRequestError, errorText } from '@/lib/api';
import {
  applyOrderTechCardParameterToAll,
  createOrderTechCardParameter,
  deleteOrderTechCardParameter,
  saveOrderTechCardAsTemplate,
  setOrderTechCardParameterValue,
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
