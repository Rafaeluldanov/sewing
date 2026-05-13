/**
 * Контракты модуля «Техкарты» (tech cards, MVP).
 *
 * См. `docs/domain.md §«Техкарты»`, ADR-0022. На MVP это простой
 * справочник:
 *   - менеджер создаёт `TechCardTemplate` со списками строк (материалы
 *     + внешние подрядные размещения, OUTSOURCED_SERVICE);
 *   - при создании заказа можно опционально привязать `techCardId`;
 *   - при первом `OrdersService.start()` строки фиксируются в snapshot-ы
 *     `OrderMaterialRequirement[]` и `OrderOutsourceRequirement[]`
 *     (см. `OrderDetailDto.materialRequirements`/`outsourceRequirements`);
 *   - НИКАКИХ формул, размеров, коэффициентов: `totalQty = qtyPerUnit *
 *     Σ qtyPlan` по строкам заказа (см. `OrdersService.start`).
 *
 * Zod-схемы здесь — источник истины для валидации запросов на API и
 * клиентских форм; типы выведены из них.
 */

import { z } from 'zod';

import {
  MATERIAL_ROLES,
  MATERIAL_ROLE_LABELS,
  MaterialRoleSchema,
  type MaterialRole,
} from './material-roles';
import {
  PATTERN_CATEGORY_PARAMETER_GROUPS,
  PATTERN_CATEGORY_PARAMETER_ROLE_KEY_MAX_LENGTH,
  getPatternCategoryParameterGroupConfig,
  getPatternCategoryParameterGroupLabel,
} from './pattern-categories';

/**
 * Регулярка roleKey-а строки техкарты (тот же стиль, что
 * `PatternCategoryParameter.roleKey` — UPPERCASE_SNAKE_CASE).
 * Backend и shared-схема используют одинаковый pattern, чтобы не
 * было «PACKAGING» в одном месте и «packaging» в другом.
 */
const TECH_CARD_MATERIAL_ROLE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Material roles re-export (см. `./material-roles.ts`).
//
// «Техкарты» используют ровно тот же справочник ролей материала, что
// и «Лекала»: связка `TechCardMaterialLine.materialRole` ↔
// `PatternMaterialArea.materialRole` нужна для будущей «Потребности
// цеха» (см. `docs/recon-soft-integration.md §«Этап 3»`). Чтобы
// потребители `@sewing/shared/tech-cards` могли импортировать всё из
// одного модуля, делаем re-export — единственный источник истины
// остаётся в `material-roles.ts`.
// ---------------------------------------------------------------------------

export {
  MATERIAL_ROLES,
  MaterialRoleSchema,
  MATERIAL_ROLE_LABELS,
};
export type { MaterialRole };

// ---------------------------------------------------------------------------
// Tech card material roles (этап «Подтянуть из номенклатуры»)
//
// Источник истины ролей строки техкарты — `PATTERN_CATEGORY_PARAMETER_GROUPS`
// (см. `./pattern-categories.ts`). Это управленчески тот же список, что
// используется в карточках номенклатуры: если технолог завёл категорию
// с параметрами «Основное полотно», «Рибана», «Фурнитура» и т.д. — те
// же роли видит и менеджер техкарты.
//
// Технические ключи roleKey хранятся в БД как свободные строки
// (`TechCardMaterialLine.materialRole String?`), поэтому новые роли
// добавляются без миграции — достаточно расширить
// `PATTERN_CATEGORY_PARAMETER_GROUPS`. Для legacy roleKey (например,
// `APPLICATION` / устаревшие свободные строки) backend сохраняет
// прежнее значение, UI рендерит как read-only fallback.
//
// Важно (см. ТЗ):
//   - `PACKAGING` остаётся техническим roleKey для фурнитуры; в UI
//     показываем «Фурнитура», слово «Упаковка» пользователю больше
//     не появляется;
//   - НЕ заводим отдельный roleKey `HARDWARE` (см. ТЗ §1).
// ---------------------------------------------------------------------------

/**
 * Список технических roleKey-ей, доступных для НОВЫХ строк материала
 * техкарты. Берётся из `PATTERN_CATEGORY_PARAMETER_GROUPS` (тот же
 * набор, что и у параметров категории номенклатуры).
 *
 * Используется UI tech-card-form (select «Роль материала») и backend-
 * валидацией (см. `TechCardMaterialLineInputSchema.materialRole`).
 */
export const TECH_CARD_MATERIAL_ROLE_KEYS: readonly string[] =
  PATTERN_CATEGORY_PARAMETER_GROUPS.map((g) => g.roleKey);

/**
 * Лейбл роли материала техкарты для UI. Синхронизирован с лейблом
 * группы параметров категории — менеджер видит ровно ту же
 * человекочитаемую строку и в карточке номенклатуры, и в техкарте.
 *
 * Для legacy roleKey, которого нет в `PATTERN_CATEGORY_PARAMETER_GROUPS`
 * (`APPLICATION`, старые ad-hoc-строки), пытаемся через
 * `MATERIAL_ROLE_LABELS`; если и там нет — возвращаем сам roleKey,
 * чтобы строка в UI не превратилась в `[object Object]`.
 *
 * НИКОГДА не возвращаем «Упаковка» (см. ТЗ §1): для PACKAGING берём
 * лейбл из `PATTERN_CATEGORY_PARAMETER_GROUPS` (там «Фурнитура»),
 * а MATERIAL_ROLE_LABELS используем только для legacy ролей.
 */
export function getTechCardMaterialRoleLabel(roleKey: string): string {
  const groupConfig = getPatternCategoryParameterGroupConfig(roleKey);
  if (groupConfig) return groupConfig.label;
  // Legacy fallback: APPLICATION и прочие исторические значения,
  // которых нет в категориях номенклатуры. Слово «Упаковка»
  // сознательно не показываем (для PACKAGING выше уже найден
  // лейбл «Фурнитура»).
  if (roleKey in MATERIAL_ROLE_LABELS) {
    const legacy = MATERIAL_ROLE_LABELS[roleKey as MaterialRole];
    return legacy === 'Упаковка' ? 'Фурнитура' : legacy;
  }
  return roleKey;
}

/**
 * Считается ли roleKey валидным для НОВЫХ строк техкарты. Старые
 * (legacy) значения, не входящие в whitelist, разрешены только для
 * существующих строк (см. backend-валидация в
 * `TechCardsService.materialLineCreateData`).
 */
export function isKnownTechCardMaterialRoleKey(roleKey: string): boolean {
  return getPatternCategoryParameterGroupConfig(roleKey) !== null;
}

export {
  PATTERN_CATEGORY_PARAMETER_GROUPS,
  getPatternCategoryParameterGroupConfig,
  getPatternCategoryParameterGroupLabel,
};

// ---------------------------------------------------------------------------
// Color rule (этап 3 «Потребности цеха»)
// ---------------------------------------------------------------------------

/**
 * Правило выбора цвета строки материала техкарты на конкретном заказе:
 *
 * - `ORDER_COLOR`         — цвет берётся из `Order.color`. Используется для
 *   основной ткани, рибаны и прочего, что должно совпадать с цветом
 *   заказа.
 * - `FIXED_COLOR`         — фиксированный цвет (заполняется в `fixedColorText`).
 *   Пример: «чёрный пакет», «прозрачная плёнка», нитки в цвет «графит».
 * - `NO_COLOR`            — у позиции нет цвета (нитки общего назначения,
 *   универсальная упаковка, нанесение/услуга и т.п.).
 * - `ORDER_SELECTED_COLOR` — цвет должен указать менеджер в заказе для
 *   конкретной позиции (см. ТЗ «Цвет нужно указать в заказе»).
 *   В отличие от `ORDER_COLOR`, не наследует `Order.color`: на старте
 *   заказа в snapshot ляжет `requiresColorSelection = true` и пустой
 *   `selectedColorText`; затем менеджер вводит цвет конкретной строки
 *   через `PATCH /api/orders/:id/material-requirements/:requirementId/color`.
 *   Используется для пакетов / фурнитуры / комплектующих, где у каждой
 *   позиции свой цвет, не совпадающий с общим цветом заказа.
 *
 * Хранится в БД свободной строкой (без Prisma enum), список расширяется
 * без миграции. Валидация — Zod-схема ниже.
 */
export const TECH_CARD_MATERIAL_COLOR_RULES = [
  'ORDER_COLOR',
  'FIXED_COLOR',
  'NO_COLOR',
  'ORDER_SELECTED_COLOR',
] as const;
export const TechCardMaterialColorRuleSchema = z.enum(
  TECH_CARD_MATERIAL_COLOR_RULES,
);
export type TechCardMaterialColorRule = z.infer<
  typeof TechCardMaterialColorRuleSchema
>;

export const TECH_CARD_MATERIAL_COLOR_RULE_LABELS: Record<
  TechCardMaterialColorRule,
  string
> = {
  ORDER_COLOR: 'Цвет заказа',
  FIXED_COLOR: 'Фиксированный цвет',
  NO_COLOR: 'Без цвета',
  ORDER_SELECTED_COLOR: 'Указать в заказе',
};

// ---------------------------------------------------------------------------
// Trigger type (cut-ready readiness, MVP-2)
// ---------------------------------------------------------------------------

/**
 * Тип триггера активации внешней потребности (см. ADR-0022
 * §«Cut-ready readiness (MVP-2)», `prisma/schema.prisma
 * §enum OutsourceTriggerType`).
 *
 * - `MANUAL`    — обычная потребность, UI ничего не подсказывает;
 * - `CUT_READY` — готовность считается «когда весь крой заказа
 *   размещён в ячейки» (`Passport.currentCellId != null` для всех
 *   паспортов, и паспортов хотя бы один). Derive on-read в
 *   `OrdersService.getOne()`; ничего не пишется в БД.
 *
 * Other trigger types (route-step, ANY_PASSPORTS, событийные)
 * сознательно отложены — universal trigger engine не строится в этом
 * MVP.
 */
export const OUTSOURCE_TRIGGER_TYPES = ['MANUAL', 'CUT_READY'] as const;
export const OutsourceTriggerTypeSchema = z.enum(OUTSOURCE_TRIGGER_TYPES);
export type OutsourceTriggerType = z.infer<typeof OutsourceTriggerTypeSchema>;

const OutsourceTriggerTypeField = OutsourceTriggerTypeSchema
  .optional()
  .default('MANUAL');

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

export const TECH_CARD_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,47}$/;
export const TECH_CARD_CODE_MAX_LENGTH = 48;
export const TECH_CARD_NAME_MAX_LENGTH = 120;
export const TECH_CARD_LINE_NAME_MAX_LENGTH = 200;
export const TECH_CARD_LINE_UNIT_MAX_LENGTH = 32;
export const TECH_CARD_LINE_NOTE_MAX_LENGTH = 500;
export const TECH_CARD_LINE_VENDOR_NAME_MAX_LENGTH = 120;
export const TECH_CARD_LINE_FABRIC_TYPE_MAX_LENGTH = 120;
export const TECH_CARD_LINE_FIXED_COLOR_MAX_LENGTH = 120;
/**
 * Лимиты длин дополнительных полей строки материала техкарты для
 * фурнитуры / изображения (см. ТЗ «Фурнитура в техкарте» /
 * «Изображение материала»). Все поля nullable + backward-compatible:
 * на UI заполняются только для роли `PACKAGING`, для остальных
 * сохраняются `null`.
 *
 * `materialImageUrl` сознательно не URL-валидируется как `z.string().url()`
 * — на MVP принимаем и относительные пути (`/uploads/...`), и любые
 * абсолютные ссылки, длиной до `TECH_CARD_LINE_MATERIAL_IMAGE_URL_MAX_LENGTH`.
 */
export const TECH_CARD_LINE_HARDWARE_SIZE_MAX_LENGTH = 120;
export const TECH_CARD_LINE_HARDWARE_MATERIAL_MAX_LENGTH = 120;
export const TECH_CARD_LINE_MATERIAL_IMAGE_URL_MAX_LENGTH = 1024;
export const TECH_CARD_LINE_MATERIAL_IMAGE_FILENAME_MAX_LENGTH = 255;

/**
 * Whitelist расширений файла изображения строки материала техкарты
 * (см. ТЗ §9 «Изображение прикрепляется файлом JPG/PNG»). Backend и
 * frontend используют единый список — `accept`-атрибут на `<input
 * type="file">` и валидация в `TechCardsStorageService` идентичны.
 */
export const TECH_CARD_LINE_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const;

/**
 * Лимит размера файла изображения строки материала техкарты, в
 * байтах. 5 MB — типичное JPEG/PNG-превью фурнитуры (молния,
 * пуговица и т.п.) укладывается в 1–2 MB; 5 MB оставляем как запас
 * под полностью несжатые PNG из «Foto > Save As».
 */
export const TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
/**
 * Жёсткие верхние границы значений плотности и ширины рулона. Сами
 * нормы цеха гораздо ниже (плотность 100–500 г/м², ширина 100–250 см),
 * но валидация — анти-fool-проверка ввода: int > 0 и не безумно
 * большой.
 */
export const TECH_CARD_LINE_DENSITY_GSM_MAX = 10000;
export const TECH_CARD_LINE_PLANNED_WIDTH_CM_MAX = 1000;
export const TECH_CARD_MAX_LINES_PER_SECTION = 200;

const TechCardCodeField = z
  .string()
  .trim()
  .min(1, 'Код техкарты обязателен')
  .max(
    TECH_CARD_CODE_MAX_LENGTH,
    `Код техкарты не длиннее ${TECH_CARD_CODE_MAX_LENGTH} символов`,
  )
  .regex(
    TECH_CARD_CODE_PATTERN,
    'Код техкарты: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
  );

const TechCardNameField = z
  .string()
  .trim()
  .min(1, 'Название техкарты обязательно')
  .max(
    TECH_CARD_NAME_MAX_LENGTH,
    `Название техкарты не длиннее ${TECH_CARD_NAME_MAX_LENGTH} символов`,
  );

const LineNameField = z
  .string()
  .trim()
  .min(1, 'Название строки обязательно')
  .max(
    TECH_CARD_LINE_NAME_MAX_LENGTH,
    `Название строки не длиннее ${TECH_CARD_LINE_NAME_MAX_LENGTH} символов`,
  );

const LineUnitRequiredField = z
  .string()
  .trim()
  .min(1, 'Единица измерения обязательна')
  .max(
    TECH_CARD_LINE_UNIT_MAX_LENGTH,
    `Единица измерения не длиннее ${TECH_CARD_LINE_UNIT_MAX_LENGTH} символов`,
  );

const LineUnitOptionalField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_UNIT_MAX_LENGTH,
    `Единица измерения не длиннее ${TECH_CARD_LINE_UNIT_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

const LineNoteField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_NOTE_MAX_LENGTH,
    `Примечание не длиннее ${TECH_CARD_LINE_NOTE_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

const VendorNameField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_VENDOR_NAME_MAX_LENGTH,
    `Подрядчик не длиннее ${TECH_CARD_LINE_VENDOR_NAME_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

/**
 * `qtyPerUnit` хранится как Decimal(12,4). Принимаем как `string` или
 * `number`, нормализуем к строке с `.` (без локалей) и валидируем как
 * положительное число с не более чем 4 знаками после запятой. Возвращаем
 * строку — её `Prisma.Decimal` принимает как есть.
 */
function makeQtyField(opts: { required: boolean }): z.ZodType<string | null> {
  const base = z.union([z.string(), z.number()]).transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      if (opts.required) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Норма расхода обязательна',
        });
        return z.NEVER;
      }
      return null as string | null;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Норма расхода: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма расхода должна быть > 0',
      });
      return z.NEVER;
    }
    return raw;
  });
  if (opts.required) {
    return base as unknown as z.ZodType<string | null>;
  }
  return base.nullable().optional().transform((v) => (v == null ? null : v)) as
    unknown as z.ZodType<string | null>;
}

// ---------------------------------------------------------------------------
// Etap 3 «Потребности цеха»: optional поля строки материала техкарты
// (см. `docs/recon-soft-integration.md §«Этап 3»`).
//
// Все поля сознательно nullable, backward-compatible со старыми
// клиентами и записями: если форма ничего не передала, в БД ляжет
// `null`, в snapshot заказа тоже `null`. Валидация только нормализует
// пустые строки/значения и проверяет диапазоны.
// ---------------------------------------------------------------------------

/**
 * `materialRole` приходит как строка из `<select>`. Пустая строка/null
 * = «не выбрана» → null. Whitelist на запись валидируется backend-ом:
 * для НОВЫХ строк — против `TECH_CARD_MATERIAL_ROLE_KEYS` (источник —
 * `PATTERN_CATEGORY_PARAMETER_GROUPS`); для legacy roleKey, уже
 * сохранённых в БД, валидация мягкая — UI рендерит их как read-only.
 *
 * Здесь Zod-схема НЕ enforce-ит whitelist: shared-схема едет и в
 * legacy actions (`apps/web/app/admin/tech-cards/actions.ts`), где
 * пересохраняются старые техкарты с APPLICATION/прочими исторически
 * допустимыми roleKey. Если бы мы тут отвергали неизвестные значения,
 * то открытие старой техкарты падало бы при первом submit-е.
 *
 * Связка с `PatternMaterialArea.materialRole` сохраняется через тот
 * же справочник `PATTERN_CATEGORY_PARAMETER_GROUPS` (см.
 * `@sewing/shared/pattern-categories`).
 */
const MaterialRoleOptionalField = z
  .preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        return trimmed === '' ? null : trimmed;
      }
      return v;
    },
    z
      .string()
      .max(
        PATTERN_CATEGORY_PARAMETER_ROLE_KEY_MAX_LENGTH,
        `roleKey не длиннее ${PATTERN_CATEGORY_PARAMETER_ROLE_KEY_MAX_LENGTH} символов`,
      )
      .regex(
        TECH_CARD_MATERIAL_ROLE_KEY_PATTERN,
        'roleKey: только латиница в верхнем регистре, цифры и подчёркивание',
      )
      .nullable()
      .optional(),
  )
  .transform((v) => (v == null ? null : v));

const ColorRuleOptionalField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    }
    return v;
  },
  TechCardMaterialColorRuleSchema.nullable().optional(),
).transform((v) => (v == null ? null : v));

/**
 * Optional positive integer (для `densityGsm` / `plannedWidthCm`).
 * Принимаем `string` или `number`; пустая строка / null → null.
 * Иначе проверяем целое > 0, в разумных пределах.
 */
function makeOptionalPositiveIntField(opts: {
  label: string;
  max: number;
}): z.ZodType<number | null> {
  return z
    .union([z.string(), z.number(), z.null()])
    .transform((v, ctx) => {
      if (v === null || v === undefined) return null as number | null;
      const raw = typeof v === 'number' ? String(v) : v.trim();
      if (raw === '') return null as number | null;
      if (!/^\d+$/.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label}: положительное целое число`,
        });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label}: положительное целое число`,
        });
        return z.NEVER;
      }
      if (n > opts.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label}: значение выглядит ошибочным (> ${opts.max})`,
        });
        return z.NEVER;
      }
      return n;
    })
    .nullable()
    .optional()
    .transform((v) => (v == null ? null : v)) as unknown as z.ZodType<
    number | null
  >;
}

const DensityGsmField = makeOptionalPositiveIntField({
  label: 'Плотность',
  max: TECH_CARD_LINE_DENSITY_GSM_MAX,
});

const PlannedWidthCmField = makeOptionalPositiveIntField({
  label: 'Ширина рулона',
  max: TECH_CARD_LINE_PLANNED_WIDTH_CM_MAX,
});

const FabricTypeField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_FABRIC_TYPE_MAX_LENGTH,
    `Характеристика не длиннее ${TECH_CARD_LINE_FABRIC_TYPE_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

const FixedColorTextField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_FIXED_COLOR_MAX_LENGTH,
    `Фиксированный цвет не длиннее ${TECH_CARD_LINE_FIXED_COLOR_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

/**
 * Reusable optional+nullable string field с трим/нормализацией пустой
 * строки в null. Используется для всех новых полей фурнитуры /
 * изображения материала (см. ТЗ «Фурнитура в техкарте»,
 * «Изображение материала»).
 */
function makeOptionalTextField(opts: { max: number; label: string }) {
  return z
    .string()
    .trim()
    .max(opts.max, `${opts.label} не длиннее ${opts.max} символов`)
    .nullable()
    .optional()
    .transform((v) => (v == null || v === '' ? null : v));
}

const HardwareSizeTextField = makeOptionalTextField({
  max: TECH_CARD_LINE_HARDWARE_SIZE_MAX_LENGTH,
  label: 'Размер / характеристика',
});

const HardwareMaterialTextField = makeOptionalTextField({
  max: TECH_CARD_LINE_HARDWARE_MATERIAL_MAX_LENGTH,
  label: 'Материал',
});

const MaterialImageUrlField = makeOptionalTextField({
  max: TECH_CARD_LINE_MATERIAL_IMAGE_URL_MAX_LENGTH,
  label: 'URL изображения',
});

const MaterialImageOriginalFileNameField = makeOptionalTextField({
  max: TECH_CARD_LINE_MATERIAL_IMAGE_FILENAME_MAX_LENGTH,
  label: 'Имя файла изображения',
});

// ---------------------------------------------------------------------------
// Line input DTO
// ---------------------------------------------------------------------------

/**
 * Строка материала. `sortOrder` НЕ принимается из формы — backend
 * нормализует порядок по позиции в массиве (`(i + 1) * 10`).
 *
 * Этап 3 «Потребности цеха» (см. `docs/recon-soft-integration.md
 * §«Этап 3»`): добавлены опциональные поля `materialRole`, `fabricType`,
 * `densityGsm`, `plannedWidthCm`, `colorRule`, `fixedColorText`. Все
 * nullable, backward-compatible — старые клиенты и техкарты остаются
 * валидными.
 *
 * Этап «Фурнитура / изображение материала» (см. ТЗ §3, §5): добавлены
 * `hardwareSizeText` / `hardwareMaterialText` (для `PACKAGING`) и
 * `materialImageUrl` / `materialImageOriginalFileName` (URL/превью
 * картинки строки материала). Все nullable + additive: старые
 * техкарты не меняются, UI рисует поля только для нужных ролей.
 *
 * Кросс-валидация:
 *   - `fixedColorText` обязателен только при `colorRule = FIXED_COLOR`;
 *   - при любом другом `colorRule` `fixedColorText` зачищается в
 *     `null` сервисом (см. `TechCardsService.materialLineCreateData`);
 *   - `hardwareSizeText` / `hardwareMaterialText` имеют смысл только
 *     для `materialRole = PACKAGING` (фурнитура). Сервис на бэке
 *     зачищает их в null для других ролей.
 */
export const TechCardMaterialLineInputSchema = z
  .object({
    name: LineNameField,
    unit: LineUnitRequiredField,
    qtyPerUnit: makeQtyField({ required: true }),
    note: LineNoteField,
    materialRole: MaterialRoleOptionalField,
    fabricType: FabricTypeField,
    densityGsm: DensityGsmField,
    plannedWidthCm: PlannedWidthCmField,
    colorRule: ColorRuleOptionalField,
    fixedColorText: FixedColorTextField,
    hardwareSizeText: HardwareSizeTextField,
    hardwareMaterialText: HardwareMaterialTextField,
    materialImageUrl: MaterialImageUrlField,
    materialImageOriginalFileName: MaterialImageOriginalFileNameField,
  })
  .superRefine((line, ctx) => {
    if (line.colorRule === 'FIXED_COLOR') {
      const text = line.fixedColorText;
      if (text == null || text.length === 0) {
        ctx.addIssue({
          path: ['fixedColorText'],
          code: z.ZodIssueCode.custom,
          message:
            'Для правила «Фиксированный цвет» нужно указать сам цвет',
        });
      }
    }
  });
export type TechCardMaterialLineInputDto = z.infer<
  typeof TechCardMaterialLineInputSchema
>;

/**
 * Строка внешнего подрядного размещения. Большая часть полей
 * опциональна — иногда подряд считается «за партию» без явной нормы.
 */
export const TechCardOutsourceLineInputSchema = z.object({
  name: LineNameField,
  unit: LineUnitOptionalField,
  qtyPerUnit: makeQtyField({ required: false }),
  vendorName: VendorNameField,
  note: LineNoteField,
  /**
   * Триггер активации (см. `OutsourceTriggerType`). Опционален —
   * если форма/клиент не передают, считаем `MANUAL` (backward-compat
   * со старыми клиентами и существующими записями).
   */
  triggerType: OutsourceTriggerTypeField,
});
export type TechCardOutsourceLineInputDto = z.infer<
  typeof TechCardOutsourceLineInputSchema
>;

const MaterialLinesField = z
  .array(TechCardMaterialLineInputSchema)
  .max(
    TECH_CARD_MAX_LINES_PER_SECTION,
    `Максимум ${TECH_CARD_MAX_LINES_PER_SECTION} строк материалов`,
  );

const OutsourceLinesField = z
  .array(TechCardOutsourceLineInputSchema)
  .max(
    TECH_CARD_MAX_LINES_PER_SECTION,
    `Максимум ${TECH_CARD_MAX_LINES_PER_SECTION} строк внешних потребностей`,
  );

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Soft-привязка техкарты к группе номенклатуры (`PatternCategory`).
 * Этап «Inline-создание изделия из формы заказа»: окно создания
 * техкарты внутри модалки «Создать изделие» автоматически передаёт
 * `patternCategoryId` выбранной категории. На остальных формах
 * (admin `/admin/tech-cards/new`) поле опционально и nullable.
 *
 * `null` — снять привязку; `undefined` — не трогать колонку (на update).
 */
const PatternCategoryIdOptionalField = z
  .string()
  .min(1)
  .nullable()
  .optional();

export const CreateTechCardSchema = z.object({
  code: TechCardCodeField,
  name: TechCardNameField,
  isActive: z.boolean().optional().default(true),
  patternCategoryId: PatternCategoryIdOptionalField,
  materialLines: MaterialLinesField.default([]),
  outsourceLines: OutsourceLinesField.default([]),
});
export type CreateTechCardDto = z.infer<typeof CreateTechCardSchema>;

export const UpdateTechCardSchema = z
  .object({
    code: TechCardCodeField.optional(),
    name: TechCardNameField.optional(),
    isActive: z.boolean().optional(),
    patternCategoryId: PatternCategoryIdOptionalField,
    materialLines: MaterialLinesField.optional(),
    outsourceLines: OutsourceLinesField.optional(),
  })
  .refine(
    (obj) =>
      obj.code !== undefined ||
      obj.name !== undefined ||
      obj.isActive !== undefined ||
      obj.patternCategoryId !== undefined ||
      obj.materialLines !== undefined ||
      obj.outsourceLines !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateTechCardDto = z.infer<typeof UpdateTechCardSchema>;

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListTechCardsQuerySchema = z.object({
  /**
   * `true`  — только активные (для UI выбора техкарты при создании заказа);
   * `false` — только неактивные;
   * не указан — все (для админа).
   */
  isActive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === 'boolean') return v;
      return v === 'true';
    }),
  /**
   * Этап «Inline-создание изделия из формы заказа»: фильтр по
   * группе номенклатуры (`TechCardTemplate.patternCategoryId`).
   * Используется селектом «Техкарта» в модалке «Создать изделие»,
   * чтобы показать только техкарты выбранной категории.
   */
  patternCategoryId: z.string().min(1).optional(),
  search: z.string().trim().max(100).optional(),
});
export type ListTechCardsQuery = z.infer<typeof ListTechCardsQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface TechCardMaterialLineDto {
  id: string;
  sortOrder: number;
  name: string;
  unit: string;
  /** Decimal как строка (см. `Prisma.Decimal`). */
  qtyPerUnit: string;
  note: string | null;
  /**
   * Этап 3 «Потребности цеха» (см. `docs/recon-soft-integration.md
   * §«Этап 3»`). Все поля nullable + backward-compatible:
   *
   * - `materialRole` — `MaterialRole | null` (см.
   *   `@sewing/shared/material-roles`); связка с
   *   `PatternMaterialArea.materialRole` для будущей «Потребности цеха»;
   * - `fabricType` — характеристика полотна (свободная строка);
   * - `densityGsm` / `plannedWidthCm` — параметры для тканей;
   * - `colorRule` / `fixedColorText` — правило цвета строки.
   *
   * Старые техкарты, у которых эти поля не заполнены, отдают `null`
   * по каждому полю — UI отображает пустые ячейки, без ошибок.
   */
  /**
   * `materialRole` хранится в БД свободной строкой (`String?`), поэтому
   * DTO принимает любую строку. Whitelist на запись валидируется
   * shared-схемой / backend-ом по `TECH_CARD_MATERIAL_ROLE_KEYS`.
   * Для legacy roleKey-ов (`APPLICATION`, ad-hoc-строки старых
   * техкарт) UI отображает значение как read-only (см. tech-card-form).
   */
  materialRole: string | null;
  fabricType: string | null;
  densityGsm: number | null;
  plannedWidthCm: number | null;
  colorRule: TechCardMaterialColorRule | null;
  fixedColorText: string | null;
  /**
   * Этап «Фурнитура в техкарте» (см. ТЗ §3): доп. характеристики
   * фурнитуры (для `materialRole = PACKAGING`). Все nullable +
   * backward-compatible: старые техкарты отдают null.
   */
  hardwareSizeText: string | null;
  hardwareMaterialText: string | null;
  /**
   * Этап «Изображение материала» (см. ТЗ §5): URL/относительный путь
   * картинки строки материала + опционально имя файла-источника.
   * На MVP заполняется только URL — upload-эндпоинт делается отдельно.
   */
  materialImageUrl: string | null;
  materialImageOriginalFileName: string | null;
}

export interface TechCardOutsourceLineDto {
  id: string;
  sortOrder: number;
  name: string;
  unit: string | null;
  qtyPerUnit: string | null;
  vendorName: string | null;
  note: string | null;
  /**
   * Триггер активации строки (см. `OutsourceTriggerType`,
   * ADR-0022 §«Cut-ready readiness (MVP-2)»). Копируется в snapshot
   * заказа при `OrdersService.start()`.
   */
  triggerType: OutsourceTriggerType;
}

export interface TechCardTemplateSummaryDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  /**
   * Soft-привязка техкарты к группе номенклатуры. Поле опционально (`?`)
   * для backward-compat — старые клиенты shared-пакета продолжают
   * компилироваться. Backend всегда отдаёт `null | string` после
   * миграции `20260622100000_add_product_creation_mode_and_dev_cost`.
   */
  patternCategoryId?: string | null;
  materialLinesCount: number;
  outsourceLinesCount: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface TechCardTemplateDetailDto extends TechCardTemplateSummaryDto {
  materialLines: TechCardMaterialLineDto[];
  outsourceLines: TechCardOutsourceLineDto[];
}
