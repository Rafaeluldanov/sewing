'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  archiveEmployee,
  createEmployee,
  deleteEmployee,
  restoreEmployee,
  revealEmployeePin,
  updateEmployee,
} from '@/lib/employees-api';
import {
  COMPENSATION_TYPES,
  RoleCodeRefSchema,
  SALARY_RATE_MODES,
  requiresHourlySalaryRate,
  requiresMonthlySalaryRate,
  type CompensationType,
  type CreateEmployeeDto,
  type SalaryRateMode,
  type UpdateEmployeeDto,
} from '@sewing/shared/employees';
import type {
  CreateEmployeeState,
  RevealEmployeePinState,
  UpdateEmployeeState,
  UpdateEmployeePinState,
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

function isSalaryRateMode(v: string): v is SalaryRateMode {
  return (SALARY_RATE_MODES as readonly string[]).includes(v);
}

/**
 * Разбор денежного поля ставки из FormData.
 *
 * Возвращает либо число, либо `null` («поле пустое»), либо текст
 * ошибки. Заведено одной функцией, потому что правил три (валидное
 * число / не отрицательное / не ноль, если ставка обязательна), а мест
 * применения — четыре: часовая и месячная ставка в create и в update.
 */
function parseRateField(
  raw: string,
  required: boolean,
  labels: { missing: string; invalid: string; zero: string },
): { value: number | null } | { error: string } {
  if (raw === '') {
    if (required) return { error: labels.missing };
    return { value: null };
  }
  const num = Number(raw.replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return { error: labels.invalid };
  if (num === 0 && required) return { error: labels.zero };
  return { value: num };
}

const HOURLY_RATE_LABELS = {
  missing: 'Для часового оклада укажите ставку ₽/час',
  invalid: 'Введите валидную почасовую ставку',
  zero: 'Почасовая ставка должна быть больше нуля',
};

const MONTHLY_RATE_LABELS = {
  missing: 'Для месячного оклада укажите сумму ₽/мес',
  invalid: 'Введите валидную сумму месячного оклада',
  zero: 'Месячный оклад должен быть больше нуля',
};

/**
 * Роль — ССЫЛКА на справочник (`AppRole.code`), а не enum: роли заводят
 * из `/admin/roles`, и сверка с зашитым `EMPLOYEE_ROLES` отвергала бы
 * любую новую роль сообщением «Выберите роль».
 *
 * Здесь проверяем только ФОРМУ кода (та же `RoleCodeRefSchema`, что и в
 * DTO) и нормализуем регистр. Существование кода проверяет backend
 * (`EmployeesService.assertRolesExist` → `EMPLOYEE_ROLE_UNKNOWN`).
 */
function parseRoleCode(v: string): string | null {
  const parsed = RoleCodeRefSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
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
  // Вид окладной ставки. Ключа может не быть (форма не показала
  // переключатель для PIECEWORK) — тогда считаем `HOURLY`, это же
  // дефолт колонки.
  const rateModeRaw = String(
    form.get('salaryRateMode') ?? 'HOURLY',
  ).trim();
  const salaryRaw = String(form.get('salaryPerHour') ?? '').trim();
  const salaryMonthRaw = String(form.get('salaryPerMonth') ?? '').trim();
  const cutterB2bRaw = String(
    form.get('cutterB2bSewingPercent') ?? '',
  ).trim();
  // PHASE 2 STEP 2: подразделение сотрудника. Поле может отсутствовать
  // в FormData (UI не показал select, потому что у проекта нет ни
  // одного активного подразделения) — тогда DTO не получит ключа,
  // backend оставит `null`. Пустая строка означает «без привязки».
  const companyDivisionRaw = form.has('companyDivisionId')
    ? String(form.get('companyDivisionId') ?? '').trim()
    : null;
  const active = form.get('active') === 'on';

  if (fullName.length === 0) return { error: 'Введите ФИО сотрудника' };
  if (login.length < 2) {
    return { error: 'Логин должен быть не короче 2 символов' };
  }
  if (pin.length < 4) {
    return { error: 'PIN должен быть не короче 4 символов' };
  }
  const role = parseRoleCode(roleRaw);
  if (role === null) return { error: 'Выберите роль' };
  if (!isCompensationType(compensationRaw)) {
    return { error: 'Выберите тип компенсации' };
  }
  if (!isSalaryRateMode(rateModeRaw)) {
    return { error: 'Выберите вид оклада: часовой или месячный' };
  }

  const dto: CreateEmployeeDto = {
    fullName,
    login,
    pin,
    role,
    compensationType: compensationRaw,
    salaryRateMode: rateModeRaw,
    active,
  };

  // Обязательна ровно одна ставка — та, что соответствует режиму
  // (см. `requiresHourlySalaryRate` / `requiresMonthlySalaryRate` в
  // shared: то же правило проверяет backend).
  const hourly = parseRateField(
    salaryRaw,
    requiresHourlySalaryRate(compensationRaw, rateModeRaw),
    HOURLY_RATE_LABELS,
  );
  if ('error' in hourly) return { error: hourly.error };
  dto.salaryPerHour = hourly.value;

  const monthly = parseRateField(
    salaryMonthRaw,
    requiresMonthlySalaryRate(compensationRaw, rateModeRaw),
    MONTHLY_RATE_LABELS,
  );
  if ('error' in monthly) return { error: monthly.error };
  dto.salaryPerMonth = monthly.value;

  // Процент B2B-начисления закройщика. См.
  // `docs/payroll-cutter-compensation-recon.md`. Поле опционально:
  //   - пустая строка → не передаём (backend оставит null);
  //   - не-CUTTER + значение → пропускаем без ошибки (UI поле не
  //     показывает; на бэке колонка имеет смысл только для CUTTER —
  //     EarningsService её и так читает только для роли CUTTER);
  //   - CUTTER + валидное число → отправляем как есть.
  if (cutterB2bRaw !== '' && role === 'CUTTER') {
    const num = Number(cutterB2bRaw.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      return {
        error: 'Процент B2B должен быть числом в диапазоне [0; 100]',
      };
    }
    dto.cutterB2bSewingPercent = Math.round(num * 100) / 100;
  }

  // PHASE 2 STEP 2: подразделение. Если ключ был в FormData (UI
  // показал select), отправляем явное значение — пустая строка =
  // `null` (без привязки). Если ключа нет — DTO без поля, backend
  // оставит `null`.
  if (companyDivisionRaw !== null) {
    dto.companyDivisionId =
      companyDivisionRaw === '' ? null : companyDivisionRaw;
  }

  let createdId: string | null = null;
  try {
    const created = await createEmployee(dto);
    createdId = created.id;
    revalidatePath('/admin/employees');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: errorText(e),
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
  const rateModeRaw = String(
    form.get('salaryRateMode') ?? 'HOURLY',
  ).trim();
  const salaryRaw = String(form.get('salaryPerHour') ?? '').trim();
  const salaryMonthRaw = String(form.get('salaryPerMonth') ?? '').trim();
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
  // PHASE 2 STEP 2: подразделение. Та же семантика
  // «ключа нет — не трогаем колонку», см. cutterB2bSewingPercent.
  const hasDivisionKey = form.has('companyDivisionId');
  const divisionRaw = hasDivisionKey
    ? String(form.get('companyDivisionId') ?? '').trim()
    : null;
  // Статья ДДС для выплат. Та же семантика «ключа нет — не трогаем
  // колонку»: select показан для всех сотрудников, поэтому ключ обычно
  // есть; пустое значение → `null` (снять привязку).
  const hasSalaryItemKey = form.has('salaryCashFlowItemId');
  const salaryItemRaw = hasSalaryItemKey
    ? String(form.get('salaryCashFlowItemId') ?? '').trim()
    : null;

  if (!isCompensationType(compensationRaw)) {
    return { error: 'Выберите тип компенсации' };
  }
  if (!isSalaryRateMode(rateModeRaw)) {
    return { error: 'Выберите вид оклада: часовой или месячный' };
  }

  const dto: UpdateEmployeeDto = {
    compensationType: compensationRaw,
    salaryRateMode: rateModeRaw,
    active,
  };

  // Ставку, не соответствующую режиму, НЕ стираем: менеджер может
  // временно переключить человека на месячный оклад и вернуть обратно,
  // и потерять при этом заведённую почасовую ставку — обидно.
  const hourly = parseRateField(
    salaryRaw,
    requiresHourlySalaryRate(compensationRaw, rateModeRaw),
    HOURLY_RATE_LABELS,
  );
  if ('error' in hourly) return { error: hourly.error };
  if (hourly.value !== null || rateModeRaw === 'HOURLY') {
    dto.salaryPerHour = hourly.value;
  }

  const monthly = parseRateField(
    salaryMonthRaw,
    requiresMonthlySalaryRate(compensationRaw, rateModeRaw),
    MONTHLY_RATE_LABELS,
  );
  if ('error' in monthly) return { error: monthly.error };
  if (monthly.value !== null || rateModeRaw === 'MONTHLY') {
    dto.salaryPerMonth = monthly.value;
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

  // PHASE 2 STEP 2: подразделение. Семантика:
  //   - ключа нет в FormData (UI не показал select) → DTO без поля
  //     (backend колонку не трогает);
  //   - ключ есть, пустая строка → `null` (стираем привязку);
  //   - ключ есть, ID → передаём как есть (backend проверит, что
  //     подразделение существует и активно).
  if (hasDivisionKey) {
    dto.companyDivisionId =
      divisionRaw === '' || divisionRaw === null ? null : divisionRaw;
  }

  // Статья ДДС для выплат: ключ есть, пустая строка → `null` (снять
  // привязку, проводка возьмёт глобальную статью); id → привязать.
  if (hasSalaryItemKey) {
    dto.salaryCashFlowItemId =
      salaryItemRaw === '' || salaryItemRaw === null ? null : salaryItemRaw;
  }

  try {
    await updateEmployee(employeeId, dto);
    revalidatePath('/admin/employees');
    revalidatePath(`/admin/employees/${employeeId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: errorText(e),
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить сотрудника' };
  }
}

// ---------------------------------------------------------------------------
// PIN сотрудника: показать текущий / задать новый.
// ---------------------------------------------------------------------------

/**
 * «Показать» PIN в блоке «Доступ» карточки сотрудника.
 *
 * Вызывается по явному нажатию, а не при рендере страницы: каждый показ
 * пишется в журнал аудита (`EMPLOYEE_PIN_VIEWED`), и подгружать PIN
 * заранее — значит засорять журнал просмотрами, которых не было, и
 * гонять пароль по сети без надобности.
 *
 * `pin: null` от backend'а — не ошибка: у карточки просто нет обратимой
 * копии кода (заведена до появления фичи, либо не настроен
 * `INTEGRATION_SECRET_KEY`). Лечение во всех случаях одно — задать PIN
 * заново формой «Смена PIN», поэтому причины различаются только текстом.
 */
export async function revealEmployeePinAction(
  employeeId: string,
): Promise<RevealEmployeePinState> {
  try {
    const res = await revealEmployeePin(employeeId);
    if (res.pin) return { pin: res.pin };
    return {
      notice:
        res.reason === 'NO_KEY'
          ? 'Показ пароля не настроен на сервере (нет ключа шифрования INTEGRATION_SECRET_KEY). Задайте PIN заново — тогда его можно будет показывать.'
          : res.reason === 'DECRYPT_FAILED'
          ? 'Сохранённый пароль не читается текущим ключом шифрования. Задайте PIN заново.'
          : 'PIN этого сотрудника был задан до появления показа пароля — в базе только необратимый хеш. Задайте PIN заново, и его можно будет посмотреть.',
    };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось показать пароль' };
  }
}

/**
 * Смена PIN сотрудника — отдельным action'ом и отдельной формой.
 *
 * Поле повтора — защита от опечатки: если менеджер ошибётся, человек
 * просто не войдёт в свою смену, и разбираться будут уже у станка.
 * Backend перезапишет обе колонки (`pinHash` + обратимую `pinEnc`)
 * одним апдейтом — см. `EmployeesService.buildPinColumns`.
 */
export async function updateEmployeePinAction(
  employeeId: string,
  _prev: UpdateEmployeePinState,
  form: FormData,
): Promise<UpdateEmployeePinState> {
  const pin = String(form.get('pin') ?? '');
  const pinRepeat = String(form.get('pinRepeat') ?? '');

  if (pin.length < 4) {
    return { error: 'PIN должен быть не короче 4 символов' };
  }
  if (pin !== pinRepeat) {
    return { error: 'PIN и его повтор не совпадают' };
  }

  try {
    await updateEmployee(employeeId, { pin });
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось сменить PIN' };
  }
  revalidatePath(`/admin/employees/${employeeId}`);
  return {
    ok: true,
    successMessage: 'PIN изменён — сотруднику придётся войти заново.',
  };
}

/**
 * Назначение ролей сотруднику из раздела «Настройки → Роли сотрудников»
 * (фича «несколько ролей»). Отдельный action (а не часть
 * `updateEmployeeAction`): редактирование ролей вынесено из карточки
 * сотрудника в меню настроек — выбираем сотрудника и прикрепляем роли.
 *
 * Тело FormData: набор `roles` (чекбоксы) + `primaryRole` (radio).
 * Backend (`UpdateEmployeeSchema` + `EmployeesService.update`) держит
 * инвариант «набор содержит основную роль», режет выдачу ADMIN
 * не-админом и защищает последнего администратора.
 */
export async function updateEmployeeRolesAction(
  employeeId: string,
  _prev: UpdateEmployeeState,
  form: FormData,
): Promise<UpdateEmployeeState> {
  // Коды ролей приходят из справочника — фильтровать их зашитым
  // перечнем нельзя: кастомная роль молча выпала бы из набора, а
  // «основная» превратилась бы в «Выберите основную роль».
  const roles = form
    .getAll('roles')
    .map((v) => parseRoleCode(String(v)))
    .filter((v): v is string => v !== null);
  const primary = parseRoleCode(String(form.get('primaryRole') ?? ''));
  if (roles.length === 0) {
    return { error: 'Выберите хотя бы одну роль' };
  }
  if (primary === null) {
    return { error: 'Выберите основную роль' };
  }
  if (!roles.includes(primary)) {
    return { error: 'Основная роль должна быть среди выбранных' };
  }

  const dto: UpdateEmployeeDto = { role: primary, roles };
  try {
    await updateEmployee(employeeId, dto);
    revalidatePath('/admin/company-settings');
    revalidatePath('/admin/employees');
    revalidatePath(`/admin/employees/${employeeId}`);
    return { ok: true, successMessage: 'Роли сохранены.' };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: errorText(e),
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить роли' };
  }
}

// ---------------------------------------------------------------------------
// Archive / restore / hard-delete (см. `docs/employee-deletion-recon.md`).
// Все три action'а — простой post-обёрток над API: backend всё валидирует
// сам (RBAC, блокеры, last-admin, self), action только пробрасывает
// ошибку и зовёт `revalidatePath` после успеха.
// ---------------------------------------------------------------------------

export interface DeleteEmployeeActionState {
  ok?: true;
  error?: string;
  errorCode?: string;
  errorRequestId?: string;
}

export async function archiveEmployeeAction(
  employeeId: string,
): Promise<DeleteEmployeeActionState> {
  try {
    await archiveEmployee(employeeId);
    revalidatePath('/admin/employees');
    revalidatePath(`/admin/employees/${employeeId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: e.message,
        errorCode: e.code,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось архивировать сотрудника' };
  }
}

export async function restoreEmployeeAction(
  employeeId: string,
): Promise<DeleteEmployeeActionState> {
  try {
    await restoreEmployee(employeeId);
    revalidatePath('/admin/employees');
    revalidatePath(`/admin/employees/${employeeId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: e.message,
        errorCode: e.code,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось восстановить сотрудника' };
  }
}

/**
 * Hard-delete. Принимает дополнительный флаг `ackDisplayCascade` для
 * случаев DISPLAY-учёток с привязанным экраном (`onDelete: Cascade`).
 *
 * При успехе делает `revalidate('/admin/employees')`. Возвращать
 * `redirect` на список — нельзя из action'а без обёртки, поэтому
 * вызывающий клиент сам делает `router.push('/admin/employees')` или
 * полагается на закрытие модалки + revalidate.
 */
export async function deleteEmployeeAction(
  employeeId: string,
  opts: { ackDisplayCascade?: boolean } = {},
): Promise<DeleteEmployeeActionState> {
  try {
    await deleteEmployee(employeeId, opts);
    revalidatePath('/admin/employees');
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: e.message,
        errorCode: e.code,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось удалить сотрудника' };
  }
}
