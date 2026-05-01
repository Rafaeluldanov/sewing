'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { createEmployee, updateEmployee } from '@/lib/employees-api';
import {
  COMPENSATION_TYPES,
  EMPLOYEE_ROLES,
  type CompensationType,
  type CreateEmployeeDto,
  type EmployeeRole,
  type UpdateEmployeeDto,
} from '@sewing/shared/employees';
import type {
  CreateEmployeeState,
  UpdateEmployeeState,
} from './form-state';

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

function isEmployeeRole(v: string): v is EmployeeRole {
  return (EMPLOYEE_ROLES as readonly string[]).includes(v);
}

/**
 * Server action для создания нового сотрудника со страницы
 * `/admin/employees/new`. Поля собираются из FormData, валидируются
 * локально (понятные сообщения без round-trip), потом улетают в
 * `POST /api/employees` (см. `docs/api.md §3b`). При успехе —
 * `revalidate('/admin/employees')` и redirect на карточку нового
 * сотрудника, как в equipment/operations/warehouses.
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 */
export async function createEmployeeAction(
  _prev: CreateEmployeeState,
  form: FormData,
): Promise<CreateEmployeeState> {
  const fullName = String(form.get('fullName') ?? '').trim();
  const login = String(form.get('login') ?? '').trim().toLowerCase();
  const pin = String(form.get('pin') ?? '');
  const roleRaw = String(form.get('role') ?? '').trim();
  const compensationRaw = String(form.get('compensationType') ?? '').trim();
  const salaryRaw = String(form.get('salaryPerShift') ?? '').trim();
  const cutterB2bRaw = String(
    form.get('cutterB2bSewingPercent') ?? '',
  ).trim();
  const active = form.get('active') === 'on';

  if (fullName.length === 0) return { error: 'Введите ФИО сотрудника' };
  if (login.length < 2) {
    return { error: 'Логин должен быть не короче 2 символов' };
  }
  if (pin.length < 4) {
    return { error: 'PIN должен быть не короче 4 символов' };
  }
  if (!isEmployeeRole(roleRaw)) return { error: 'Выберите роль' };
  if (!isCompensationType(compensationRaw)) {
    return { error: 'Выберите тип компенсации' };
  }

  const dto: CreateEmployeeDto = {
    fullName,
    login,
    pin,
    role: roleRaw,
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

  // Процент B2B-начисления закройщика. См.
  // `docs/payroll-cutter-compensation-recon.md`. Поле опционально:
  //   - пустая строка → не передаём (backend оставит null);
  //   - не-CUTTER + значение → пропускаем без ошибки (UI поле не
  //     показывает; на бэке колонка имеет смысл только для CUTTER —
  //     EarningsService её и так читает только для роли CUTTER);
  //   - CUTTER + валидное число → отправляем как есть.
  if (cutterB2bRaw !== '' && roleRaw === 'CUTTER') {
    const num = Number(cutterB2bRaw.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      return {
        error: 'Процент B2B должен быть числом в диапазоне [0; 100]',
      };
    }
    dto.cutterB2bSewingPercent = Math.round(num * 100) / 100;
  }

  let createdId: string | null = null;
  try {
    const created = await createEmployee(dto);
    createdId = created.id;
    revalidatePath('/admin/employees');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать сотрудника' };
  }
  // redirect выбрасывает специальный NEXT_REDIRECT — выносим за try,
  // чтобы catch его не перехватил (тот же приём, что в
  // `createWarehouseAction` и `createEquipmentAction`).
  if (createdId) {
    redirect(`/admin/employees/${createdId}`);
  }
  return { ok: true };
}

export async function updateEmployeeAction(
  employeeId: string,
  _prev: UpdateEmployeeState,
  form: FormData,
): Promise<UpdateEmployeeState> {
  const compensationRaw = String(form.get('compensationType') ?? '').trim();
  const salaryRaw = String(form.get('salaryPerShift') ?? '').trim();
  const active = form.get('active') === 'on';
  // FormData может НЕ содержать ключ `cutterB2bSewingPercent`
  // (для не-CUTTER ролей UI поле не рендерит). `form.get(...)`
  // вернёт `null` — `String(null)` мы делать не хотим, лучше
  // отличить «ключа нет» от «строка пустая». Если ключа нет —
  // не трогаем колонку (`undefined` в DTO).
  const hasCutterB2bKey = form.has('cutterB2bSewingPercent');
  const cutterB2bRaw = hasCutterB2bKey
    ? String(form.get('cutterB2bSewingPercent') ?? '').trim()
    : null;

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

  // Процент B2B-начисления закройщика — см.
  // `docs/payroll-cutter-compensation-recon.md`.
  // Семантика:
  //   - ключа нет в FormData (роль не CUTTER, UI поле не показал)
  //     → DTO без `cutterB2bSewingPercent` (backend колонку не трогает);
  //   - ключ есть, строка пуста → передаём `null` (стереть значение,
  //     backend возьмёт fallback из ENV);
  //   - ключ есть, валидное число → передаём число.
  if (hasCutterB2bKey) {
    if (cutterB2bRaw === '' || cutterB2bRaw === null) {
      dto.cutterB2bSewingPercent = null;
    } else {
      const num = Number(cutterB2bRaw.replace(',', '.'));
      if (!Number.isFinite(num) || num < 0 || num > 100) {
        return {
          error: 'Процент B2B должен быть числом в диапазоне [0; 100]',
        };
      }
      dto.cutterB2bSewingPercent = Math.round(num * 100) / 100;
    }
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
