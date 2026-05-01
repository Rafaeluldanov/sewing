'use server';

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import { updateEmployee } from '@/lib/employees-api';
import {
  COMPENSATION_TYPES,
  type CompensationType,
  type UpdateEmployeeDto,
} from '@sewing/shared/employees';
import type { UpdateEmployeeState } from './form-state';

/**
 * Server actions блока «Сотрудники» (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только async-функции.
 * Тип `UpdateEmployeeState` и `initialUpdateEmployeeState` живут в
 * `./form-state.ts` — это отдельный модуль без `'use server'`.
 */

function isCompensationType(v: string): v is CompensationType {
  return (COMPENSATION_TYPES as readonly string[]).includes(v);
}

export async function updateEmployeeAction(
  employeeId: string,
  _prev: UpdateEmployeeState,
  form: FormData,
): Promise<UpdateEmployeeState> {
  const compensationRaw = String(form.get('compensationType') ?? '').trim();
  const salaryRaw = String(form.get('salaryPerShift') ?? '').trim();
  const active = form.get('active') === 'on';

  if (!isCompensationType(compensationRaw)) {
    return { error: 'Выберите тип компенсации' };
  }

  const dto: UpdateEmployeeDto = {
    compensationType: compensationRaw,
    active,
  };

  if (salaryRaw === '') {
    if (compensationRaw !== 'PIECEWORK') {
      return { error: 'Для SALARY/MIXED обязательно укажите ставку за смену' };
    }
    dto.salaryPerShift = null;
  } else {
    const num = Number(salaryRaw.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) {
      return { error: 'Введите валидную ставку за смену' };
    }
    if (num === 0 && compensationRaw !== 'PIECEWORK') {
      return { error: 'Для SALARY/MIXED ставка должна быть больше нуля' };
    }
    dto.salaryPerShift = num;
  }

  try {
    await updateEmployee(employeeId, dto);
    revalidatePath('/admin/employees');
    revalidatePath(`/admin/employees/${employeeId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить сотрудника' };
  }
}
