/**
 * Контракты модуля «Категории номенклатуры» (этап
 * `Pattern Categories`).
 *
 * Связано с:
 *   - `prisma/schema.prisma` (`model PatternCategory`,
 *     `model PatternCategoryParameter`, `model PatternItem.categoryId`);
 *   - `apps/api/src/modules/pattern-categories/*` — REST endpoints;
 *   - `apps/web/app/admin/patterns/*` — UI каталога и карточки лекала
 *     (фильтр по категориям, модалка «Добавить категорию», таблица
 *     «Площади материалов» по параметрам категории);
 *   - `apps/api/src/modules/patterns/patterns.service.ts` —
 *     валидация `materialRole` против активных параметров категории.
 *
 * Дизайн:
 *   - категория хранит список параметров; параметр = (roleKey, label,
 *     inputType, unit, ...). На таблицу «Площади материалов»
 *     попадают только параметры с `inputType = AREA_M2_BY_SIZE`;
 *   - `roleKey` 1:1 маппится на `PatternMaterialArea.materialRole`,
 *     поэтому остальные модули (`MATERIAL_ROLES` glo­бальный) не
 *     ломаются: если у лекала есть `categoryId`, бэкенд принимает
 *     только `roleKey` параметров категории; если нет — fallback
 *     на глобальный `MATERIAL_ROLES`;
 *   - hard-delete категории нет: API делает soft-archive
 *     (`status = ARCHIVED`), параметры пересохраняются bulk-replace
 *     `PUT /api/pattern-categories/:id/parameters`.
 *
 * Zod-схемы здесь — источник истины для валидации входа на API
 * (`ZodValidationPipe`) и форм клиента
 * (`apps/web/app/admin/patterns/*`).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants / whitelists
// ---------------------------------------------------------------------------

/**
 * Известные статусы категории. БД хранит свободную строку с дефолтом
 * `ACTIVE` (см. `model PatternCategory.status`), поэтому список можно
 * расширять без миграции.
 */
export const PATTERN_CATEGORY_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export const PatternCategoryStatusSchema = z.enum(PATTERN_CATEGORY_STATUSES);
export type PatternCategoryStatus = z.infer<typeof PatternCategoryStatusSchema>;

export const PATTERN_CATEGORY_STATUS_LABELS: Record<
  PatternCategoryStatus,
  string
> = {
  ACTIVE: 'Активна',
  ARCHIVED: 'Архив',
};

/** Статусы параметра категории (см. `model PatternCategoryParameter.status`). */
export const PATTERN_CATEGORY_PARAMETER_STATUSES = [
  'ACTIVE',
  'ARCHIVED',
] as const;
export const PatternCategoryParameterStatusSchema = z.enum(
  PATTERN_CATEGORY_PARAMETER_STATUSES,
);
export type PatternCategoryParameterStatus = z.infer<
  typeof PatternCategoryParameterStatusSchema
>;

/**
 * Тип ввода параметра категории.
 *
 * - `AREA_M2_BY_SIZE`   — площадь м² по размерам, хранится в
 *   `PatternMaterialArea` (см. `prisma/schema.prisma`);
 * - `LINEAR_M_BY_SIZE`  — погонные метры по размерам, хранятся в
 *   отдельной таблице `PatternItemSizeParameterValue` (этап
 *   «Погонные метры по размерам»). PatternMaterialArea для них
 *   НЕ используется — там семантика про areaM2;
 * - `QTY_PER_ITEM`      — количество на изделие, хранится в
 *   `PatternItemParameterNorm`;
 * - `TEXT_ONLY`         — описание / услуга, без расчёта.
 *
 * Поле `inputType` в Prisma — String, расширение списка не требует
 * миграции БД.
 */
export const PATTERN_CATEGORY_PARAMETER_INPUT_TYPES = [
  'AREA_M2_BY_SIZE',
  'LINEAR_M_BY_SIZE',
  'QTY_PER_ITEM',
  'TEXT_ONLY',
] as const;
export const PatternCategoryParameterInputTypeSchema = z.enum(
  PATTERN_CATEGORY_PARAMETER_INPUT_TYPES,
);
export type PatternCategoryParameterInputType = z.infer<
  typeof PatternCategoryParameterInputTypeSchema
>;

export const PATTERN_CATEGORY_PARAMETER_INPUT_TYPE_LABELS: Record<
  PatternCategoryParameterInputType,
  string
> = {
  AREA_M2_BY_SIZE: 'Площадь по размерам',
  LINEAR_M_BY_SIZE: 'Погонные метры по размерам',
  QTY_PER_ITEM: 'Количество на изделие',
  TEXT_ONLY: 'Описание / услуга',
};

/**
 * Единица ввода (то, что технолог пишет в карточке номенклатуры),
 * привязанная к `inputType`. Это НЕ единица потребности — её
 * пользователь задаёт отдельно полем «Единица потребности» (см.
 * `PatternCategoryParameter.unit`). Единица ввода — это просто
 * подсказка UI в шапке колонки таблицы значений: «здесь вводят
 * м пог.», «здесь — м²», «здесь — на изделие».
 *
 * Возвращаем `null` для `TEXT_ONLY` — там единица не нужна,
 * параметр текстовый.
 */
export function getPatternCategoryInputUnitLabel(
  inputType: PatternCategoryParameterInputType | string,
): string | null {
  switch (inputType) {
    case 'AREA_M2_BY_SIZE':
      return 'м²';
    case 'LINEAR_M_BY_SIZE':
      return 'м пог.';
    case 'QTY_PER_ITEM':
      return 'на изделие';
    case 'TEXT_ONLY':
      return null;
    default:
      return null;
  }
}

/**
 * Человекочитаемое объяснение, что именно технолог будет вводить в
 * карточке номенклатуры для данного `inputType`. Используется как
 * подсказка под select «Ввод в номенклатуре» в формах категории.
 */
export function getPatternCategoryInputTypeExplanation(
  inputType: PatternCategoryParameterInputType | string,
): string {
  switch (inputType) {
    case 'AREA_M2_BY_SIZE':
      return 'В карточке номенклатуры указывается площадь в м² по каждому размеру.';
    case 'LINEAR_M_BY_SIZE':
      return 'В карточке номенклатуры указывается расход в погонных метрах по каждому размеру.';
    case 'QTY_PER_ITEM':
      return 'В карточке номенклатуры указывается количество на одно изделие.';
    case 'TEXT_ONLY':
      return 'Текстовое описание или услуга.';
    default:
      return '';
  }
}

/**
 * Whitelist ключей иконок lucide для UI категории. Хранение строкой
 * сознательно — в случае добавления новой иконки достаточно
 * расширить whitelist здесь и обновить мапинг в UI; миграции схемы
 * не требуются.
 */
export const PATTERN_CATEGORY_ICON_KEYS = [
  'SHIRT',
  'HOODIE',
  'PANTS',
  'SHORTS',
  'DRESS',
  'CAP',
  'PACKAGE',
  'SCISSORS',
  'TAG',
  'STAR',
] as const;
export const PatternCategoryIconKeySchema = z.enum(PATTERN_CATEGORY_ICON_KEYS);
export type PatternCategoryIconKey = z.infer<
  typeof PatternCategoryIconKeySchema
>;

export const PATTERN_CATEGORY_ICON_KEY_LABELS: Record<
  PatternCategoryIconKey,
  string
> = {
  SHIRT: 'Футболка',
  HOODIE: 'Худи',
  PANTS: 'Брюки',
  SHORTS: 'Шорты',
  DRESS: 'Платье',
  CAP: 'Кепка',
  PACKAGE: 'Упаковка',
  SCISSORS: 'Ножницы',
  TAG: 'Бирка',
  STAR: 'Звезда',
};

/** Дефолтные единицы измерения по типу ввода. UI использует как hint. */
export const PATTERN_CATEGORY_PARAMETER_DEFAULT_UNITS: Record<
  PatternCategoryParameterInputType,
  string
> = {
  AREA_M2_BY_SIZE: 'м²',
  LINEAR_M_BY_SIZE: 'м пог.',
  QTY_PER_ITEM: 'шт',
  TEXT_ONLY: '',
};

// ---------------------------------------------------------------------------
// Parameter groups (этап «Доработка параметров категорий номенклатуры»)
//
// Группы параметров — управленческий список «что бывает в категории
// швейного изделия». Это надстройка поверх `roleKey` параметра
// (поле `PatternCategoryParameter.roleKey` в БД остаётся свободной
// строкой uppercase-snake-case). Менеджер не видит roleKey:
//   - он выбирает группу параметра из понятного списка
//     («Основное полотно», «Рибана / кашкорсе», «Фурнитура»,
//     «Маркировка», …);
//   - UI подставляет соответствующий roleKey в скрытое поле формы,
//     ограничивает «Ввод в номенклатуре» допустимыми `inputType`-ами
//     группы и предлагает дефолтную единицу потребности.
//
// Семантика двух полей в карточке параметра:
//   - «Ввод в номенклатуре» (`inputType`) — то, ЧТО технолог будет
//     указывать в карточке номенклатуры / лекала: «погонные метры
//     по размерам», «площадь по размерам», «количество на изделие»;
//   - «Единица потребности» (`unit`) — НЕ единица ввода, а единица,
//     в которой материал должен попасть в «Потребность цеха»: «кг»,
//     «м пог.», «м²», «шт», «м». Например, технолог вводит
//     0.85 м пог. на изделие, а в «Потребность цеха» строка
//     попадает уже как X кг — пересчёт делает
//     `WorkshopNeedsService` через ширину/плотность из техкарты.
//
// Технические ключи `MAIN_FABRIC` / `PACKAGING` / `MARKING` — те же
// значения, что и в `material-roles.ts` (re-exported в техкарты),
// плюс расширения, специфичные только для категорий номенклатуры
// (`ADDITIONAL_FABRIC`, `INTERLINING`, `FILLER`). `PACKAGING`
// сознательно остаётся техническим ключом для фурнитуры —
// пользователь видит «Фурнитура», а слово «Упаковка» в UI больше
// не появляется (см. ТЗ §1 «Не показывать пользователю Упаковка»).
//
// MATERIAL_ROLES для техкарты НЕ меняется (см. ТЗ §«Не менять
// MATERIAL_ROLES техкарты»). Эти группы относятся к категориям
// номенклатуры — в техкарте по-прежнему используется глобальный
// `MATERIAL_ROLES` whitelist.
// ---------------------------------------------------------------------------

export interface PatternCategoryParameterGroupConfig {
  /** Технический roleKey, который пишется в `PatternCategoryParameter.roleKey`. */
  roleKey: string;
  /** Пользовательский лейбл группы (видим в UI). */
  label: string;
  /**
   * Допустимые единицы потребности для этой группы. Это единицы,
   * в которых строка попадёт в «Потребность цеха» — НЕ единицы
   * ввода. Для LINEAR_M_BY_SIZE групп тут может быть и «кг», и
   * «м²», и «м пог.» — пересчёт сделает backend через ширину и
   * плотность из техкарты.
   */
  allowedUnits: readonly string[];
  /** Единица потребности, которую UI подставляет по умолчанию. */
  defaultUnit: string;
  /** Допустимые типы ввода («Ввод в номенклатуре») для этой группы. */
  allowedInputTypes: readonly PatternCategoryParameterInputType[];
  /** Тип ввода, который UI подставляет по умолчанию. */
  defaultInputType: PatternCategoryParameterInputType;
}

export const PATTERN_CATEGORY_PARAMETER_GROUPS: readonly PatternCategoryParameterGroupConfig[] = [
  {
    // Основное полотно: типичный сценарий — технолог вводит расход
    // в м пог., в потребность строка попадает в кг (пересчёт через
    // ширину рулона и плотность материала из техкарты). По
    // желанию менеджер может оставить «м пог.» / «м²».
    roleKey: 'MAIN_FABRIC',
    label: 'Основное полотно',
    allowedUnits: ['кг', 'м пог.', 'м²'],
    defaultUnit: 'кг',
    allowedInputTypes: ['LINEAR_M_BY_SIZE', 'AREA_M2_BY_SIZE'],
    defaultInputType: 'LINEAR_M_BY_SIZE',
  },
  {
    // Дополнительное полотно: по умолчанию закупаем в м пог.,
    // конверсия в кг доступна по требованию (если в техкарте
    // указаны ширина и плотность).
    roleKey: 'ADDITIONAL_FABRIC',
    label: 'Дополнительное полотно',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    defaultUnit: 'м пог.',
    allowedInputTypes: ['LINEAR_M_BY_SIZE', 'AREA_M2_BY_SIZE'],
    defaultInputType: 'LINEAR_M_BY_SIZE',
  },
  {
    // Рибана/кашкорсе: трикотаж, в потребность чаще всего нужно в кг.
    roleKey: 'RIB',
    label: 'Рибана / кашкорсе',
    allowedUnits: ['кг', 'м пог.', 'м²'],
    defaultUnit: 'кг',
    allowedInputTypes: ['LINEAR_M_BY_SIZE', 'AREA_M2_BY_SIZE'],
    defaultInputType: 'LINEAR_M_BY_SIZE',
  },
  {
    roleKey: 'LINING',
    label: 'Подкладка',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    defaultUnit: 'м пог.',
    allowedInputTypes: ['LINEAR_M_BY_SIZE', 'AREA_M2_BY_SIZE'],
    defaultInputType: 'LINEAR_M_BY_SIZE',
  },
  {
    roleKey: 'FILLER',
    label: 'Наполнитель',
    allowedUnits: ['г/м²', 'кг'],
    defaultUnit: 'г/м²',
    allowedInputTypes: ['TEXT_ONLY', 'QTY_PER_ITEM'],
    defaultInputType: 'TEXT_ONLY',
  },
  {
    roleKey: 'INTERLINING',
    label: 'Дублерин / клеевые',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    defaultUnit: 'м пог.',
    allowedInputTypes: ['LINEAR_M_BY_SIZE', 'AREA_M2_BY_SIZE'],
    defaultInputType: 'LINEAR_M_BY_SIZE',
  },
  {
    roleKey: 'THREAD',
    label: 'Нитки',
    allowedUnits: ['м'],
    defaultUnit: 'м',
    allowedInputTypes: ['QTY_PER_ITEM'],
    defaultInputType: 'QTY_PER_ITEM',
  },
  {
    // PACKAGING остаётся техническим ключом для фурнитуры. UI
    // показывает «Фурнитура», слово «Упаковка» пользователю не видно.
    roleKey: 'PACKAGING',
    label: 'Фурнитура',
    allowedUnits: ['шт', 'м'],
    defaultUnit: 'шт',
    allowedInputTypes: ['QTY_PER_ITEM'],
    defaultInputType: 'QTY_PER_ITEM',
  },
  {
    roleKey: 'MARKING',
    label: 'Маркировка',
    allowedUnits: ['шт'],
    defaultUnit: 'шт',
    allowedInputTypes: ['QTY_PER_ITEM'],
    defaultInputType: 'QTY_PER_ITEM',
  },
] as const;

const GROUP_BY_ROLE_KEY = new Map<string, PatternCategoryParameterGroupConfig>(
  PATTERN_CATEGORY_PARAMETER_GROUPS.map((g) => [g.roleKey, g] as const),
);

/**
 * Найти конфиг группы параметров по техническому `roleKey`.
 * Если roleKey не описан в `PATTERN_CATEGORY_PARAMETER_GROUPS`
 * (custom-roleKey, сохранённый раньше или вручную через API),
 * возвращает `null` — UI отрисует строку как fallback (custom group).
 */
export function getPatternCategoryParameterGroupConfig(
  roleKey: string,
): PatternCategoryParameterGroupConfig | null {
  return GROUP_BY_ROLE_KEY.get(roleKey) ?? null;
}

/**
 * Пользовательский лейбл группы параметров. Если roleKey не из
 * whitelist, возвращает сам roleKey (на UI он редко виден, но
 * fallback нужен для исторических данных).
 */
export function getPatternCategoryParameterGroupLabel(roleKey: string): string {
  return getPatternCategoryParameterGroupConfig(roleKey)?.label ?? roleKey;
}

/**
 * Допустимые единицы измерения для группы. Если roleKey неизвестен,
 * возвращает дефолтные единицы по `inputType` (через единый whitelist
 * `PATTERN_CATEGORY_PARAMETER_DEFAULT_UNITS`).
 */
export function getAllowedUnitsForParameterGroup(
  roleKey: string,
): readonly string[] {
  const config = getPatternCategoryParameterGroupConfig(roleKey);
  if (config) return config.allowedUnits;
  // Fallback: для неизвестной группы — самый широкий whitelist
  // (все дефолтные единицы по типам ввода).
  return Object.values(PATTERN_CATEGORY_PARAMETER_DEFAULT_UNITS).filter(
    (u) => u !== '',
  );
}

/**
 * Дефолтная единица измерения для группы. Если roleKey неизвестен,
 * возвращает `''` — UI оставит unit пустым.
 */
export function getDefaultUnitForParameterGroup(roleKey: string): string {
  return getPatternCategoryParameterGroupConfig(roleKey)?.defaultUnit ?? '';
}

/**
 * Дефолтный `inputType` для группы. Если roleKey неизвестен,
 * возвращает `'TEXT_ONLY'` как наиболее безопасный fallback.
 */
export function getDefaultInputTypeForParameterGroup(
  roleKey: string,
): PatternCategoryParameterInputType {
  return (
    getPatternCategoryParameterGroupConfig(roleKey)?.defaultInputType ??
    'TEXT_ONLY'
  );
}

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const PATTERN_CATEGORY_NAME_MAX_LENGTH = 100;
export const PATTERN_CATEGORY_SLUG_MAX_LENGTH = 80;
export const PATTERN_CATEGORY_DESCRIPTION_MAX_LENGTH = 500;
export const PATTERN_CATEGORY_PARAMETER_LABEL_MAX_LENGTH = 100;
export const PATTERN_CATEGORY_PARAMETER_ROLE_KEY_MAX_LENGTH = 64;
export const PATTERN_CATEGORY_PARAMETER_UNIT_MAX_LENGTH = 16;
export const PATTERN_CATEGORY_PARAMETER_DESCRIPTION_MAX_LENGTH = 500;
export const PATTERN_CATEGORY_PARAMETERS_MAX = 50;

const NameRequiredField = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(
    PATTERN_CATEGORY_NAME_MAX_LENGTH,
    `Название не длиннее ${PATTERN_CATEGORY_NAME_MAX_LENGTH} символов`,
  );

const NameOptionalField = z
  .string()
  .trim()
  .min(1, 'Название не может быть пустым')
  .max(
    PATTERN_CATEGORY_NAME_MAX_LENGTH,
    `Название не длиннее ${PATTERN_CATEGORY_NAME_MAX_LENGTH} символов`,
  );

/**
 * Регулярка slug: только нижний регистр, цифры, дефис. Допускаются
 * также `_`, чтобы менеджер мог вручную скопировать roleKey.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const SlugOptionalField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Slug не может быть пустым')
  .max(
    PATTERN_CATEGORY_SLUG_MAX_LENGTH,
    `Slug не длиннее ${PATTERN_CATEGORY_SLUG_MAX_LENGTH} символов`,
  )
  .regex(
    SLUG_RE,
    'Slug: латиница в нижнем регистре, цифры, дефис или подчёркивание',
  )
  .optional();

/**
 * Регулярка roleKey: верхний регистр / цифры / `_`. Обусловлено
 * `MATERIAL_ROLES` (`MAIN_FABRIC`, `RIB`, …): новые ключи должны
 * вписываться в тот же стиль, иначе UI не сможет единообразно
 * отображать роли в `PatternMaterialArea`.
 */
const ROLE_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

const RoleKeyField = z
  .string()
  .trim()
  .min(1, 'roleKey обязателен')
  .max(
    PATTERN_CATEGORY_PARAMETER_ROLE_KEY_MAX_LENGTH,
    `roleKey не длиннее ${PATTERN_CATEGORY_PARAMETER_ROLE_KEY_MAX_LENGTH} символов`,
  )
  .regex(
    ROLE_KEY_RE,
    'roleKey: только латиница в верхнем регистре, цифры и подчёркивание',
  );

const ParameterLabelField = z
  .string()
  .trim()
  .min(1, 'Название параметра обязательно')
  .max(
    PATTERN_CATEGORY_PARAMETER_LABEL_MAX_LENGTH,
    `Название не длиннее ${PATTERN_CATEGORY_PARAMETER_LABEL_MAX_LENGTH} символов`,
  );

const UnitField = z
  .string()
  .trim()
  .max(
    PATTERN_CATEGORY_PARAMETER_UNIT_MAX_LENGTH,
    `Единица не длиннее ${PATTERN_CATEGORY_PARAMETER_UNIT_MAX_LENGTH} символов`,
  );

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

const CategoryDescriptionField = optionalNullableString(
  PATTERN_CATEGORY_DESCRIPTION_MAX_LENGTH,
  'Описание категории',
);

const ParameterDescriptionField = optionalNullableString(
  PATTERN_CATEGORY_PARAMETER_DESCRIPTION_MAX_LENGTH,
  'Описание параметра',
);

// ---------------------------------------------------------------------------
// Parameter input schema (используется и в Create, и в Replace)
// ---------------------------------------------------------------------------

export const PatternCategoryParameterInputSchema = z
  .object({
    roleKey: RoleKeyField,
    label: ParameterLabelField,
    inputType: PatternCategoryParameterInputTypeSchema,
    /**
     * Единица измерения. Если не задана, backend подставит дефолт по
     * `inputType` (см. `PATTERN_CATEGORY_PARAMETER_DEFAULT_UNITS` и
     * `applyParameterDefaults`). Конкретные whitelist единиц для UI
     * приходят из `PATTERN_CATEGORY_PARAMETER_GROUPS[roleKey]`, но
     * на API мы оставляем поле свободной строкой ради совместимости
     * со старыми категориями.
     */
    unit: UnitField.optional(),
    isRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    status: PatternCategoryParameterStatusSchema.optional(),
    description: ParameterDescriptionField,
  })
  .superRefine((value, ctx) => {
    // AREA_M2_BY_SIZE требует unit "м²" если задан явно. Если unit не
    // задан — backend подставит default ("м²").
    if (
      value.inputType === 'AREA_M2_BY_SIZE' &&
      value.unit !== undefined &&
      value.unit !== '' &&
      value.unit !== 'м²'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unit'],
        message:
          'Для типа «Площадь по размерам» единица должна быть «м²» (или не задана).',
      });
    }
  });
export type PatternCategoryParameterInputDto = z.infer<
  typeof PatternCategoryParameterInputSchema
>;

/**
 * Подстановка дефолтов для параметра. Используется и на бэкенде, и
 * в server actions, где менеджер не указал `unit`. Возвращает новый
 * объект — мутаций нет.
 */
export function applyParameterDefaults(
  raw: PatternCategoryParameterInputDto,
): PatternCategoryParameterInputDto & { unit: string; isRequired: boolean; sortOrder: number; status: PatternCategoryParameterStatus } {
  const unit =
    raw.unit !== undefined && raw.unit !== ''
      ? raw.unit
      : PATTERN_CATEGORY_PARAMETER_DEFAULT_UNITS[raw.inputType];
  return {
    ...raw,
    unit,
    isRequired: raw.isRequired ?? false,
    sortOrder: raw.sortOrder ?? 100,
    status: raw.status ?? 'ACTIVE',
  };
}

const ParametersArraySchema = z
  .array(PatternCategoryParameterInputSchema)
  .max(
    PATTERN_CATEGORY_PARAMETERS_MAX,
    `Слишком много параметров: максимум ${PATTERN_CATEGORY_PARAMETERS_MAX}`,
  )
  .superRefine((arr, ctx) => {
    // Уникальность `roleKey` зависит от `inputType`:
    //
    //   - `AREA_M2_BY_SIZE` — `roleKey` ДОЛЖЕН быть уникален внутри
    //     категории. Иначе для `PatternMaterialArea.materialRole`
    //     становится неоднозначно, в какой `label` упирается ячейка
    //     площадей. См. `apps/api/src/modules/patterns/patterns.service.ts`
    //     — `replaceMaterialAreas` валидирует `materialRole` против
    //     активных параметров категории с `inputType = AREA_M2_BY_SIZE`.
    //
    //   - `QTY_PER_ITEM` — одинаковый `roleKey` РАЗРЕШЁН. Это нужно
    //     для нескольких видов фурнитуры, у которых техническая роль
    //     одна и та же (`PACKAGING`), но `label` разный
    //     (Люверсы / Молния / Кнопки / Пуговицы / Шнур / Наконечники).
    //
    //   - `TEXT_ONLY` — одинаковый `roleKey` РАЗРЕШЁН (по аналогии с
    //     `QTY_PER_ITEM` — это «описание / услуга», в `PatternMaterialArea`
    //     не попадает).
    //
    // Дополнительно: `label` после trim не должен повторяться внутри
    // категории — иначе UI рисует две одинаковые колонки и менеджер
    // не отличит их визуально. На MVP считаем это soft guard
    // (case-sensitive `trim`-сравнение).
    const seenAreaRoleKeys = new Set<string>();
    const seenLabels = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i]!;
      if (p.inputType === 'AREA_M2_BY_SIZE') {
        if (seenAreaRoleKeys.has(p.roleKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'roleKey'],
            message: `roleKey "${p.roleKey}" уже использован в другом параметре «Площадь по размерам»`,
          });
        }
        seenAreaRoleKeys.add(p.roleKey);
      }
      // LINEAR_M_BY_SIZE и QTY_PER_ITEM могут повторять roleKey
      // внутри категории — Люверсы / Шнур / Наконечники с
      // roleKey = PACKAGING; разные параметры «Основное полотно»
      // не имеют смысла, но строгий гард делается для AREA_M2_BY_SIZE
      // из-за прямой записи в `PatternMaterialArea.materialRole`.
      // Для LINEAR_M_BY_SIZE значения хранятся по
      // `categoryParameterId` (`PatternItemSizeParameterValue`),
      // поэтому повтор roleKey не делает сохранение неоднозначным.
      const labelKey = p.label.trim();
      if (labelKey !== '') {
        if (seenLabels.has(labelKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'label'],
            message: `Название «${labelKey}» уже использовано в другом параметре`,
          });
        }
        seenLabels.add(labelKey);
      }
    }
  });

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

export const CreatePatternCategorySchema = z.object({
  name: NameRequiredField,
  /**
   * Legacy lucide-`iconKey`. На основном UI «Создать категорию»
   * (`/admin/pattern-categories/new`) больше не выбирается — иконка
   * грузится отдельным multipart-эндпоинтом
   * `POST /api/pattern-categories/:id/icon` после создания категории
   * (см. `PatternCategoriesController.uploadIcon`).
   *
   * Поле осталось optional ради:
   *   - back-compat: старые сидеры/тесты могут передавать `iconKey`;
   *   - fallback: если менеджер не загрузил картинку, UI всё равно
   *     рисует lucide-иконку по этому ключу (по умолчанию `TAG`).
   *
   * `iconImageUrl` через create body НЕ принимается: файл всегда идёт
   * через отдельный upload-эндпоинт (см. ТЗ «Загружаемая JPEG-иконка
   * категории»).
   */
  iconKey: PatternCategoryIconKeySchema.optional(),
  slug: SlugOptionalField,
  sortOrder: z.number().int().min(0).max(100000).optional(),
  status: PatternCategoryStatusSchema.optional(),
  description: CategoryDescriptionField,
  /**
   * Параметры категории. Optional — менеджер может создать категорию
   * сначала пустой и добавить параметры через
   * `PUT /api/pattern-categories/:id/parameters`.
   */
  parameters: ParametersArraySchema.optional(),
});
export type CreatePatternCategoryDto = z.infer<
  typeof CreatePatternCategorySchema
>;

export const UpdatePatternCategorySchema = z
  .object({
    name: NameOptionalField.optional(),
    /**
     * Legacy lucide-`iconKey`. См. комментарий на
     * `CreatePatternCategorySchema.iconKey`. Поле остаётся optional, чтобы
     * старые формы / интеграции могли продолжать его передавать.
     * `iconImageUrl` через PATCH body не принимается: картинка всегда
     * грузится через `POST /api/pattern-categories/:id/icon`.
     */
    iconKey: PatternCategoryIconKeySchema.optional(),
    slug: SlugOptionalField,
    sortOrder: z.number().int().min(0).max(100000).optional(),
    status: PatternCategoryStatusSchema.optional(),
    description: CategoryDescriptionField,
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.iconKey !== undefined ||
      obj.slug !== undefined ||
      obj.sortOrder !== undefined ||
      obj.status !== undefined ||
      obj.description !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdatePatternCategoryDto = z.infer<
  typeof UpdatePatternCategorySchema
>;

export const ReplacePatternCategoryParametersSchema = z.object({
  parameters: ParametersArraySchema,
});
export type ReplacePatternCategoryParametersDto = z.infer<
  typeof ReplacePatternCategoryParametersSchema
>;

export const ListPatternCategoriesQuerySchema = z.object({
  status: PatternCategoryStatusSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type ListPatternCategoriesQuery = z.infer<
  typeof ListPatternCategoriesQuerySchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface PatternCategoryParameterDto {
  id: string;
  categoryId: string;
  roleKey: string;
  label: string;
  inputType: PatternCategoryParameterInputType | string;
  unit: string;
  isRequired: boolean;
  sortOrder: number;
  status: PatternCategoryParameterStatus | string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatternCategoryListItemDto {
  id: string;
  name: string;
  slug: string;
  /**
   * Legacy lucide-`iconKey`. UI использует только как fallback, если
   * `iconImageUrl` пуст (см. `CategoryFilterChip` /
   * `resolvePatternCategoryIcon`).
   */
  iconKey: PatternCategoryIconKey | string;
  /**
   * Публичный URL загруженной JPEG-иконки категории (если есть).
   * `null` для категорий без загруженной картинки — UI fallback на
   * `iconKey`. См. `apps/api/src/modules/pattern-categories/pattern-categories-storage.service.ts`.
   */
  iconImageUrl: string | null;
  /** Оригинальное имя загруженного файла иконки (для отображения). */
  iconOriginalFileName: string | null;
  sortOrder: number;
  status: PatternCategoryStatus | string;
  description: string | null;
  parametersCount: number;
  patternsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PatternCategoryDto extends PatternCategoryListItemDto {
  parameters: PatternCategoryParameterDto[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Сгенерировать slug из произвольного `name` (русское/латинское
 * название категории). Используется как fallback на бэкенде, если
 * менеджер не указал slug при создании категории.
 *
 * Транслитерация — простой словарь по символам; без полноценного ICU.
 * Этого достаточно для admin-UX: slug нужен только для БД-уникальности
 * и опциональных deep-link, его всегда можно переопределить вручную.
 */
const RU_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
};

export function generatePatternCategorySlug(name: string): string {
  const lower = name.toLowerCase().trim();
  let out = '';
  for (const ch of lower) {
    if (RU_TO_LATIN[ch] !== undefined) {
      out += RU_TO_LATIN[ch];
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else if (/[\s\-_/]/.test(ch)) {
      out += '-';
    }
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (out === '') return 'category';
  return out.slice(0, PATTERN_CATEGORY_SLUG_MAX_LENGTH);
}
