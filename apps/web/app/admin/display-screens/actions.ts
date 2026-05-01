'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { createDisplayScreen } from '@/lib/display-screens-api';
import {
  ORDER_DIVISIONS,
  type OrderDivision,
} from '@sewing/shared/orders';
import type { CreateDisplayScreenDto } from '@sewing/shared/display-screens';
import type { CreateDisplayScreenState } from './form-state';

/**
 * Server actions блока «Display screens».
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')` на
 * `DisplayScreensController`). Frontend дополнительно скрывает раздел
 * через `app/admin/layout.tsx`.
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только
 * async-функции — initial state и тип лежат в `./form-state.ts`.
 */

function isOrderDivision(v: string): v is OrderDivision {
  return (ORDER_DIVISIONS as readonly string[]).includes(v);
}

/**
 * Создание display-экрана + DISPLAY-учётки одной транзакцией
 * (см. `docs/api.md §11`). Поля собираются из FormData, валидируются
 * локально (понятные сообщения без round-trip), потом улетают в
 * `POST /api/display-screens`. При успехе — `revalidate
 * ('/admin/display-screens')` и redirect обратно на список (карточки
 * экрана на MVP нет, см. `docs/screens.md §10e`).
 */
export async function createDisplayScreenAction(
  _prev: CreateDisplayScreenState,
  form: FormData,
): Promise<CreateDisplayScreenState> {
  const name = String(form.get('name') ?? '').trim();
  const divisionRaw = String(form.get('division') ?? '').trim();
  const login = String(form.get('login') ?? '').trim().toLowerCase();
  const pin = String(form.get('pin') ?? '');
  const isActive = form.get('isActive') === 'on';

  if (name.length < 2) {
    return { error: 'Название экрана должно быть не короче 2 символов' };
  }
  if (!isOrderDivision(divisionRaw)) {
    return { error: 'Выберите подразделение' };
  }
  if (login.length < 2) {
    return { error: 'Логин должен быть не короче 2 символов' };
  }
  if (pin.length < 4) {
    return { error: 'PIN должен быть не короче 4 символов' };
  }

  const dto: CreateDisplayScreenDto = {
    name,
    division: divisionRaw,
    login,
    pin,
    isActive,
  };

  let createdOk = false;
  try {
    await createDisplayScreen(dto);
    createdOk = true;
    revalidatePath('/admin/display-screens');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать display-экран' };
  }
  // redirect выбрасывает специальный NEXT_REDIRECT — выносим за try,
  // чтобы catch его не перехватил (тот же приём, что в
  // `createEmployeeAction` и `createWarehouseAction`). На MVP
  // отдельной карточки экрана нет, поэтому возвращаемся на список.
  if (createdOk) {
    redirect('/admin/display-screens');
  }
  return { ok: true };
}
