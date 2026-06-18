'use server';

import { ApiRequestError } from '@/lib/api';
import { switchWorkplace } from '@/lib/workplace-api';
import { WORKPLACE_SWITCH_CONFIRM_REQUIRED_CODE } from '@sewing/shared/workplace';

/**
 * Результат смены рабочего места для клиента (`SwitchWorkplaceButton`).
 * Три исхода:
 *   - `ok`              — переключились; `role` → фронт сам решает, куда
 *     вести (`getPrimaryWorkspace`);
 *   - `confirmRequired` — есть незавершённая работа, нужен повтор с
 *     `force: true` (показываем подтверждение);
 *   - `error`          — человекочитаемая ошибка (нет доступа к роли,
 *     рабочее место без роли, не найдено и т.п.).
 */
export interface SwitchWorkplaceActionResult {
  ok?: { role: string; equipmentName: string };
  confirmRequired?: boolean;
  error?: string;
}

export async function switchWorkplaceAction(
  code: string,
  force: boolean,
): Promise<SwitchWorkplaceActionResult> {
  try {
    const res = await switchWorkplace({ code, force });
    return { ok: { role: res.role, equipmentName: res.equipmentName } };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      if (e.code === WORKPLACE_SWITCH_CONFIRM_REQUIRED_CODE) {
        return { confirmRequired: true };
      }
      return { error: e.message };
    }
    return { error: 'Не удалось сменить рабочее место' };
  }
}
