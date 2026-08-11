'use server';

import type { MyWorkplaceDto } from '@sewing/shared/workplace';
import { WORKPLACE_SWITCH_CONFIRM_REQUIRED_CODE } from '@sewing/shared/workplace';
import { ApiRequestError } from '@/lib/api';
import { listMyWorkplaces, switchWorkplace } from '@/lib/workplace-api';

/**
 * Результат смены участка для клиента (`SwitchWorkplaceButton`).
 * Три исхода:
 *   - `ok`              — переключились; `role` → фронт сам решает, куда
 *     вести (`getPrimaryWorkspace`);
 *   - `confirmRequired` — есть незавершённая работа, нужен повтор с
 *     `force: true` (показываем подтверждение);
 *   - `error`          — человекочитаемая ошибка (нет доступа к участку,
 *     рабочее место без роли, не найдено и т.п.).
 */
export interface SwitchWorkplaceActionResult {
  ok?: { role: string; equipmentName: string | null };
  confirmRequired?: boolean;
  error?: string;
}

/**
 * Цель переключения: либо отсканированный QR рабочего места, либо
 * участок, выбранный в списке. Ровно одно из двух — это же правило
 * проверяет `SwitchWorkplaceSchema` на бэке.
 */
export type SwitchWorkplaceTarget =
  | { code: string; role?: undefined }
  | { role: string; code?: undefined };

export async function switchWorkplaceAction(
  target: SwitchWorkplaceTarget,
  force: boolean,
): Promise<SwitchWorkplaceActionResult> {
  try {
    const res = await switchWorkplace({ ...target, force });
    return { ok: { role: res.role, equipmentName: res.equipmentName } };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      if (e.code === WORKPLACE_SWITCH_CONFIRM_REQUIRED_CODE) {
        return { confirmRequired: true };
      }
      return { error: e.message };
    }
    return { error: 'Не удалось сменить участок' };
  }
}

/**
 * Список участков для шторки. Грузится по открытию, а не в RootLayout:
 * шторку открывают редко, а layout рендерится на каждой странице —
 * лишний запрос в горячем пути того не стоит.
 */
export async function loadMyWorkplacesAction(): Promise<
  { ok: true; rows: MyWorkplaceDto[] } | { ok: false; error: string }
> {
  try {
    const res = await listMyWorkplaces();
    return { ok: true, rows: res.workplaces };
  } catch (e) {
    if (e instanceof ApiRequestError) return { ok: false, error: e.message };
    return { ok: false, error: 'Не удалось загрузить список участков' };
  }
}
