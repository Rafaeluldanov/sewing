'use server';

/**
 * Inline server actions «＋ Добавить сотрудника» из select-ов других
 * форм (payroll-документы, выбор раскройщика в форме паспорта).
 *
 * ОТДЕЛЬНЫЙ файл от `./actions.ts` сознательно: страничные actions
 * редиректят на карточку сотрудника и живут в параллельном потоке
 * правок (PIN-контур) — сюда кладём только модальный сценарий,
 * возвращающий DTO (эталон — `orders/new/inline-product-actions.ts`).
 * Правило файла: только async-экспорты ('use server').
 */

import { revalidatePath } from 'next/cache';
import {
  CreateEmployeeSchema,
  type EmployeeDetailDto,
} from '@sewing/shared/employees';
import type { AppRoleDto } from '@sewing/shared/app-roles';
import { ApiRequestError, errorText } from '@/lib/api';
import { createEmployee } from '@/lib/employees-api';
import { listAppRolesSafe } from '@/lib/app-roles-api';

export interface CreateEmployeeInlineResult {
  ok?: boolean;
  employee?: EmployeeDetailDto;
  error?: string;
}

export async function createEmployeeInlineAction(
  raw: unknown,
): Promise<CreateEmployeeInlineResult> {
  const parsed = CreateEmployeeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? 'Не удалось создать сотрудника',
    };
  }
  try {
    const employee = await createEmployee(parsed.data);
    revalidatePath('/admin/employees');
    return { ok: true, employee };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e) };
    }
    return { error: 'Не удалось создать сотрудника' };
  }
}

/**
 * Роли для select-а модалки (справочник `/admin/roles`). Пустой массив
 * при ошибке — модалка упадёт на зашитый fallback `EMPLOYEE_ROLES`.
 */
export async function loadEmployeeRoleOptionsAction(): Promise<AppRoleDto[]> {
  return listAppRolesSafe();
}
