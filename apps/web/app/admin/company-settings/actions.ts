'use server';

/**
 * Server actions блока «Настройки компании».
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только async-
 * функции, типы и initial state живут в `./form-state.ts`.
 */

import { revalidatePath } from 'next/cache';
import {
  OFF_ROUTE_WORK_POLICIES,
  OFF_ROUTE_WORK_POLICY_LABELS,
  sessionIdleTimeoutLabel,
  SESSION_IDLE_TIMEOUT_PRESETS,
  SHIFT_AUTO_CLOSE_MODES,
  SHIFT_MAX_DURATION_PRESETS,
  UpdateCompanySettingsSchema,
  type UpdateCompanySettingsDto,
} from '@sewing/shared/company-settings';
import {
  CreateCompanyDivisionSchema,
  UpdateCompanyDivisionSchema,
  type CreateCompanyDivisionDto,
  type UpdateCompanyDivisionDto,
} from '@sewing/shared/company-divisions';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  createCompanyDivision,
  terminateAllSessions,
  updateCompanyDivision,
  updateCompanySettings,
} from '@/lib/company-settings-api';
import type {
  UpdateOffRoutePolicyState,
  UpdateSessionPolicyState,
  UpdateShiftAutoCloseState,
  CreateCompanyDivisionState,
  UpdateCompanyDivisionOverridesState,
  UpdateCompanyDivisionState,
  UpdateCompanySettingsState,
} from './form-state';

const ADMIN_PATH = '/admin/company-settings';

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return {
      error: errorText(e),
      requestId: e.requestId,
    };
  }
  return { error: 'Не удалось выполнить запрос' };
}

// ---------------------------------------------------------------------------
// Settings (singleton)
// ---------------------------------------------------------------------------

const SETTINGS_FIELDS = [
  'legalName',
  'shortName',
  'prefix',
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'actualAddress',
  'phone',
  'email',
  'directorName',
  'accountantName',
  'bankName',
  'bik',
  'correspondentAccount',
  'settlementAccount',
] as const;

/**
 * Boolean-флаги блока «Материалы и склад». В отличие от строковых
 * реквизитов, браузер не посылает unchecked-checkbox в `FormData`
 * (stale `null`), поэтому явно различаем их через hidden-маркер
 * `${name}__present`, который рендерит форма (см. settings-form.tsx).
 */
const SETTINGS_BOOLEAN_FIELDS = [
  'autoIssueMaterialsOnCutRelease',
  'allowNegativeMaterialStock',
] as const;

function buildSettingsDto(form: FormData): UpdateCompanySettingsDto {
  // Семантика — как в `clients/actions.ts::buildUpdateDto`: поле есть в
  // форме (`!== null`) → передаём как строку (включая пустую, которая
  // через preprocess превратится в `null`), иначе оставляем
  // `undefined` — backend такие не трогает.
  const dto: Record<string, string | boolean | undefined> = {};
  for (const key of SETTINGS_FIELDS) {
    const v = form.get(key);
    if (v === null) continue;
    dto[key] = String(v);
  }
  for (const key of SETTINGS_BOOLEAN_FIELDS) {
    // hidden-marker `${key}__present` ставится формой всегда;
    // `${key}` приходит только если чекбокс включён → браузер шлёт
    // `on` (`checked`-default). Отсутствие marker-а означает, что
    // блок не рендерился вовсе — поле не трогаем.
    if (form.get(`${key}__present`) === null) continue;
    dto[key] = form.get(key) !== null;
  }
  return dto as UpdateCompanySettingsDto;
}

export async function updateCompanySettingsAction(
  _prev: UpdateCompanySettingsState,
  form: FormData,
): Promise<UpdateCompanySettingsState> {
  const parsed = UpdateCompanySettingsSchema.safeParse(buildSettingsDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateCompanySettings(parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Реквизиты сохранены.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Divisions (CRUD)
// ---------------------------------------------------------------------------

function buildCreateDivisionDto(form: FormData): CreateCompanyDivisionDto {
  const sortOrderRaw = form.get('sortOrder');
  const sortOrder = sortOrderRaw === null || sortOrderRaw === ''
    ? undefined
    : Number(sortOrderRaw);
  return {
    code: String(form.get('code') ?? '').trim(),
    name: String(form.get('name') ?? '').trim(),
    description:
      form.get('description') === null
        ? undefined
        : String(form.get('description') ?? ''),
    sortOrder: sortOrder !== undefined && Number.isFinite(sortOrder)
      ? sortOrder
      : undefined,
  };
}

function buildUpdateDivisionDto(form: FormData): UpdateCompanyDivisionDto {
  const dto: UpdateCompanyDivisionDto = {};
  if (form.get('code') !== null) {
    dto.code = String(form.get('code') ?? '').trim();
  }
  if (form.get('name') !== null) {
    dto.name = String(form.get('name') ?? '').trim();
  }
  if (form.get('description') !== null) {
    dto.description = String(form.get('description') ?? '');
  }
  if (form.get('sortOrder') !== null) {
    const n = Number(form.get('sortOrder'));
    if (Number.isFinite(n)) dto.sortOrder = n;
  }
  if (form.get('isActive') !== null) {
    dto.isActive = form.get('isActive') === 'on';
  }
  return dto;
}

export async function createCompanyDivisionAction(
  _prev: CreateCompanyDivisionState,
  form: FormData,
): Promise<CreateCompanyDivisionState> {
  const parsed = CreateCompanyDivisionSchema.safeParse(
    buildCreateDivisionDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await createCompanyDivision(parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Подразделение создано.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function updateCompanyDivisionAction(
  divisionId: string,
  _prev: UpdateCompanyDivisionState,
  form: FormData,
): Promise<UpdateCompanyDivisionState> {
  const parsed = UpdateCompanyDivisionSchema.safeParse(
    buildUpdateDivisionDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateCompanyDivision(divisionId, parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Server action секции «Настройки по подразделениям» блока
 * «Материалы и склад»
 * (см. `material-stock-division-overrides-section.tsx`,
 * `apps/api/src/modules/company-settings/company-settings.service.ts::getEffectiveMaterialStockSettingsForOrder`,
 * `docs/current-state.md §«Материалы и склад — division overrides»`).
 *
 * Принимает одну строку-форму с двумя select-ами и сохраняет их
 * override-значения через существующий `PATCH /api/company-divisions/:id`.
 * Новый backend endpoint не создаём — используем тот же контракт,
 * что и обычное редактирование подразделения.
 *
 * Values select-а (см. `DIVISION_OVERRIDE_*_VALUE`):
 *   - `'inherit'` → `null`  (наследовать глобальную `CompanySettings`);
 *   - `'true'`    → `true`  (принудительно включить override);
 *   - `'false'`   → `false` (принудительно выключить override);
 *   - отсутствие поля в форме (`null`) трактуем как `undefined` и не
 *     трогаем значение в БД (безопасный дефолт; в нашем UI select
 *     всегда присутствует, но страхуемся).
 */
function parseDivisionOverrideFieldValue(
  raw: FormDataEntryValue | null,
): boolean | null | undefined {
  if (raw === null) return undefined;
  const v = String(raw);
  if (v === 'inherit') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export async function updateCompanyDivisionOverridesAction(
  divisionId: string,
  _prev: UpdateCompanyDivisionOverridesState,
  form: FormData,
): Promise<UpdateCompanyDivisionOverridesState> {
  const body: UpdateCompanyDivisionDto = {};
  const auto = parseDivisionOverrideFieldValue(
    form.get('autoIssueMaterialsOnCutReleaseOverride'),
  );
  if (auto !== undefined) body.autoIssueMaterialsOnCutReleaseOverride = auto;
  const neg = parseDivisionOverrideFieldValue(
    form.get('allowNegativeMaterialStockOverride'),
  );
  if (neg !== undefined) body.allowNegativeMaterialStockOverride = neg;

  const parsed = UpdateCompanyDivisionSchema.safeParse(body);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }

  try {
    await updateCompanyDivision(divisionId, parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Тонкий wrapper над `updateCompanyDivisionAction` для inline-кнопки
 * «Включить» / «Отключить» в таблице. Не использует form-state, потому
 * что вызов идёт строго из `<form action={…}>` без `useFormState`.
 */
export async function toggleCompanyDivisionActiveAction(
  form: FormData,
): Promise<void> {
  const id = String(form.get('id') ?? '');
  const next = form.get('isActive') === 'true';
  if (!id) return;
  try {
    await updateCompanyDivision(id, { isActive: next });
  } catch {
    // Inline-toggle сознательно fail-soft: ошибку увидит пользователь
    // через basic redirect-revalidate (обновлённый список покажет
    // прежнее состояние). Подробной диагностики не показываем — для
    // редактирования есть `EditDivisionForm` со своим error-box.
  }
  revalidatePath(ADMIN_PATH);
}

/**
 * Server action секции «Работа мимо маршрута»: меняет строгость гейта
 * (`CompanySettings.offRouteWorkPolicy`) через тот же
 * `PATCH /api/company-settings`, что и остальные настройки.
 *
 * Блокеры (шаблоны с архивной швейной операцией) переключение НЕ
 * запрещают — решение владельца: предупредить, но пустить. Жёсткий
 * запрет в настройках раздражает больше, чем помогает, а владелец может
 * знать контекст, которого система не видит.
 */
export async function updateOffRoutePolicyAction(
  _prev: UpdateOffRoutePolicyState,
  form: FormData,
): Promise<UpdateOffRoutePolicyState> {
  const raw = String(form.get('offRouteWorkPolicy') ?? '');
  const policy = OFF_ROUTE_WORK_POLICIES.find((p) => p === raw);
  if (!policy) {
    return { error: 'Не выбран режим строгости' };
  }
  try {
    await updateCompanySettings({ offRouteWorkPolicy: policy });
    revalidatePath(ADMIN_PATH);
    return {
      ok: true,
      successMessage: `Строгость сохранена: ${OFF_ROUTE_WORK_POLICY_LABELS[policy]}.`,
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Вход и сессии (автовыход по бездействию + «завершить все сеансы»)
// ---------------------------------------------------------------------------

/**
 * Сохраняет окно автовыхода по бездействию.
 *
 * Значение принимаем только из списка пресетов: свободный ввод минут
 * здесь ни к чему, а заодно это отсекает «0.5» и прочие способы
 * получить окно, в котором человека выкидывает посреди работы.
 */
export async function updateSessionIdleTimeoutAction(
  _prev: UpdateSessionPolicyState,
  form: FormData,
): Promise<UpdateSessionPolicyState> {
  const raw = String(form.get('sessionIdleTimeoutMinutes') ?? '');
  const minutes = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(minutes) ||
    !SESSION_IDLE_TIMEOUT_PRESETS.includes(
      minutes as (typeof SESSION_IDLE_TIMEOUT_PRESETS)[number],
    )
  ) {
    return { error: 'Не выбрано время бездействия' };
  }
  try {
    await updateCompanySettings({ sessionIdleTimeoutMinutes: minutes });
    revalidatePath(ADMIN_PATH);
    return {
      ok: true,
      successMessage:
        minutes === 0
          ? 'Автовыход выключен: сессия живёт до конца рабочего дня.'
          : `Автовыход сохранён: ${sessionIdleTimeoutLabel(minutes).toLowerCase()}.`,
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * «Завершить все сеансы». Выгоняет всех, включая того, кто нажал:
 * его собственная cookie тоже выпущена до отсечки. Поэтому сообщение
 * об успехе он, скорее всего, увидит уже на форме входа — это
 * ожидаемо, и секция предупреждает об этом заранее.
 */
export async function terminateSessionsAction(
  _prev: UpdateSessionPolicyState,
  _form: FormData,
): Promise<UpdateSessionPolicyState> {
  try {
    await terminateAllSessions();
    revalidatePath(ADMIN_PATH);
    return {
      ok: true,
      successMessage:
        'Все сеансы завершены. Сотрудникам нужно войти заново — включая вас.',
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Автозавершение смен
// ---------------------------------------------------------------------------

/**
 * Сохраняет правило автозавершения смен: время суток, предельную
 * длительность и то, чем считать конец смены.
 *
 * Три поля одной формой сознательно: по отдельности они не значат
 * ничего. Порог без режима не отвечает на вопрос «сколько часов
 * записать», а режим без порога вообще не применяется.
 */
export async function updateShiftAutoCloseAction(
  _prev: UpdateShiftAutoCloseState,
  form: FormData,
): Promise<UpdateShiftAutoCloseState> {
  const rawTime = String(form.get('shiftAutoCloseTime') ?? '').trim();
  if (rawTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime)) {
    return { error: 'Время завершения — в формате ЧЧ:ММ' };
  }
  const hours = Number.parseInt(
    String(form.get('shiftMaxDurationHours') ?? ''),
    10,
  );
  if (
    !Number.isFinite(hours) ||
    !SHIFT_MAX_DURATION_PRESETS.includes(
      hours as (typeof SHIFT_MAX_DURATION_PRESETS)[number],
    )
  ) {
    return { error: 'Не выбрана предельная длительность смены' };
  }
  const rawMode = String(form.get('shiftAutoCloseMode') ?? '');
  const mode = SHIFT_AUTO_CLOSE_MODES.find((m) => m === rawMode);
  if (!mode) return { error: 'Не выбрано, чем считать конец смены' };

  try {
    await updateCompanySettings({
      shiftAutoCloseTime: rawTime === '' ? null : rawTime,
      shiftMaxDurationHours: hours,
      shiftAutoCloseMode: mode,
    });
    revalidatePath(ADMIN_PATH);
    return {
      ok: true,
      successMessage:
        !rawTime && hours === 0
          ? 'Автозавершение выключено: смены закрываются только вручную.'
          : 'Правило автозавершения смен сохранено.',
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
