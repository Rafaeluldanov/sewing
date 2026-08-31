/**
 * Контракты модуля «Лекала» (Patterns MVP-1, изолированный модуль).
 *
 * См. `docs/recon-soft-integration.md §«План внедрения»`,
 * `prisma/schema.prisma` (`PatternItem`, `PatternSizeFile`,
 * `PatternMaterialArea`), `apps/api/src/modules/patterns/*`.
 *
 * Дизайн MVP-1:
 *   - лекало живёт самостоятельным справочником: артикул + название
 *     + категория + статус + превью + список DXF-файлов по размерам
 *     + список площадей материалов по размеру/роли;
 *   - НИКАКОЙ связи с `Order`/`OrderItem`/`TechCard*` на этом этапе;
 *   - `materialRole` хранится строкой (БД), валидируется списком
 *     `MATERIAL_ROLES` ниже — будущее расширение списка не требует
 *     миграции схемы;
 *   - `previewImageUrl` / `PatternSizeFile.fileUrl` — публичные URL
 *     (`/uploads/patterns/...`); binary в БД не лежит, см.
 *     `apps/api/src/modules/patterns/storage`.
 *
 * Zod-схемы здесь — источник истины для валидации запросов на API
 * (`ZodValidationPipe`) и клиентских форм (`apps/web/app/admin/patterns/*`).
 */

import { z } from 'zod';
import type { ConstructorTaskSummaryDto } from './constructor-tasks';
import type {
  PatternItemMaterialLineDto,
  PatternItemSpecParameterDto,
} from './pattern-item-spec';

import {
  MATERIAL_ROLES,
  MATERIAL_ROLE_LABELS,
  MaterialRoleSchema,
  type MaterialRole,
} from './material-roles';
import type {
  PatternCategoryDto,
  PatternCategoryIconKey,
  PatternCategoryParameterDto,
  PatternCategoryStatus,
} from './pattern-categories';

// ---------------------------------------------------------------------------
// Material roles (re-export, см. `./material-roles.ts` — единственный
// источник истины как для модуля «Лекала», так и для «Техкарт»).
// Сохраняем существующий API (`MATERIAL_ROLES`, `MaterialRoleSchema`,
// `MaterialRole`, `MATERIAL_ROLE_LABELS`), чтобы клиенты
// `@sewing/shared/patterns` не ломались.
// ---------------------------------------------------------------------------

export {
  MATERIAL_ROLES,
  MaterialRoleSchema,
  MATERIAL_ROLE_LABELS,
};
export type { MaterialRole };

// ---------------------------------------------------------------------------
// Pattern item statuses
// ---------------------------------------------------------------------------

/**
 * Известные статусы карточки лекала. БД хранит свободную строку с
 * дефолтом `ACTIVE` (см. `prisma/schema.prisma::PatternItem.status`),
 * поэтому список можно расширять без миграции. UI отображает только
 * известные значения через лейбл, неизвестные — строкой как есть.
 */
export const PATTERN_ITEM_STATUSES = ['ACTIVE', 'DRAFT', 'ARCHIVED'] as const;
export const PatternItemStatusSchema = z.enum(PATTERN_ITEM_STATUSES);
export type PatternItemStatus = z.infer<typeof PatternItemStatusSchema>;

export const PATTERN_ITEM_STATUS_LABELS: Record<PatternItemStatus, string> = {
  ACTIVE: 'Активно',
  DRAFT: 'Черновик',
  ARCHIVED: 'Архив',
};

// ---------------------------------------------------------------------------
// File status (PatternSizeFile)
// ---------------------------------------------------------------------------

/**
 * Состояние записи DXF-файла. На MVP `ACTIVE`/`ARCHIVED`. Архивная
 * запись остаётся в БД и показывается в истории, но не считается
 * актуальной версией. См. `PatternsService.archiveSizeFile`.
 */
export const PATTERN_SIZE_FILE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type PatternSizeFileStatus = (typeof PATTERN_SIZE_FILE_STATUSES)[number];

// ---------------------------------------------------------------------------
// File extension constants (для frontend и UI hints)
// ---------------------------------------------------------------------------

/**
 * Разрешённые расширения файла превью лекала. Backend независимо
 * валидирует mime-type и расширение (`PatternsStorageService`).
 */
export const PATTERN_PREVIEW_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

/**
 * Разрешённые расширения файла лекала по размеру. Принимаем PDF/PLT/DXF/PLO
 * (раньше был только DXF). Файл необязателен — размер может быть добавлен
 * без файла, а файл догружается позже (см. `PatternSizeFile.fileUrl` nullable).
 */
export const PATTERN_FILE_EXTENSIONS = ['pdf', 'plt', 'dxf', 'plo'] as const;

/** @deprecated используйте `PATTERN_FILE_EXTENSIONS`. Оставлено как алиас. */
export const PATTERN_DXF_EXTENSIONS = PATTERN_FILE_EXTENSIONS;

/**
 * Лимит размера превью / DXF файла на upload (в байтах). 25 MB —
 * с запасом под крупные DXF (раскладка многих размеров) и без
 * лишнего давления на дисковую квоту dev/stage.
 */
export const PATTERN_FILE_MAX_SIZE_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

export const PATTERN_NAME_MAX_LENGTH = 200;
export const PATTERN_ARTICLE_MAX_LENGTH = 64;
export const PATTERN_CATEGORY_CODE_MAX_LENGTH = 64;
export const PATTERN_DESCRIPTION_MAX_LENGTH = 4000;
export const PATTERN_AREA_COMMENT_MAX_LENGTH = 500;
/**
 * Лимит длины комментария к норме фурнитуры. На MVP совпадает с
 * лимитом «Площадей материалов» — менеджеру одинаково нужны
 * короткие пояснения на пару строк.
 */
export const PATTERN_PARAMETER_NORM_COMMENT_MAX_LENGTH = 500;
/**
 * Лимит длины комментария к значению «Погонные метры по размерам»
 * (`PatternItemSizeParameterValue.comment`). Совпадает с лимитом
 * для площадей и норм фурнитуры — UX единый.
 */
export const PATTERN_SIZE_PARAMETER_VALUE_COMMENT_MAX_LENGTH = 500;
/**
 * Sanity-предел значения «Погонные метры по размерам». Хранение
 * Decimal(14,4); ставим числовой потолок против опечаток
 * (например, «10000 м пог. на одно изделие» — почти наверняка
 * лишний ноль).
 */
export const PATTERN_SIZE_PARAMETER_VALUE_MAX = 1_000_000;
/**
 * Sanity-предел нормы «количество на изделие». Decimal(14, 4) уже
 * закрывает диапазон, но оставляем числовой потолок против опечаток
 * (например, «Люверсы 100000 шт на изделие» — почти наверняка
 * лишний ноль).
 */
export const PATTERN_PARAMETER_NORM_MAX = 1_000_000;

const NameRequiredField = z
  .string()
  .trim()
  .min(1, 'Название лекала обязательно')
  .max(
    PATTERN_NAME_MAX_LENGTH,
    `Название не длиннее ${PATTERN_NAME_MAX_LENGTH} символов`,
  );

const NameOptionalField = z
  .string()
  .trim()
  .min(1, 'Название не может быть пустым')
  .max(
    PATTERN_NAME_MAX_LENGTH,
    `Название не длиннее ${PATTERN_NAME_MAX_LENGTH} символов`,
  );

const ArticleRequiredField = z
  .string()
  .trim()
  .min(1, 'Артикул обязателен')
  .max(
    PATTERN_ARTICLE_MAX_LENGTH,
    `Артикул не длиннее ${PATTERN_ARTICLE_MAX_LENGTH} символов`,
  );

const ArticleOptionalField = z
  .string()
  .trim()
  .min(1, 'Артикул не может быть пустым')
  .max(
    PATTERN_ARTICLE_MAX_LENGTH,
    `Артикул не длиннее ${PATTERN_ARTICLE_MAX_LENGTH} символов`,
  );

/**
 * Optional строковое поле, которое:
 *   - принимает пустую строку как «не задано» → возвращает `null`;
 *   - триммит пробелы;
 *   - проверяет длину.
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

const CategoryCodeField = optionalNullableString(
  PATTERN_CATEGORY_CODE_MAX_LENGTH,
  'Категория',
);

/**
 * Опциональный FK на типизированный справочник `PatternCategory`.
 * Принимаем:
 *   - `string` (cuid) — нормальная привязка,
 *   - `null` — явное «убрать категорию» (UI шлёт null при сбросе),
 *   - `''` (пустая строка) — нормализуется в null (поведение
 *     `categoryCode`-а),
 *   - `undefined` — поле не присутствует в payload и не трогается.
 */
const CategoryIdField = z
  .preprocess((v) => {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  }, z.string().min(1, 'categoryId не может быть пустым').nullable())
  .optional();

const DescriptionField = optionalNullableString(
  PATTERN_DESCRIPTION_MAX_LENGTH,
  'Описание',
);

const AreaCommentField = optionalNullableString(
  PATTERN_AREA_COMMENT_MAX_LENGTH,
  'Комментарий',
);

/**
 * Площадь в м². Принимаем `string` или `number`, нормализуем к строке
 * с `.` (без локалей), валидируем как положительное число с не более
 * чем 4 знаками после запятой. Возвращаем строку — `Prisma.Decimal`
 * принимает её как есть.
 */
const AreaM2Field = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Площадь обязательна',
      });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Площадь: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Площадь должна быть > 0',
      });
      return z.NEVER;
    }
    return raw;
  });

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

export const CreatePatternSchema = z.object({
  name: NameRequiredField,
  article: ArticleRequiredField,
  /**
   * Legacy-поле «текстовая категория». Этап «Категории номенклатуры»
   * перевёл новые карточки на FK `categoryId`, но сохранил
   * `categoryCode` ради исторических записей и совместимости со
   * старыми импортами/сидами. Можно передавать одновременно с
   * `categoryId` — backend хранит обе строки.
   */
  categoryCode: CategoryCodeField,
  /**
   * FK на `PatternCategory.id` (этап «Категории номенклатуры»).
   * Backend проверяет существование и `status = ACTIVE` (см.
   * `PatternsService.create/update`). При успешном сохранении
   * UI «Площади материалов» строится по параметрам этой категории
   * (`AREA_M2_BY_SIZE`).
   */
  categoryId: CategoryIdField,
  description: DescriptionField,
  /**
   * Статус карточки. Опционально — backend по умолчанию ставит
   * `ACTIVE`. Принимаем известный enum-набор; неизвестные значения
   * отклоняем на API, чтобы менеджер не накопил мусорных статусов
   * случайным POST-ом.
   */
  status: PatternItemStatusSchema.optional(),
});
export type CreatePatternDto = z.infer<typeof CreatePatternSchema>;

export const UpdatePatternSchema = z
  .object({
    name: NameOptionalField.optional(),
    article: ArticleOptionalField.optional(),
    categoryCode: CategoryCodeField,
    categoryId: CategoryIdField,
    description: DescriptionField,
    status: PatternItemStatusSchema.optional(),
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.article !== undefined ||
      obj.categoryCode !== undefined ||
      obj.categoryId !== undefined ||
      obj.description !== undefined ||
      obj.status !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdatePatternDto = z.infer<typeof UpdatePatternSchema>;

/**
 * Bulk-replace «Площадей материалов» лекала
 * (`PUT /api/patterns/:id/material-areas`). Backend в одной транзакции
 * удаляет все старые `PatternMaterialArea` лекала и пишет новый набор.
 */
export const ReplacePatternMaterialAreaInputSchema = z.object({
  sizeId: z.string().min(1, 'sizeId обязателен'),
  materialRole: MaterialRoleSchema,
  areaM2: AreaM2Field,
  comment: AreaCommentField,
});
export type ReplacePatternMaterialAreaInputDto = z.infer<
  typeof ReplacePatternMaterialAreaInputSchema
>;

export const ReplacePatternMaterialAreasSchema = z.object({
  areas: z
    .array(ReplacePatternMaterialAreaInputSchema)
    .max(
      1000,
      'Слишком много строк площадей: максимум 1000 за один запрос',
    ),
});
export type ReplacePatternMaterialAreasDto = z.infer<
  typeof ReplacePatternMaterialAreasSchema
>;

// ---------------------------------------------------------------------------
// Pattern item parameter norms — этап «Фурнитура и нормы»
// (см. `prisma/schema.prisma::PatternItemParameterNorm`,
// `apps/api/src/modules/patterns/patterns.service.ts::replaceParameterNorms`,
// `apps/web/app/admin/patterns/[id]/parameter-norms-form.tsx`).
// ---------------------------------------------------------------------------

const ParameterNormCommentField = optionalNullableString(
  PATTERN_PARAMETER_NORM_COMMENT_MAX_LENGTH,
  'Комментарий',
);

const ParameterNormUnitField = z
  .preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(16, 'Единица не длиннее 16 символов')
      .nullable()
      .optional(),
  );

/**
 * Норма «количество на изделие». Принимаем `string | number`,
 * нормализуем к строке с `.` (без локалей), валидируем как
 * положительное число с не более чем 4 знаками после запятой.
 * Возвращаем строку — `Prisma.Decimal` принимает её как есть.
 */
const QtyPerItemField = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма обязательна',
      });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма должна быть > 0',
      });
      return z.NEVER;
    }
    if (n > PATTERN_PARAMETER_NORM_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Норма выглядит ошибочной: значение > ${PATTERN_PARAMETER_NORM_MAX}`,
      });
      return z.NEVER;
    }
    return raw;
  });

/**
 * Одна норма «количество на изделие» по конкретному параметру
 * категории. `categoryParameterId` обязателен — для группы
 * «Фурнитура» в одной категории несколько параметров могут иметь
 * одинаковый `roleKey = PACKAGING`, и хранить нормы нужно именно
 * по конкретному `id` параметра (Люверсы / Шнур / Наконечники).
 *
 * `unit` опционально: если не задан, backend подставит
 * `PatternCategoryParameter.unit` (по умолчанию для QTY_PER_ITEM —
 * «шт»).
 */
export const ReplacePatternItemParameterNormInputSchema = z.object({
  categoryParameterId: z.string().min(1, 'categoryParameterId обязателен'),
  qtyPerItem: QtyPerItemField,
  unit: ParameterNormUnitField,
  comment: ParameterNormCommentField,
});
export type ReplacePatternItemParameterNormInputDto = z.infer<
  typeof ReplacePatternItemParameterNormInputSchema
>;

/**
 * Bulk-replace «Фурнитуры и норм» лекала
 * (`PUT /api/patterns/:id/parameter-norms`). Backend в одной
 * транзакции удаляет все старые нормы по QTY_PER_ITEM-параметрам
 * категории лекала и пишет новый набор. Параметры, для которых
 * норма не передана, в БД не остаются — это и есть «очистить норму».
 */
export const ReplacePatternItemParameterNormsSchema = z.object({
  norms: z
    .array(ReplacePatternItemParameterNormInputSchema)
    .max(
      200,
      'Слишком много норм фурнитуры: максимум 200 за один запрос',
    )
    .superRefine((arr, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < arr.length; i++) {
        const id = arr[i]!.categoryParameterId;
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'categoryParameterId'],
            message: 'Параметр уже задан в другой строке',
          });
        }
        seen.add(id);
      }
    }),
});
export type ReplacePatternItemParameterNormsDto = z.infer<
  typeof ReplacePatternItemParameterNormsSchema
>;

// ---------------------------------------------------------------------------
// Pattern item size parameter values — этап «Погонные метры по размерам»
// (см. `prisma/schema.prisma::PatternItemSizeParameterValue`,
// `apps/api/src/modules/patterns/patterns.service.ts::replaceSizeParameterValues`,
// `apps/web/app/admin/patterns/[id]/size-parameter-values-form.tsx`).
//
// На MVP таблица используется только для `inputType = LINEAR_M_BY_SIZE`:
// для каждой пары (categoryParameter, размер) хранится численное
// значение (м пог.) + опциональный комментарий + snapshot полей
// параметра категории. Потенциально сюда же можно положить любое
// numeric-by-size значение (например, кг/изделие по размеру) — поле
// `inputTypeSnapshot` различает их.
//
// Не путать с `PatternMaterialArea` (площади м² по AREA_M2_BY_SIZE)
// и `PatternItemParameterNorm` (количество на изделие по
// QTY_PER_ITEM): они остаются отдельными таблицами по принципу
// «одна семантика — одна таблица», не нарушая обратную совместимость
// уже сохранённых данных.
// ---------------------------------------------------------------------------

const SizeParameterValueCommentField = optionalNullableString(
  PATTERN_SIZE_PARAMETER_VALUE_COMMENT_MAX_LENGTH,
  'Комментарий',
);

const SizeParameterValueUnitField = z
  .preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(16, 'Единица не длиннее 16 символов')
      .nullable()
      .optional(),
  );

/**
 * Численное значение «погонные метры по размерам». Принимаем
 * `string | number`, нормализуем к строке с `.` (без локалей),
 * валидируем как положительное число с не более чем 4 знаками после
 * запятой. Возвращаем строку — `Prisma.Decimal` принимает её как
 * есть.
 */
const SizeParameterValueField = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Значение обязательно',
      });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Значение: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Значение должно быть > 0',
      });
      return z.NEVER;
    }
    if (n > PATTERN_SIZE_PARAMETER_VALUE_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Значение выглядит ошибочным: больше ${PATTERN_SIZE_PARAMETER_VALUE_MAX}`,
      });
      return z.NEVER;
    }
    return raw;
  });

/**
 * Одно значение «по размеру для параметра категории». Значения
 * хранятся по `(patternItemId, categoryParameterId, sizeId)`, и
 * именно `categoryParameterId` (а не roleKey) — единица различения:
 * в категории может быть несколько LINEAR_M_BY_SIZE параметров
 * с разными лейблами.
 */
export const ReplacePatternItemSizeParameterValueInputSchema = z.object({
  categoryParameterId: z
    .string()
    .min(1, 'categoryParameterId обязателен'),
  sizeId: z.string().min(1, 'sizeId обязателен'),
  value: SizeParameterValueField,
  unit: SizeParameterValueUnitField,
  comment: SizeParameterValueCommentField,
});
export type ReplacePatternItemSizeParameterValueInputDto = z.infer<
  typeof ReplacePatternItemSizeParameterValueInputSchema
>;

/**
 * Bulk-replace значений «погонных метров по размерам»
 * (`PUT /api/patterns/:id/size-parameter-values`). Backend в одной
 * транзакции удаляет все старые значения по
 * (patternItemId, LINEAR_M_BY_SIZE категорийным параметрам) и пишет
 * новый набор. Параметры, для которых в payload значений нет,
 * остаются без значений — это «очистить».
 */
export const ReplacePatternItemSizeParameterValuesSchema = z.object({
  values: z
    .array(ReplacePatternItemSizeParameterValueInputSchema)
    .max(
      2000,
      'Слишком много значений по размерам: максимум 2000 за один запрос',
    )
    .superRefine((arr, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]!;
        const key = `${v.categoryParameterId}::${v.sizeId}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'sizeId'],
            message:
              'Для одного параметра и размера значение задано дважды',
          });
        }
        seen.add(key);
      }
    }),
});
export type ReplacePatternItemSizeParameterValuesDto = z.infer<
  typeof ReplacePatternItemSizeParameterValuesSchema
>;

// ---------------------------------------------------------------------------
// Clone DTO — этап «Создать номенклатуру по готовому лекалу»
// (см. `apps/api/src/modules/patterns/patterns.service.ts::clone`).
// ---------------------------------------------------------------------------

/**
 * Запрос клонирования существующей номенклатуры в новую.
 *
 * Поля `name` / `article` опциональны: если не заданы, backend сам
 * подберёт значения по исходному лекалу (`{name} (копия)` и первый
 * свободный `{article}-2/3/…`). UI обычно передаёт оба поля
 * предзаполненными, чтобы менеджер мог поправить ещё до создания.
 *
 * Клонируются: `name`/`description`/`categoryCode`/`categoryId`,
 * активные `PatternSizeFile` (DXF копируются физически на диск под
 * новыми `storedFileName`, `version = 1`), все `PatternMaterialArea`,
 * все `PatternItemParameterNorm`, все `PatternItemSizeParameterValue`.
 *
 * НЕ копируется: `previewImageUrl` (превью у новой карточки пустое —
 * менеджер загрузит своё), `legacyProductId` (UNIQUE, создастся по
 * первой ссылке из заказа), связанная `ConstructorTask` (она 1:1 и
 * относится к исходному pattern), архивные `PatternSizeFile`.
 *
 * Результат — `PatternDetailDto` новой номенклатуры со `status = ACTIVE`.
 */
export const ClonePatternSchema = z.object({
  name: NameOptionalField.optional(),
  article: ArticleOptionalField.optional(),
});
export type ClonePatternDto = z.infer<typeof ClonePatternSchema>;

// ---------------------------------------------------------------------------
// Архив номенклатуры: bulk archive / restore / purge
// ---------------------------------------------------------------------------
//
// Контракт повторяет «Архив расчётов цеха» (`@sewing/shared/workshop-needs`,
// `WorkshopNeedsArchiveRequestSchema`): один шейп запроса на три операции,
// частичный успех в ответе. Разница только в единице операции — здесь это
// карточка номенклатуры (`PatternItem`), а признак архива — не отдельное
// поле-дата, а `status = ARCHIVED` (так уже работает карточка
// `/admin/patterns/[id]`, отдельного `archivedAt` в схеме нет).

/**
 * Тело запроса массовых операций архива номенклатуры
 * (`POST /api/patterns/archive` `…/restore` `…/purge`). Точечная
 * операция = массив из одного `patternId`; «Очистить архив» = все
 * видимые id (собирает фронт).
 */
export const PatternsArchiveRequestSchema = z.object({
  patternIds: z.array(z.string().min(1)).min(1).max(1000),
});
export type PatternsArchiveRequestDto = z.infer<
  typeof PatternsArchiveRequestSchema
>;

/** Причина, по которой номенклатура пропущена массовой операцией. */
export const PATTERN_ARCHIVE_SKIP_REASONS = [
  /** Карточки с таким id нет. */
  'NOT_FOUND',
  /** Номенклатура не в архиве — безвозвратное удаление недоступно. */
  'NOT_ARCHIVED',
  /** На номенклатуру ссылаются заказы — удалять навсегда нельзя
   *  (`Order.patternItemId`; заказы хранят по ней историю). */
  'USED_BY_ORDERS',
] as const;
export type PatternArchiveSkipReason =
  (typeof PATTERN_ARCHIVE_SKIP_REASONS)[number];

export const PATTERN_ARCHIVE_SKIP_REASON_LABELS: Record<
  PatternArchiveSkipReason,
  string
> = {
  NOT_FOUND: 'номенклатура не найдена',
  NOT_ARCHIVED: 'номенклатура не в архиве',
  USED_BY_ORDERS: 'номенклатуру используют заказы',
};

export interface PatternArchiveSkipDto {
  patternId: string;
  reason: PatternArchiveSkipReason;
}

/**
 * Результат массовой операции. `processed` — id, к которым операция
 * реально применилась (в т.ч. идемпотентно: архивация уже архивной
 * карточки считается успехом); `skipped` — пропущенные с причиной.
 */
export interface PatternsArchiveResultDto {
  processed: string[];
  skipped: PatternArchiveSkipDto[];
}

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListPatternsQuerySchema = z.object({
  /**
   * Поиск по `name` / `article` / `categoryCode` (case-insensitive
   * `contains`, см. `PatternsService.list`).
   */
  search: z.string().trim().max(100).optional(),
  /**
   * Фильтр по статусу. На MVP принимает любую известную из
   * `PATTERN_ITEM_STATUSES` строку; не задано — все статусы.
   */
  status: PatternItemStatusSchema.optional(),
  /**
   * Фильтр по `categoryId` (этап «Категории номенклатуры»). При
   * наличии возвращаются только карточки с этим `categoryId`. Старые
   * карточки без `categoryId` остаются вне выборки.
   */
  categoryId: z.string().trim().min(1).max(64).optional(),
});
export type ListPatternsQuery = z.infer<typeof ListPatternsQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Краткая ссылка на размер для UI лекал (без всей `SizeDto` —
 * экономия трафика при отображении таблиц по размерам).
 */
export interface PatternSizeRefDto {
  id: string;
  code: string;
  sortOrder: number;
}

export interface PatternSizeFileDto {
  id: string;
  patternItemId: string;
  sizeId: string;
  size: PatternSizeRefDto;
  /** `null`, если размер добавлен без файла (файл догрузят позже). */
  fileUrl: string | null;
  /** `null`, если размер добавлен без файла. */
  originalFileName: string | null;
  version: number;
  status: PatternSizeFileStatus | string;
  uploadedById: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface PatternMaterialAreaDto {
  id: string;
  patternItemId: string;
  sizeId: string;
  size: PatternSizeRefDto;
  materialRole: string;
  /** Decimal как строка (см. `Prisma.Decimal`). */
  areaM2: string;
  comment: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/**
 * Норма «количество на изделие» по параметру категории
 * (`PatternCategoryParameter` с `inputType = QTY_PER_ITEM`).
 * См. `model PatternItemParameterNorm` в Prisma и
 * `apps/web/app/admin/patterns/[id]/parameter-norms-form.tsx`.
 *
 * `roleKey` / `labelSnapshot` / `inputTypeSnapshot` / `unit` —
 * snapshot полей параметра категории на момент сохранения нормы.
 * Они переживают переименование/архивацию параметра — расчёт
 * `WorkshopNeed` по нормам использует именно snapshot.
 */
export interface PatternItemParameterNormDto {
  id: string;
  patternItemId: string;
  categoryParameterId: string;
  /** Snapshot `PatternCategoryParameter.roleKey`. */
  roleKey: string;
  /** Snapshot `PatternCategoryParameter.label`. */
  labelSnapshot: string;
  /** Snapshot `PatternCategoryParameter.inputType` (на MVP всегда QTY_PER_ITEM). */
  inputTypeSnapshot: string;
  /** Единица измерения нормы (по умолчанию «шт» для QTY_PER_ITEM). */
  unit: string;
  /** Decimal как строка (см. `Prisma.Decimal`). */
  qtyPerItem: string;
  comment: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/**
 * Значение «по размеру для параметра категории» в карточке лекала
 * (`PatternItemSizeParameterValue`). На MVP используется только для
 * `inputTypeSnapshot = LINEAR_M_BY_SIZE` (погонные метры),
 * `unit = "м пог."`. Snapshot-поля `roleKey/labelSnapshot/
 * inputTypeSnapshot/unit` фиксируются на момент сохранения и
 * переживают переименование/архивацию параметра — `WorkshopNeedsService`
 * читает именно snapshot.
 */
export interface PatternItemSizeParameterValueDto {
  id: string;
  patternItemId: string;
  categoryParameterId: string;
  sizeId: string;
  size: PatternSizeRefDto;
  /** Snapshot `PatternCategoryParameter.roleKey`. */
  roleKey: string;
  /** Snapshot `PatternCategoryParameter.label`. */
  labelSnapshot: string;
  /** Snapshot `PatternCategoryParameter.inputType` (на MVP LINEAR_M_BY_SIZE). */
  inputTypeSnapshot: string;
  /** Единица измерения значения (для LINEAR_M_BY_SIZE по умолчанию «м пог.»). */
  unit: string;
  /** Decimal как строка (см. `Prisma.Decimal`). */
  value: string;
  comment: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface PatternListItemDto {
  id: string;
  name: string;
  article: string;
  /** Legacy-категория (свободная строка), оставлена ради совместимости. */
  categoryCode: string | null;
  /** Этап «Категории номенклатуры»: FK на `PatternCategory`. */
  categoryId: string | null;
  /** `PatternCategory.name` (если категория задана). */
  categoryName: string | null;
  /** `PatternCategory.slug`. */
  categorySlug: string | null;
  /**
   * Legacy: `PatternCategory.iconKey` (whitelist в
   * `PATTERN_CATEGORY_ICON_KEYS`). UI использует только как fallback,
   * если `categoryIconImageUrl` пуст.
   */
  categoryIconKey: PatternCategoryIconKey | string | null;
  /**
   * Загруженная JPEG-иконка категории (`PatternCategory.iconImageUrl`).
   * Основной источник иконки в новых UI (фильтры/чипсы/формы);
   * `null` → fallback на `categoryIconKey` (lucide).
   */
  categoryIconImageUrl: string | null;
  /** `PatternCategory.status`. */
  categoryStatus: PatternCategoryStatus | string | null;
  previewImageUrl: string | null;
  /** Произвольная строка статуса. UI лейблит через `PATTERN_ITEM_STATUS_LABELS`. */
  status: string;
  description: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  /** Сколько активных DXF-файлов сейчас прицеплено. */
  sizeFilesCount: number;
  /** Сколько строк площадей материалов записано. */
  materialAreasCount: number;
  /**
   * Сколько строк в спецификации «Материалы» (`PatternItemMaterialLine`).
   * `0` = заказ на эту номенклатуру не уйдёт в расчёт
   * (`ORDER_TECH_CARD_REQUIRED`) — мастер создания заказа предупреждает
   * об этом на шаге «Изделие», не дожидаясь ошибки бэкенда.
   */
  materialSpecLinesCount: number;
  /**
   * Краткий список размеров, по которым уже есть активный DXF.
   * Отсортирован по `Size.sortOrder`. Используется в списке — чтобы
   * менеджер видел, по каким размерам лекало готово, не открывая
   * карточку.
   */
  sizes: PatternSizeRefDto[];
}

export interface PatternDetailDto {
  id: string;
  name: string;
  article: string;
  /** Legacy-категория (свободная строка), оставлена ради совместимости. */
  categoryCode: string | null;
  /**
   * FK на `PatternCategory` (этап «Категории номенклатуры»). UI
   * «Площади материалов» строится по `category.parameters` с
   * `inputType = AREA_M2_BY_SIZE`.
   */
  categoryId: string | null;
  category: PatternCategoryDto | null;
  /**
   * Удобный «срез» активных параметров категории — те, по которым
   * вводится площадь. Дублирует `category.parameters.filter(...)`,
   * чтобы клиенту не пришлось повторять ту же логику в нескольких
   * местах.
   */
  categoryAreaParameters: PatternCategoryParameterDto[];
  previewImageUrl: string | null;
  status: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  sizeFiles: PatternSizeFileDto[];
  materialAreas: PatternMaterialAreaDto[];
  /**
   * Этап «Фурнитура и нормы»: список сохранённых норм «количество
   * на изделие» по параметрам категории с `inputType = QTY_PER_ITEM`.
   * Пустой массив, если у лекала нет категории или норм ещё не было.
   * UI блока «Фурнитура и нормы» комбинирует этот список с
   * `category.parameters.filter(inputType === 'QTY_PER_ITEM')` —
   * параметры дают список «строк формы», а нормы — текущие значения.
   */
  parameterNorms: PatternItemParameterNormDto[];
  /**
   * Этап «Погонные метры по размерам»: список сохранённых значений
   * `PatternItemSizeParameterValue` для параметров категории с
   * `inputType = LINEAR_M_BY_SIZE`. Пустой массив, если у лекала
   * нет категории, нет таких параметров или значений ещё не было.
   * UI блока «Погонные метры» комбинирует этот список с
   * `category.parameters.filter(inputType === 'LINEAR_M_BY_SIZE')` —
   * параметры дают столбцы, а значения — содержимое ячеек по размерам.
   */
  sizeParameterValues: PatternItemSizeParameterValueDto[];
  /**
   * Этап 1 плана «техкарты → номенклатура»: состав материалов изделия
   * (строки `PatternItemMaterialLine`) + слоты-параметры спецификации
   * (`PatternItemSpecParameter`). Опционально (`?`) — старые потребители
   * shared продолжают компилироваться без пересборки; backend всегда
   * отдаёт массивы (пустые, если спецификация не заведена).
   */
  materialSpecLines?: PatternItemMaterialLineDto[];
  specParameters?: PatternItemSpecParameterDto[];
  /**
   * Этап «Конструкторское бюро»: связанная задача `ConstructorTask`,
   * если pattern был создан через flow «Отправить конструктору». UI
   * на `/admin/patterns/[id]` показывает карточку «Источник» со
   * ссылкой на `/admin/constructor-tasks/[id]`. `null` для лекал,
   * созданных вручную.
   *
   * Опционально (`?`) — старые потребители без пересборки shared
   * продолжают компилироваться. Backend всегда отдаёт значение.
   */
  constructorTask?: ConstructorTaskSummaryDto | null;
}
