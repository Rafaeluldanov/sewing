/**
 * Контракты модуля «Настройки компании» (singleton-настройки
 * организации, добавлено вместе с UI `/admin/company-settings`).
 *
 * Дизайн сознательно простой:
 *   - singleton-таблица: один заказчик — один набор реквизитов;
 *   - все поля опциональны (`null` = «не задано»), формат
 *     юридических полей валидируется Zod-ом, а не БД;
 *   - в форме не делаем «сохранить только секцию»: PATCH принимает
 *     любое подмножество полей, остальные не трогает (как у
 *     `UpdateClientSchema` / `UpdateEmployeeSchema`);
 *   - empty-string preprocess → `null` (как в `clients.ts`), чтобы
 *     веб-форма могла слать пустые `<input>` без явных `null`.
 *
 * Источник истины — backend (`CompanySettingsService` + контроллер).
 * UI и server actions используют те же схемы для валидации.
 *
 * Связанные файлы:
 *   - `prisma/schema.prisma::CompanySettings`
 *   - `apps/api/src/modules/company-settings/*`
 *   - `apps/web/lib/company-settings-api.ts`
 *   - `apps/web/app/admin/company-settings/*`
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants (длины полей)
// ---------------------------------------------------------------------------

export const COMPANY_SETTINGS_NAME_MAX_LENGTH = 300;
export const COMPANY_SETTINGS_SHORT_NAME_MAX_LENGTH = 120;
export const COMPANY_SETTINGS_PREFIX_MAX_LENGTH = 16;
export const COMPANY_SETTINGS_ADDRESS_MAX_LENGTH = 500;
export const COMPANY_SETTINGS_PHONE_MAX_LENGTH = 64;
export const COMPANY_SETTINGS_EMAIL_MAX_LENGTH = 200;
export const COMPANY_SETTINGS_PERSON_MAX_LENGTH = 200;
export const COMPANY_SETTINGS_BANK_NAME_MAX_LENGTH = 300;

/**
 * Стабильный `id` единственной строки `CompanySettings`. Совпадает с
 * `@id @default("default")` в Prisma-схеме — фронт никогда не работает
 * с другими id, а backend идемпотентно создаёт строку с этим id, если
 * её ещё нет.
 */
export const COMPANY_SETTINGS_SINGLETON_ID = 'default';

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

/**
 * Optional строковое поле, которое:
 *   - принимает пустую строку как «не задано» → возвращает `null`;
 *   - триммит пробелы;
 *   - проверяет длину.
 *
 * Полный аналог `optionalNullableString` в `clients.ts`. Дублируем,
 * чтобы не плодить cross-module зависимости в shared (clients и
 * company-settings — разные блоки админки, общий хелпер вынесем
 * только если появятся ещё кейсы).
 */
function optionalNullableString(maxLength: number, label: string) {
  return z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(maxLength, `${label} не длиннее ${maxLength} символов`)
      .nullable()
      .optional(),
  );
}

/**
 * Optional строка, проходящая дополнительную regex-валидацию (только
 * на непустых значениях). Пустая строка → `null` без regex-проверки —
 * иначе менеджер не сможет «снять» некорректно введённый ИНН.
 */
function optionalDigitsField(opts: {
  digits: number | number[];
  label: string;
}) {
  const lengths = Array.isArray(opts.digits) ? opts.digits : [opts.digits];
  const maxLen = Math.max(...lengths);
  const re = new RegExp(`^\\d{${lengths.join('}|\\d{')}}$`);
  const lenLabel = lengths.length === 1
    ? `${lengths[0]} цифр`
    : `${lengths.join(' или ')} цифр`;
  return z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(maxLen + 8, `${opts.label} слишком длинный`)
      .regex(re, `${opts.label} — должен содержать ${lenLabel}`)
      .nullable()
      .optional(),
  );
}

const LegalNameField = optionalNullableString(
  COMPANY_SETTINGS_NAME_MAX_LENGTH,
  'Полное название',
);
const ShortNameField = optionalNullableString(
  COMPANY_SETTINGS_SHORT_NAME_MAX_LENGTH,
  'Краткое название',
);
const PrefixField = optionalNullableString(
  COMPANY_SETTINGS_PREFIX_MAX_LENGTH,
  'Префикс',
);

/** ИНН: 10 (юрлица) или 12 цифр (ИП). */
const InnField = optionalDigitsField({ digits: [10, 12], label: 'ИНН' });
/** КПП: 9 цифр (только для юрлиц; пусто допустимо, в т.ч. для ИП). */
const KppField = optionalDigitsField({ digits: 9, label: 'КПП' });
/** ОГРН/ОГРНИП: 13 или 15 цифр. */
const OgrnField = optionalDigitsField({ digits: [13, 15], label: 'ОГРН' });

const LegalAddressField = optionalNullableString(
  COMPANY_SETTINGS_ADDRESS_MAX_LENGTH,
  'Юридический адрес',
);
const ActualAddressField = optionalNullableString(
  COMPANY_SETTINGS_ADDRESS_MAX_LENGTH,
  'Фактический адрес',
);

const PhoneField = optionalNullableString(
  COMPANY_SETTINGS_PHONE_MAX_LENGTH,
  'Телефон',
);

/**
 * Email — опциональный, но если задан, должен быть валидным. Пустая
 * строка трактуется как `null` (та же мягкая семантика, что в
 * `clients.ts::EmailField`).
 */
const EmailField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .email('Некорректный email')
    .max(
      COMPANY_SETTINGS_EMAIL_MAX_LENGTH,
      `Email не длиннее ${COMPANY_SETTINGS_EMAIL_MAX_LENGTH} символов`,
    )
    .nullable()
    .optional(),
);

const DirectorNameField = optionalNullableString(
  COMPANY_SETTINGS_PERSON_MAX_LENGTH,
  'ФИО руководителя',
);
const AccountantNameField = optionalNullableString(
  COMPANY_SETTINGS_PERSON_MAX_LENGTH,
  'ФИО главного бухгалтера',
);

const BankNameField = optionalNullableString(
  COMPANY_SETTINGS_BANK_NAME_MAX_LENGTH,
  'Название банка',
);
const BikField = optionalDigitsField({ digits: 9, label: 'БИК' });
const SettlementAccountField = optionalDigitsField({
  digits: 20,
  label: 'Расчётный счёт',
});
const CorrespondentAccountField = optionalDigitsField({
  digits: 20,
  label: 'Корреспондентский счёт',
});

/**
 * Boolean-флаги блока «Материалы и склад». На уровне Zod — просто
 * `z.boolean().optional()`: `undefined` ⇒ backend поле не трогает,
 * `true/false` ⇒ применяет значение. Дефолты лежат в Prisma
 * (`autoIssueMaterialsOnCutRelease @default(false)`,
 * `allowNegativeMaterialStock @default(true)`) и читаются backend-ом
 * через приватные геттеры при отсутствии singleton-строки — здесь их
 * не дублируем, чтобы не было двух источников истины.
 */
const AutoIssueMaterialsOnCutReleaseField = z.boolean().optional();
const AllowNegativeMaterialStockField = z.boolean().optional();

/**
 * Строгость гейта «работа мимо маршрута». Три состояния, поэтому в UI
 * это выпадающий список, а не тумблер — у тумблера третьего состояния
 * нет (тот же аргумент, что в секции division-overrides).
 */
export const OFF_ROUTE_WORK_POLICIES = ['OFF', 'WARN', 'BLOCK'] as const;
export type OffRouteWorkPolicyValue = (typeof OFF_ROUTE_WORK_POLICIES)[number];
export const OFF_ROUTE_WORK_POLICY_LABELS: Record<
  OffRouteWorkPolicyValue,
  string
> = {
  OFF: 'Выключено',
  WARN: 'Предупреждать',
  BLOCK: 'Блокировать',
};
const OffRouteWorkPolicyField = z.enum(OFF_ROUTE_WORK_POLICIES).optional();

// ---------------------------------------------------------------------------
// Автовыход по бездействию
// ---------------------------------------------------------------------------

/** `0` — автовыход выключен (сессия живёт `JWT_EXPIRES_IN`, как раньше). */
export const SESSION_IDLE_TIMEOUT_DISABLED = 0;
/**
 * Нижняя граница окна. Меньше пяти минут — это уже не «забыл выйти», а
 * выкидывание человека, который читает экран: швея на ОТК разбирает
 * партию молча по несколько минут.
 */
export const SESSION_IDLE_TIMEOUT_MIN_MINUTES = 5;
/** Верхняя граница — 12 часов, дальше настройка теряет смысл (это уже TTL сессии). */
export const SESSION_IDLE_TIMEOUT_MAX_MINUTES = 720;

/**
 * Готовые варианты для выпадающего списка в настройках. Свободный ввод
 * минут здесь ни к чему: значимых режимов немного, а список избавляет
 * от вопроса «а 7 минут — это нормально?».
 */
export const SESSION_IDLE_TIMEOUT_PRESETS = [
  SESSION_IDLE_TIMEOUT_DISABLED,
  15,
  30,
  60,
  120,
  240,
  480,
] as const;

/** Подпись пресета в списке. `0` — «не выходить». */
export function sessionIdleTimeoutLabel(minutes: number): string {
  if (minutes <= SESSION_IDLE_TIMEOUT_DISABLED) return 'Не выходить';
  if (minutes < 60) return `${minutes} минут бездействия`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    const word = hours === 1 ? 'час' : hours < 5 ? 'часа' : 'часов';
    return `${hours} ${word} бездействия`;
  }
  return `${minutes} минут бездействия`;
}

/**
 * Окно бездействия в минутах. `0` — выключено; иначе минимум
 * `SESSION_IDLE_TIMEOUT_MIN_MINUTES`. Пустая строка из формы
 * трактуется как «не менять» (`undefined`), а не как ноль — иначе
 * случайно очищенное поле молча выключало бы автовыход.
 */
const SessionIdleTimeoutMinutesField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') return undefined;
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isFinite(parsed) ? parsed : v;
    }
    return v;
  },
  z
    .number({ invalid_type_error: 'Время бездействия — число минут' })
    .int('Время бездействия — целое число минут')
    .refine(
      (n) =>
        n === SESSION_IDLE_TIMEOUT_DISABLED ||
        (n >= SESSION_IDLE_TIMEOUT_MIN_MINUTES &&
          n <= SESSION_IDLE_TIMEOUT_MAX_MINUTES),
      `Время бездействия — 0 (не выходить) или от ${SESSION_IDLE_TIMEOUT_MIN_MINUTES} до ${SESSION_IDLE_TIMEOUT_MAX_MINUTES} минут`,
    )
    .optional(),
);

// ---------------------------------------------------------------------------
// Автозавершение смен
// ---------------------------------------------------------------------------

/**
 * Чем считать конец смены, которую забыли закрыть.
 *
 * `LAST_ACTIVITY` — по последней отметке сотрудника в этой смене
 * (событие паспорта, переключение операции). Ради него фича и нужна:
 * иначе в часы попадают вечер и ночь, когда в цехе никого не было.
 * `AT_DEADLINE` — по самому порогу; предсказуемо, но щедро.
 */
export const SHIFT_AUTO_CLOSE_MODES = ['LAST_ACTIVITY', 'AT_DEADLINE'] as const;
export type ShiftAutoCloseModeValue = (typeof SHIFT_AUTO_CLOSE_MODES)[number];
export const SHIFT_AUTO_CLOSE_MODE_LABELS: Record<
  ShiftAutoCloseModeValue,
  string
> = {
  LAST_ACTIVITY: 'По последней отметке сотрудника',
  AT_DEADLINE: 'По времени завершения',
};

/** `0` — предельная длительность смены не ограничена. */
export const SHIFT_MAX_DURATION_DISABLED = 0;
/**
 * Меньше 4 часов — это уже не «забыл закрыть», а разрезание нормальной
 * смены пополам.
 */
export const SHIFT_MAX_DURATION_MIN_HOURS = 4;
/** Больше трёх суток смысла нет: такую смену всё равно закроет порог по времени. */
export const SHIFT_MAX_DURATION_MAX_HOURS = 72;

/** Готовые варианты предельной длительности для списка в настройках. */
export const SHIFT_MAX_DURATION_PRESETS = [
  SHIFT_MAX_DURATION_DISABLED,
  8,
  10,
  12,
  16,
  24,
] as const;

/** Подпись пресета длительности. `0` — «без ограничения». */
export function shiftMaxDurationLabel(hours: number): string {
  if (hours <= SHIFT_MAX_DURATION_DISABLED) return 'Без ограничения';
  const word = hours === 1 ? 'час' : hours < 5 ? 'часа' : 'часов';
  return `${hours} ${word} подряд`;
}

/** `HH:MM` в минутах от полуночи; `null` для пустого значения. */
export function parseShiftAutoCloseTime(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number.parseInt(m[1]!, 10);
  const minutes = Number.parseInt(m[2]!, 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Время автозавершения `"HH:MM"` (по Москве) или `null` — выключено.
 * Пустая строка из формы = `null`: так владелец может выключить
 * правило, не выбирая «специальное» значение.
 */
const ShiftAutoCloseTimeField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время завершения — в формате ЧЧ:ММ')
    .nullable()
    .optional(),
);

/** Предельная длительность смены в часах; `0` — без ограничения. */
const ShiftMaxDurationHoursField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') return undefined;
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isFinite(parsed) ? parsed : v;
    }
    return v;
  },
  z
    .number({ invalid_type_error: 'Длительность смены — число часов' })
    .int('Длительность смены — целое число часов')
    .refine(
      (n) =>
        n === SHIFT_MAX_DURATION_DISABLED ||
        (n >= SHIFT_MAX_DURATION_MIN_HOURS &&
          n <= SHIFT_MAX_DURATION_MAX_HOURS),
      `Длительность смены — 0 (без ограничения) или от ${SHIFT_MAX_DURATION_MIN_HOURS} до ${SHIFT_MAX_DURATION_MAX_HOURS} часов`,
    )
    .optional(),
);

const ShiftAutoCloseModeField = z.enum(SHIFT_AUTO_CLOSE_MODES).optional();

// ---------------------------------------------------------------------------
// Update DTO
// ---------------------------------------------------------------------------

export const UpdateCompanySettingsSchema = z
  .object({
    legalName: LegalNameField,
    shortName: ShortNameField,
    prefix: PrefixField,
    inn: InnField,
    kpp: KppField,
    ogrn: OgrnField,
    legalAddress: LegalAddressField,
    actualAddress: ActualAddressField,
    phone: PhoneField,
    email: EmailField,
    directorName: DirectorNameField,
    accountantName: AccountantNameField,
    bankName: BankNameField,
    bik: BikField,
    correspondentAccount: CorrespondentAccountField,
    settlementAccount: SettlementAccountField,
    autoIssueMaterialsOnCutRelease: AutoIssueMaterialsOnCutReleaseField,
    allowNegativeMaterialStock: AllowNegativeMaterialStockField,
    offRouteWorkPolicy: OffRouteWorkPolicyField,
    sessionIdleTimeoutMinutes: SessionIdleTimeoutMinutesField,
    shiftAutoCloseTime: ShiftAutoCloseTimeField,
    shiftMaxDurationHours: ShiftMaxDurationHoursField,
    shiftAutoCloseMode: ShiftAutoCloseModeField,
  })
  .refine(
    (obj) => Object.values(obj).some((v) => v !== undefined),
    'Нечего обновлять: укажите хотя бы одно поле',
  );

export type UpdateCompanySettingsDto = z.infer<
  typeof UpdateCompanySettingsSchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface CompanySettingsDto {
  id: string;
  legalName: string | null;
  shortName: string | null;
  prefix: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  actualAddress: string | null;
  phone: string | null;
  email: string | null;
  directorName: string | null;
  accountantName: string | null;
  bankName: string | null;
  bik: string | null;
  correspondentAccount: string | null;
  settlementAccount: string | null;
  /**
   * Строгость гейта «работа мимо маршрута»
   * (`prisma/schema.prisma::CompanySettings.offRouteWorkPolicy`).
   * Если singleton-строки ещё нет — backend отдаёт `WARN`, как SQL-default.
   */
  offRouteWorkPolicy: OffRouteWorkPolicyValue;
  /**
   * Блок «Материалы и склад» / UI `/admin/company-settings`.
   * Если singleton-строки ещё нет, backend отдаёт дефолт
   * (см. `CompanySettingsService.get` fallback):
   *   - `autoIssueMaterialsOnCutRelease = false`
   *   - `allowNegativeMaterialStock    = true`.
   */
  autoIssueMaterialsOnCutRelease: boolean;
  allowNegativeMaterialStock: boolean;
  /**
   * Автовыход по бездействию, минуты (`0` — выключен). См.
   * `prisma/schema.prisma::CompanySettings.sessionIdleTimeoutMinutes`.
   */
  sessionIdleTimeoutMinutes: number;
  /**
   * Автозавершение смен: время суток по Москве (`"HH:MM"`) или `null`
   * — выключено. См.
   * `prisma/schema.prisma::CompanySettings.shiftAutoCloseTime`.
   */
  shiftAutoCloseTime: string | null;
  /** Предельная длительность смены, часов; `0` — без ограничения. */
  shiftMaxDurationHours: number;
  /** Чем считать конец автозакрытой смены. */
  shiftAutoCloseMode: ShiftAutoCloseModeValue;
  /**
   * Момент последнего «Завершить все сеансы» (ISO) или `null`. Сессии,
   * выпущенные раньше, backend отвергает. Поле read-only: сдвинуть
   * метку можно только ручкой `POST /company-settings/terminate-sessions`.
   */
  sessionsValidFrom: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/**
 * Ответ `POST /api/company-settings/terminate-sessions` — новая метка
 * отсечки. Всё, что выпущено раньше неё, перестаёт пускать в систему,
 * включая сессию того, кто нажал кнопку.
 */
export interface TerminateSessionsResponseDto {
  sessionsValidFrom: string; // ISO
}

// ---------------------------------------------------------------------------
// Готовность к включению блокировки
// ---------------------------------------------------------------------------

/**
 * Сводка «можно ли включать `BLOCK`» для секции настроек.
 *
 * Зачем отдельная read-модель. Голый выпадающий список здесь — ловушка:
 * переключение в «Блокировать» с неразобранными шаблонами останавливает
 * цех, а остановка заканчивается требованием выключить проверку
 * насовсем. Весь смысл режима «Предупреждать» в том, чтобы решение
 * принималось ПО ЦИФРАМ — а цифры лежат в `AuditLog` и никому не видны.
 * Поэтому секция показывает, сколько раз гейт сработал и что мешает.
 *
 * Блокеры НЕ запрещают переключение (решение владельца 29.07.2026):
 * жёсткий запрет в настройках раздражает больше, чем помогает, а
 * владелец может знать контекст, которого система не видит — например,
 * что шаблон всё равно не будет использоваться.
 */
export interface OffRouteReadinessDto {
  /** Сколько раз гейт сработал за окно (событие `PASSPORT_WORK_OUTSIDE_ROUTE`). */
  incidentsInWindow: number;
  windowDays: number;
  /** ISO последнего срабатывания или `null`. */
  lastIncidentAt: string | null;
  /** Заказы, которые не смогут стартовать (архивная швейная операция в шаблоне). */
  ordersBlockedFromStart: number;
  /** Активные шаблоны с архивной швейной операцией — их и надо разобрать. */
  templatesWithArchivedSewing: {
    code: string;
    name: string;
    operations: string[];
  }[];
}
