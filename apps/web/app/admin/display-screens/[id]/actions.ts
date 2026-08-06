'use server';

import { revalidatePath } from 'next/cache';
import { ApiRequestError, errorText } from '@/lib/api';
import { updateDisplayScreen } from '@/lib/display-screens-api';
import type { UpdateDisplayScreenDto } from '@sewing/shared/display-screens';
import type {
  UpdateDisplayPinState,
  UpdateDisplayScreenState,
} from './form-state';

/**
 * Server actions карточки display-экрана `/admin/display-screens/[id]`.
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')` на
 * `DisplayScreensController`); фронт дополнительно скрывает раздел
 * через `app/admin/layout.tsx`.
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только
 * async-функции — типы и initial state лежат в `./form-state.ts`.
 */

/**
 * «Основное»: название экрана, подразделение и логин DISPLAY-учётки.
 *
 * Шлём PATCH целиком по трём полям (а не diff'ом): форма всегда
 * показывает актуальные значения, backend сам сравнивает с текущими и
 * пишет в аудит только реально изменившееся. PIN живёт в отдельной
 * форме — менять его вместе с названием было бы опасно (случайный
 * сброс кода на мониторе в цехе).
 *
 * Ревалидируем и список, и карточку: в списке видны те же имя,
 * подразделение и логин.
 */
export async function updateDisplayScreenAction(
  id: string,
  _prev: UpdateDisplayScreenState,
  form: FormData,
): Promise<UpdateDisplayScreenState> {
  const name = String(form.get('name') ?? '').trim();
  const companyDivisionId = String(form.get('companyDivisionId') ?? '').trim();
  const login = String(form.get('login') ?? '')
    .trim()
    .toLowerCase();

  // Локальные guard'ы — понятные сообщения без сетевого round-trip
  // (те же правила, что в `CreateDisplayScreenSchema`).
  if (name.length < 2) {
    return { error: 'Название экрана должно быть не короче 2 символов' };
  }
  if (!companyDivisionId) {
    return { error: 'Выберите подразделение' };
  }
  if (login.length < 2) {
    return { error: 'Логин должен быть не короче 2 символов' };
  }

  const dto: UpdateDisplayScreenDto = { name, companyDivisionId, login };

  try {
    await updateDisplayScreen(id, dto);
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось сохранить экран' };
  }
  revalidatePath('/admin/display-screens');
  revalidatePath(`/admin/display-screens/${id}`);
  return { ok: true, successMessage: 'Сохранено' };
}

/**
 * Смена PIN'а монитора — отдельной формой и отдельным действием.
 *
 * До появления этой ручки забытый PIN лечился только «удалить экран и
 * завести заново», что уносило DISPLAY-учётку вместе с её логином и
 * историей событий. Сам PIN нигде не хранится в открытом виде (в БД
 * только `bcrypt`-хеш) и не возвращается ни в одном DTO — поэтому
 * форма всегда пустая, а не «показать текущий».
 */
export async function updateDisplayScreenPinAction(
  id: string,
  _prev: UpdateDisplayPinState,
  form: FormData,
): Promise<UpdateDisplayPinState> {
  const pin = String(form.get('pin') ?? '');
  const pinRepeat = String(form.get('pinRepeat') ?? '');

  if (pin.length < 4) {
    return { error: 'PIN должен быть не короче 4 символов' };
  }
  if (pin !== pinRepeat) {
    return { error: 'PIN и его повтор не совпадают' };
  }

  try {
    await updateDisplayScreen(id, { pin });
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось сменить PIN' };
  }
  revalidatePath(`/admin/display-screens/${id}`);
  return {
    ok: true,
    successMessage: 'PIN изменён — монитор придётся залогинить заново',
  };
}
