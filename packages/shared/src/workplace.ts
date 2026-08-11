/**
 * Контракты «смены роли сканом рабочего места» (фича 18.06.2026, см.
 * `Equipment.role`, `Employee.roles`/`activeRole`).
 *
 * Поток: сотрудник с несколькими ролями в кабинете нажимает «Сменить
 * рабочее место» → сканирует QR оборудования (`equipment:{id}`) →
 * backend резолвит роль рабочего места, проверяет, что она входит в
 * `Employee.roles`, при необходимости закрывает открытую смену и
 * переключает `Employee.activeRole`. Куда вести пользователя, фронт
 * решает сам (`getPrimaryWorkspace(role)` в `apps/web/lib/rbac.ts`) —
 * чтобы карта «роль → экран» не дублировалась на бэке.
 */

import { z } from 'zod';

/**
 * Тело `POST /api/me/switch-workplace`. Ровно один из двух способов
 * указать целевой участок:
 *
 *   - `code` — сырая строка из QR-сканера: `equipment:{id}`, голый
 *     `id` или человекочитаемый `Equipment.code`. Бэкенд разбирает все
 *     три формата (как `matchEquipmentByCode` на фронте).
 *   - `role` — код роли, выбранной в списке «Сменить участок»
 *     (`GET /api/me/workplaces`). Скан остаётся равноправным путём: он
 *     дополнительно называет конкретное оборудование, поэтому только
 *     он может вернуть `equipmentId` для последующего старта смены.
 *
 * `force` — подтверждение «закрыть открытую смену и перейти». При
 * незавершённой работе (открытая смена с паспортом на руках) и
 * `force !== true` бэкенд отвечает `409 WORKPLACE_SWITCH_CONFIRM_REQUIRED`;
 * UI показывает подтверждение и повторяет запрос с `force: true`.
 */
export const SwitchWorkplaceSchema = z
  .object({
    code: z.string().trim().min(1, 'Пустой код рабочего места').optional(),
    role: z.string().trim().min(1, 'Пустой код участка').optional(),
    force: z.boolean().optional(),
  })
  .refine(
    (v) => Boolean(v.code) !== Boolean(v.role),
    'Укажите либо код рабочего места, либо участок',
  );
export type SwitchWorkplaceDto = z.infer<typeof SwitchWorkplaceSchema>;

/**
 * Код ошибки «требуется подтверждение» (409). Вынесен в shared, чтобы
 * web-экшен и API-исключение использовали одну строку и не разъезжались.
 */
export const WORKPLACE_SWITCH_CONFIRM_REQUIRED_CODE =
  'WORKPLACE_SWITCH_CONFIRM_REQUIRED' as const;

/**
 * Успешный ответ `POST /api/me/switch-workplace`. Фронт по `role`
 * вычисляет целевой экран (`getPrimaryWorkspace`) и редиректит туда.
 */
export interface SwitchWorkplaceResultDto {
  /** Роль рабочего места, на которую переключились (= новый `activeRole`). */
  role: string;
  /**
   * Оборудование, чей QR отсканировали. `null` при переключении
   * выбором участка из списка — там конкретное рабочее место не
   * называется, сотрудник стартует смену обычным сканом на терминале.
   */
  equipmentId: string | null;
  equipmentName: string | null;
  equipmentDisplayNumber: string | null;
  /** id закрытой при переключении открытой смены (или `null`). */
  closedShiftId: string | null;
}

/**
 * Участок, доступный сотруднику, — строка списка «Сменить участок»
 * (`GET /api/me/workplaces`).
 *
 * Список строится по НАЗНАЧЕННЫМ ролям (`Employee.roles`), а не по
 * эффективным: наследование даёт права, но не отдельное рабочее место,
 * и роль-наследник в списке выглядела бы фантомным участком.
 */
export interface MyWorkplaceDto {
  /** Код роли (= будущий `activeRole`). */
  role: string;
  /** Название роли из справочника (`AppRole.name`). */
  label: string;
  /** Рабочий экран участка (`AppRole.workspace`). */
  workspace: string;
  /** Это текущий активный участок (`activeRole ?? role`). */
  current: boolean;
  /** Роль отмечена основной (`Employee.role`) — «экран по умолчанию». */
  primary: boolean;
}

export interface MyWorkplacesDto {
  workplaces: MyWorkplaceDto[];
}
