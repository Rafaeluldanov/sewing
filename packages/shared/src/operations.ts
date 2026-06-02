/**
 * Контракты модуля «Операции» (управленческий блок).
 *
 * Источник истины — backend (`/api/operations`). Введён вместе с
 * экраном `/admin/operations` (см. `docs/domain.md §16a`,
 * `docs/api.md §15a`, `docs/screens.md §10c`).
 *
 * Скоуп MVP сознательно ограничен:
 *   - три тарифных режима (FIXED | BY_SIZE | SALARY_ONLY);
 *   - для FIXED — одна ставка `fixedRate`;
 *   - для BY_SIZE — таблица `(sizeId, rate)`;
 *   - для SALARY_ONLY — ставка не задаётся и не используется
 *     `EarningsService`.
 *
 * За рамками MVP (сознательно):
 *   - история ставок по датам;
 *   - ставки по сотруднику / складу / селлеру;
 *   - матрица «продукт × размер».
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma)
// ---------------------------------------------------------------------------

export const PRICING_MODES = ['FIXED', 'BY_SIZE', 'SALARY_ONLY'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export const OPERATION_CATEGORIES = [
  'CUTTING',
  'SEWING',
  'QC',
  'IRONING',
  'PACKING',
] as const;
export type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Категории операций — единый источник истины для UI
// ---------------------------------------------------------------------------

/**
 * Канонический порядок категорий операций для всех списков и группировок.
 *
 * Совпадает с физическим порядком производственного потока: раскрой →
 * пошив → ОТК → ВТО → упаковка. UI обязан сортировать группы операций
 * и оборудования по этому порядку, чтобы пользователь видел одно и то
 * же расположение и в `/admin/operations`, и в `/admin/equipment`,
 * и в форме маршрута.
 *
 * Не дублировать на стороне web — импортировать отсюда.
 */
export const OPERATION_CATEGORY_ORDER: readonly OperationCategory[] = [
  'CUTTING',
  'SEWING',
  'QC',
  'IRONING',
  'PACKING',
];

/**
 * Человекочитаемые лейблы категорий операций. Используются всеми
 * админ-страницами, формами и группировками. Если нужен короткий
 * лейбл (например, в чипе) — берём строки отсюда без сокращений.
 */
export const OPERATION_CATEGORY_LABELS: Record<OperationCategory, string> = {
  CUTTING: 'Раскрой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

/**
 * Спец-«категория», в которую попадают операции/оборудование без
 * валидной `OperationCategory`. UI рисует её последней группой и
 * подписывает «Без категории». Никаких манипуляций с Prisma — это
 * чисто презентационный слой.
 */
export const UNKNOWN_OPERATION_CATEGORY = 'UNKNOWN' as const;
export type GroupCategoryKey = OperationCategory | typeof UNKNOWN_OPERATION_CATEGORY;

const GROUP_LABELS: Record<GroupCategoryKey, string> = {
  ...OPERATION_CATEGORY_LABELS,
  [UNKNOWN_OPERATION_CATEGORY]: 'Без категории',
};

/**
 * Лейбл категории операции для UI. Принимает любые входные значения
 * (включая `null`/`undefined`/неизвестные строки) — для всего, что
 * не входит в `OPERATION_CATEGORIES`, возвращается «Без категории».
 *
 * Используется напрямую в шапках групп и подписях. Старый
 * `formatOperationCategory` в `apps/web/lib/admin-labels.ts`
 * вызывает этот же helper — единая точка истины.
 */
export function getOperationCategoryLabel(
  category: string | null | undefined,
): string {
  if (!category) return GROUP_LABELS[UNKNOWN_OPERATION_CATEGORY];
  return (
    GROUP_LABELS[category as GroupCategoryKey] ??
    GROUP_LABELS[UNKNOWN_OPERATION_CATEGORY]
  );
}

/**
 * Сортирует список категорий по `OPERATION_CATEGORY_ORDER`.
 * Категории, которых нет в каноне (включая `UNKNOWN`), уходят в
 * хвост в порядке появления.
 */
export function sortOperationCategories<T extends string>(
  categories: readonly T[],
): T[] {
  const index = new Map<string, number>();
  OPERATION_CATEGORY_ORDER.forEach((c, i) => index.set(c, i));
  index.set(UNKNOWN_OPERATION_CATEGORY, OPERATION_CATEGORY_ORDER.length);
  return [...categories].sort((a, b) => {
    const ai = index.has(a) ? index.get(a)! : Number.MAX_SAFE_INTEGER;
    const bi = index.has(b) ? index.get(b)! : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

function normalizeCategory(category: string | null | undefined): GroupCategoryKey {
  if (!category) return UNKNOWN_OPERATION_CATEGORY;
  if ((OPERATION_CATEGORIES as readonly string[]).includes(category)) {
    return category as OperationCategory;
  }
  return UNKNOWN_OPERATION_CATEGORY;
}

/** Минимальная форма операции, по которой можно построить группу. */
export interface GroupableOperation {
  id: string;
  name: string;
  category: OperationCategory | string | null | undefined;
}

export interface OperationCategoryGroup<T extends GroupableOperation> {
  category: GroupCategoryKey;
  label: string;
  operations: T[];
}

/**
 * Группирует операции по категориям и возвращает группы в каноническом
 * порядке (`OPERATION_CATEGORY_ORDER` + `Без категории` в конце).
 *
 * Группы без операций в результат не попадают — UI рисует только то,
 * что не пусто. Внутри группы порядок входных операций сохраняется,
 * чтобы вызывающая сторона могла предварительно отсортировать их по
 * `sortOrder` / `name`.
 */
export function groupOperationsByCategory<T extends GroupableOperation>(
  operations: readonly T[],
): OperationCategoryGroup<T>[] {
  const buckets = new Map<GroupCategoryKey, T[]>();
  for (const op of operations) {
    const key = normalizeCategory(op.category);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(op);
    else buckets.set(key, [op]);
  }
  const order: GroupCategoryKey[] = [
    ...OPERATION_CATEGORY_ORDER,
    UNKNOWN_OPERATION_CATEGORY,
  ];
  const groups: OperationCategoryGroup<T>[] = [];
  for (const key of order) {
    const items = buckets.get(key);
    if (!items || items.length === 0) continue;
    groups.push({
      category: key,
      label: GROUP_LABELS[key],
      operations: items,
    });
  }
  return groups;
}

/** Форма оборудования для группировки по категориям связанных операций. */
export interface GroupableEquipment {
  id: string;
  name: string;
  operations?: ReadonlyArray<{
    id?: string;
    name?: string;
    category: OperationCategory | string | null | undefined;
  }>;
}

export interface EquipmentCategoryGroup<T extends GroupableEquipment> {
  /** `UNKNOWN` зарезервирован под «Без операций» (см. `label`). */
  category: GroupCategoryKey;
  label: string;
  equipment: T[];
}

/**
 * Возвращает «первичную» категорию оборудования для группировки в
 * списках. Это первая по `OPERATION_CATEGORY_ORDER` категория среди
 * связанных операций; если связанных операций нет — `null`.
 *
 * Используется для admin-list, где оборудование не дублируется по
 * группам (см. ТЗ §6) — каждая единица показывается ровно один раз
 * в primary-группе, а полный список её категорий рисуется чипами.
 */
export function getPrimaryEquipmentCategory(
  equipment: GroupableEquipment,
): OperationCategory | null {
  if (!equipment.operations || equipment.operations.length === 0) return null;
  const seen = new Set<OperationCategory>();
  for (const op of equipment.operations) {
    const key = normalizeCategory(op.category);
    if (key !== UNKNOWN_OPERATION_CATEGORY) seen.add(key);
  }
  if (seen.size === 0) return null;
  for (const c of OPERATION_CATEGORY_ORDER) {
    if (seen.has(c)) return c;
  }
  return null;
}

/**
 * Возвращает все уникальные категории связанных с оборудованием
 * операций в каноническом порядке. Используется для chip-списка в
 * admin-list (см. ТЗ §6) и для проверки «несколько категорий».
 */
export function getEquipmentCategories(
  equipment: GroupableEquipment,
): OperationCategory[] {
  const seen = new Set<OperationCategory>();
  for (const op of equipment.operations ?? []) {
    const key = normalizeCategory(op.category);
    if (key !== UNKNOWN_OPERATION_CATEGORY) seen.add(key);
  }
  const result: OperationCategory[] = [];
  for (const c of OPERATION_CATEGORY_ORDER) {
    if (seen.has(c)) result.push(c);
  }
  return result;
}

/**
 * Группирует оборудование по primary-категории связанных операций
 * (см. `getPrimaryEquipmentCategory`). Оборудование без операций
 * попадает в специальную группу с label «Без операций».
 *
 * Контракт намеренно «не дублирует» строки: каждая единица
 * оборудования встречается в результате ровно один раз. Если нужно
 * показать все категории — берём `getEquipmentCategories(eq)` и
 * рисуем чипы рядом с именем.
 *
 * Группы без оборудования в результат не попадают; canonical-порядок
 * сохраняется. Группа «Без операций» всегда последняя.
 */
export function groupEquipmentByOperationCategory<T extends GroupableEquipment>(
  equipmentList: readonly T[],
): EquipmentCategoryGroup<T>[] {
  const buckets = new Map<GroupCategoryKey, T[]>();
  for (const eq of equipmentList) {
    const primary = getPrimaryEquipmentCategory(eq);
    const key: GroupCategoryKey = primary ?? UNKNOWN_OPERATION_CATEGORY;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(eq);
    else buckets.set(key, [eq]);
  }
  const order: GroupCategoryKey[] = [
    ...OPERATION_CATEGORY_ORDER,
    UNKNOWN_OPERATION_CATEGORY,
  ];
  const groups: EquipmentCategoryGroup<T>[] = [];
  for (const key of order) {
    const items = buckets.get(key);
    if (!items || items.length === 0) continue;
    groups.push({
      category: key,
      label:
        key === UNKNOWN_OPERATION_CATEGORY
          ? 'Без операций'
          : GROUP_LABELS[key],
      equipment: items,
    });
  }
  return groups;
}

/**
 * Режимы плановой нормы времени операции (см.
 * `docs/operation-time-norms-recon.md §10`).
 *
 * Это **отдельная ось** от `PricingMode` (которая управляет тарифом /
 * деньгами). Операция может одновременно быть `SALARY_ONLY` по
 * деньгам, но иметь плановую норму времени `BY_SIZE`. Смешивать оси
 * в одной таблице нельзя — payroll читает только rate-axis (см.
 * `OperationsService.resolveRate`).
 *
 *   - `FIXED`   — одна норма на операцию (`Operation.timeNormSec`);
 *   - `BY_SIZE` — поразмерная матрица (`OperationTimeNormBySize`).
 */
export const TIME_NORM_MODES = ['FIXED', 'BY_SIZE'] as const;
export type TimeNormMode = (typeof TIME_NORM_MODES)[number];

/** Лейблы для UI (см. `/admin/operations/[id]`). */
export const TIME_NORM_MODE_LABELS: Record<TimeNormMode, string> = {
  FIXED: 'Единая норма',
  BY_SIZE: 'По размерам',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Денежная ставка `Decimal(12,2)` в виде числа. Принимаем `number`
 * или строку (форма легко отдаёт строки), нормализуем до неотрицательного
 * с двумя знаками после запятой. Защита от NaN/Infinity и слишком
 * больших значений (16-bit money — это ~99999.99, нам с запасом хватит
 * `< 10_000_000`, что укладывается в `Decimal(12,2)`).
 */
const RateField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка должна быть числом',
      });
      return z.NEVER;
    }
    if (num < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка не может быть отрицательной',
      });
      return z.NEVER;
    }
    if (num >= 10_000_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ставка слишком большая',
      });
      return z.NEVER;
    }
    return Math.round(num * 100) / 100;
  });

/**
 * Норма времени в секундах. Принимаем `number` или строку (форма легко
 * отдаёт строки), нормализуем до целого ≥ 0. Защита от NaN/Infinity и
 * слишком больших значений (24 часа = 86400 секунд; даём с запасом
 * `< 1_000_000` ~ 11.5 суток на единицу — управленческий «потолок»).
 *
 * Возвращает целое число секунд. `0` допустим формально, но
 * superRefine на схемах ниже трактует его как «норма не задана» и
 * требует `> 0` для строк `timeNormsBySize`.
 */
const TimeNormSecondsField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num =
      typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма времени должна быть числом',
      });
      return z.NEVER;
    }
    if (num < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма времени не может быть отрицательной',
      });
      return z.NEVER;
    }
    if (num >= 1_000_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма времени слишком большая',
      });
      return z.NEVER;
    }
    return Math.floor(num);
  });

/**
 * Длительность «расчётной смены» для плановой окладной стоимости
 * операции. В секундах, целое > 0. Default в БД = `28800` (8 часов);
 * фронт поле тоже передаёт по умолчанию 8 часов.
 *
 * Реалистичный «потолок» — 24 часа = `86400`, с запасом — 48 часов
 * (`172_800`). Больше — почти наверняка ошибка ввода (менеджер ввёл
 * минуты вместо секунд и т.п.).
 */
const SalaryPlanShiftSecondsField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num =
      typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Длительность смены должна быть числом',
      });
      return z.NEVER;
    }
    if (num <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Длительность смены должна быть больше 0',
      });
      return z.NEVER;
    }
    if (num > 172_800) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Длительность смены слишком большая (макс. 48 часов)',
      });
      return z.NEVER;
    }
    return Math.floor(num);
  });

/**
 * Плановая стоимость смены, ₽. Та же семантика, что у `RateField`,
 * но с явным запретом «0»: 0 ₽/смена эквивалентен «не задано» и
 * сбивает пользователя с толку. `null`-вариант обрабатывается на
 * уровне union в Create/UpdateOperationSchema.
 */
const SalaryPlanRubField = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const num = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
    if (!Number.isFinite(num)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Плановая стоимость смены должна быть числом',
      });
      return z.NEVER;
    }
    if (num <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Плановая стоимость смены должна быть больше 0',
      });
      return z.NEVER;
    }
    if (num >= 100_000_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Плановая стоимость смены слишком большая',
      });
      return z.NEVER;
    }
    return Math.round(num * 100) / 100;
  });

const CodeField = z
  .string()
  .trim()
  .min(1, 'Код операции обязателен')
  .max(64, 'Код слишком длинный (макс. 64 символа)')
  .regex(
    /^[A-Z0-9_]+$/,
    'Код операции — только латинские заглавные буквы, цифры и подчёркивание',
  );

const NameField = z
  .string()
  .trim()
  .min(1, 'Название операции обязательно')
  .max(120, 'Название слишком длинное');

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/operations`.
 *
 * Принципы валидации:
 *   - `pricingMode` обязателен — менеджер выбирает «как платить»
 *     явно, чтобы UI/backend не угадывали;
 *   - для `FIXED` обязателен `fixedRate`; для `BY_SIZE` принимаем
 *     опциональный `ratesBySize`, чтобы можно было одной ручкой
 *     создать операцию вместе со ставками; для `SALARY_ONLY` —
 *     ничего из ставок не принимаем.
 */
export const CreateOperationSchema = z
  .object({
    code: CodeField,
    name: NameField,
    category: z.enum(OPERATION_CATEGORIES),
    pricingMode: z.enum(PRICING_MODES),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    fixedRate: RateField.optional(),
    ratesBySize: z
      .array(
        z.object({
          sizeId: z.string().min(1, 'sizeId обязателен'),
          rate: RateField,
        }),
      )
      .optional(),
    /**
     * Режим плановой нормы времени (см. `TIME_NORM_MODES`). Опционально:
     * на старых клиентах поле отсутствует — backend проставит default
     * `'FIXED'`. Это **отдельная ось** от `pricingMode`.
     */
    timeNormMode: z.enum(TIME_NORM_MODES).optional(),
    /**
     * Фиксированная норма времени в секундах для `timeNormMode = 'FIXED'`.
     * `null` или отсутствие — норма не задана. Для `timeNormMode =
     * 'BY_SIZE'` должно быть `null`/`undefined`.
     */
    timeNormSec: z.union([TimeNormSecondsField, z.null()]).optional(),
    /**
     * Поразмерная матрица плановых норм времени (replace-all).
     * Только для `timeNormMode = 'BY_SIZE'`. `seconds` обязан быть `> 0`.
     */
    timeNormsBySize: z
      .array(
        z.object({
          sizeId: z.string().min(1, 'sizeId обязателен'),
          seconds: TimeNormSecondsField,
        }),
      )
      .optional(),
    /**
     * Плановая стоимость одной смены, ₽. Используется в
     * `OrderOperationPlanService` для расчёта плановой себестоимости
     * окладных операций (`pricingMode = SALARY_ONLY`):
     * `cost = timeSec × (salaryPlanRubPerShift / salaryPlanShiftSeconds) × qty`.
     *
     * Это **не фактическая зарплата** — payroll (`SalaryService`,
     * `EarningsService`, `Employee.salaryPerShift`) этого поля
     * не читает. Для FIXED/BY_SIZE поле тоже допустимо, но
     * `OrderOperationPlanService` его не использует — там цена
     * считается по сдельной ставке.
     */
    salaryPlanRubPerShift: z
      .union([SalaryPlanRubField, z.null()])
      .optional(),
    /**
     * Длительность «расчётной смены» в секундах. Default = 28800
     * (8 часов). Целое > 0. Если поле опущено, backend сохраняет
     * default 28800. Меньше 0 / NaN отбрасывается на этапе валидации.
     */
    salaryPlanShiftSeconds: z
      .union([SalaryPlanShiftSecondsField, z.null()])
      .optional(),
    /**
     * Признак «операция выпускает готовую продукцию» (см.
     * `prisma/schema.prisma::Operation.producesFinishedGoods`,
     * `apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx`).
     *
     * Если `true`, при успешном прохождении этой операции по паспорту
     * создаётся `FinishedGoodsMovement` `type = PRODUCTION_RECEIPT IN`
     * (склад `Order.finishedGoodsWarehouseId`, идемпотентно по
     * `sourceKey = PACKED_PASSPORT:<passportId>` — последующая упаковка
     * не задвоит движение). Опционально на старых клиентах — backend
     * проставит default `false`.
     */
    producesFinishedGoods: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.pricingMode === 'FIXED') {
      if (data.fixedRate === undefined) {
        ctx.addIssue({
          path: ['fixedRate'],
          code: z.ZodIssueCode.custom,
          message: 'Для FIXED укажите фиксированную ставку',
        });
      }
      if (data.ratesBySize && data.ratesBySize.length > 0) {
        ctx.addIssue({
          path: ['ratesBySize'],
          code: z.ZodIssueCode.custom,
          message:
            'Для FIXED ставки по размерам не задаются — используйте fixedRate',
        });
      }
    }
    if (data.pricingMode === 'BY_SIZE') {
      if (data.fixedRate !== undefined) {
        ctx.addIssue({
          path: ['fixedRate'],
          code: z.ZodIssueCode.custom,
          message:
            'Для BY_SIZE fixedRate не используется — задайте ставки по размерам',
        });
      }
    }
    if (data.pricingMode === 'SALARY_ONLY') {
      if (data.fixedRate !== undefined) {
        ctx.addIssue({
          path: ['fixedRate'],
          code: z.ZodIssueCode.custom,
          message: 'Для SALARY_ONLY ставка не задаётся',
        });
      }
      if (data.ratesBySize && data.ratesBySize.length > 0) {
        ctx.addIssue({
          path: ['ratesBySize'],
          code: z.ZodIssueCode.custom,
          message: 'Для SALARY_ONLY ставки по размерам не задаются',
        });
      }
    }

    // Согласованность нормы времени с её режимом (отдельно от тарифа).
    const timeMode: TimeNormMode = data.timeNormMode ?? 'FIXED';
    if (timeMode === 'FIXED') {
      if (data.timeNormsBySize && data.timeNormsBySize.length > 0) {
        ctx.addIssue({
          path: ['timeNormsBySize'],
          code: z.ZodIssueCode.custom,
          message:
            'Для режима «Единая норма» поразмерные нормы не задаются',
        });
      }
    } else {
      if (data.timeNormSec !== undefined && data.timeNormSec !== null) {
        ctx.addIssue({
          path: ['timeNormSec'],
          code: z.ZodIssueCode.custom,
          message:
            'Для режима «По размерам» единая норма не используется',
        });
      }
    }
    if (data.timeNormsBySize) {
      const seen = new Set<string>();
      for (const r of data.timeNormsBySize) {
        if (seen.has(r.sizeId)) {
          ctx.addIssue({
            path: ['timeNormsBySize'],
            code: z.ZodIssueCode.custom,
            message: `Размер передан дважды: ${r.sizeId}`,
          });
        }
        seen.add(r.sizeId);
        if (!Number.isFinite(r.seconds) || r.seconds <= 0) {
          ctx.addIssue({
            path: ['timeNormsBySize'],
            code: z.ZodIssueCode.custom,
            message: 'Норма времени по размеру должна быть > 0',
          });
        }
      }
    }
  });
export type CreateOperationDto = z.infer<typeof CreateOperationSchema>;

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

/**
 * Тело `PATCH /api/operations/:id`.
 *
 * Любое поле опционально, но хотя бы одно должно прийти. Смена
 * `pricingMode` разрешена и обрабатывается атомарно:
 *   - `FIXED` ← *: сервис очищает `OperationRateBySize` и проставляет
 *     `fixedRate`;
 *   - `BY_SIZE` ← *: `fixedRate` обнуляется; если в теле передан
 *     `ratesBySize` — он перезаписывает таблицу (см.
 *     `OperationsService.update`);
 *   - `SALARY_ONLY` ← *: `fixedRate` и все `OperationRateBySize`
 *     очищаются.
 *
 * Отдельная массовая загрузка ставок по размерам — там же, в этом
 * PATCH (через `ratesBySize`); это сознательно, чтобы менеджер мог
 * одной кнопкой «Сохранить» применить весь экран. Отдельной ручки
 * `PATCH /api/operations/:id/rates` не делаем (см. ADR в комментарии
 * `docs/domain.md §16a`).
 */
export const UpdateOperationSchema = z
  .object({
    name: NameField.optional(),
    category: z.enum(OPERATION_CATEGORIES).optional(),
    pricingMode: z.enum(PRICING_MODES).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    /** `null` → очистить fixedRate (валидно только при `FIXED → *`). */
    fixedRate: z.union([RateField, z.null()]).optional(),
    /**
     * Полный набор ставок по размерам (replace-all, не merge).
     * `[]` явно очищает все ставки (полезно при переходе из BY_SIZE
     * в FIXED/SALARY_ONLY одной транзакцией). Уникальность `sizeId`
     * валидируется бэкендом — проще держать массив на клиенте.
     */
    ratesBySize: z
      .array(
        z.object({
          sizeId: z.string().min(1, 'sizeId обязателен'),
          rate: RateField,
        }),
      )
      .optional(),
    /**
     * Режим плановой нормы времени. Если не пришёл — текущий режим
     * операции остаётся без изменений (сервис не трогает поле).
     */
    timeNormMode: z.enum(TIME_NORM_MODES).optional(),
    /**
     * `null` → очистить единую норму. При смене режима в `BY_SIZE`
     * сервис сам обнуляет `timeNormSec`.
     */
    timeNormSec: z.union([TimeNormSecondsField, z.null()]).optional(),
    /**
     * Полный набор поразмерных норм (replace-all). `[]` — стереть всё.
     * Только для режима `BY_SIZE`; для `FIXED` сервис сам очистит таблицу.
     */
    timeNormsBySize: z
      .array(
        z.object({
          sizeId: z.string().min(1, 'sizeId обязателен'),
          seconds: TimeNormSecondsField,
        }),
      )
      .optional(),
    /**
     * `null` → очистить плановую окладную ставку (план для окладных
     * операций пропадёт, `OrderOperationPlanService` будет писать
     * `cost = 0` + warning).
     *
     * Это **отдельная ось** от `pricingMode` и `timeNormMode`:
     * payroll (`Employee.salaryPerShift`, `SalaryEntry`,
     * `OperationEntry`) этого поля не читает.
     */
    salaryPlanRubPerShift: z
      .union([SalaryPlanRubField, z.null()])
      .optional(),
    /**
     * `null` → сбросить длительность расчётной смены (бэкенд вернёт
     * default 28800 при сохранении). Если ставка задана, но
     * длительность сброшена — backend проставит default 28800.
     */
    salaryPlanShiftSeconds: z
      .union([SalaryPlanShiftSecondsField, z.null()])
      .optional(),
    /**
     * Признак «операция выпускает готовую продукцию» (см. в
     * `CreateOperationSchema`). При смене на `true` будущие
     * прохождения этой операции по паспорту начнут создавать
     * `FinishedGoodsMovement PRODUCTION_RECEIPT IN`. Уже выпущенные
     * паспорты не пересоздаются — идемпотентность по
     * `sourceKey = PACKED_PASSPORT:<passportId>`.
     */
    producesFinishedGoods: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // Если режим явно указан — валидируем согласованность; иначе
    // финальную проверку делает сервис, у которого есть текущий режим
    // из БД.
    if (data.timeNormMode !== undefined) {
      if (data.timeNormMode === 'FIXED') {
        if (data.timeNormsBySize && data.timeNormsBySize.length > 0) {
          ctx.addIssue({
            path: ['timeNormsBySize'],
            code: z.ZodIssueCode.custom,
            message:
              'Для режима «Единая норма» поразмерные нормы не задаются',
          });
        }
      } else if (data.timeNormMode === 'BY_SIZE') {
        if (data.timeNormSec !== undefined && data.timeNormSec !== null) {
          ctx.addIssue({
            path: ['timeNormSec'],
            code: z.ZodIssueCode.custom,
            message:
              'Для режима «По размерам» единая норма не используется',
          });
        }
      }
    }
    if (data.timeNormsBySize) {
      const seen = new Set<string>();
      for (const r of data.timeNormsBySize) {
        if (seen.has(r.sizeId)) {
          ctx.addIssue({
            path: ['timeNormsBySize'],
            code: z.ZodIssueCode.custom,
            message: `Размер передан дважды: ${r.sizeId}`,
          });
        }
        seen.add(r.sizeId);
        if (!Number.isFinite(r.seconds) || r.seconds <= 0) {
          ctx.addIssue({
            path: ['timeNormsBySize'],
            code: z.ZodIssueCode.custom,
            message: 'Норма времени по размеру должна быть > 0',
          });
        }
      }
    }
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.category !== undefined ||
      obj.pricingMode !== undefined ||
      obj.isActive !== undefined ||
      obj.sortOrder !== undefined ||
      obj.fixedRate !== undefined ||
      obj.ratesBySize !== undefined ||
      obj.timeNormMode !== undefined ||
      obj.timeNormSec !== undefined ||
      obj.timeNormsBySize !== undefined ||
      obj.salaryPlanRubPerShift !== undefined ||
      obj.salaryPlanShiftSeconds !== undefined ||
      obj.producesFinishedGoods !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateOperationDto = z.infer<typeof UpdateOperationSchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface OperationRateBySizeDto {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  /** Ставка за единицу (число, две цифры после запятой). */
  rate: number;
}

/**
 * Поразмерная плановая норма времени (см. `OperationTimeNormBySize`).
 * Возвращается из `OperationDetailDto.timeNormsBySize`. Хранится в
 * секундах; UI вводит «мин:сек» (см. helpers в `lib/operations-time-norm.ts`).
 */
export interface OperationTimeNormBySizeDto {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  /** Норма времени в секундах (целое, > 0). */
  seconds: number;
}

/** Сжатый список для экрана `/admin/operations`. */
export interface OperationSummaryDto {
  id: string;
  code: string;
  name: string;
  category: OperationCategory;
  pricingMode: PricingMode;
  /** Для FIXED — собственно ставка; для BY_SIZE/SALARY_ONLY — `null`. */
  fixedRate: number | null;
  /** Для BY_SIZE — сколько строк ставок задано; иначе `0`. */
  ratesBySizeCount: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Режим плановой нормы времени операции (см. `TIME_NORM_MODES`).
   * Default `'FIXED'` — старые операции до миграции получают его в
   * `prisma/migrations/.../add_operation_time_norms`.
   */
  timeNormMode: TimeNormMode;
  /**
   * Норма времени в секундах для `timeNormMode = 'FIXED'`. Для
   * `BY_SIZE` или если норма не задана — `null`. UI рисует «—».
   */
  timeNormSec: number | null;
  /** Для BY_SIZE — сколько строк норм времени задано; иначе `0`. */
  timeNormsBySizeCount: number;
  /**
   * Плановая стоимость одной смены, ₽ (`Decimal(14,2)` сериализуется в
   * `number`). `null` — плановая окладная ставка не задана; для
   * окладных операций (`pricingMode = SALARY_ONLY`) это означает,
   * что `OrderOperationPlanService` посчитает `cost = 0` + warning.
   *
   * Не путать с `Employee.salaryPerShift` (фактический payroll).
   */
  salaryPlanRubPerShift: number | null;
  /**
   * Длительность «расчётной смены» в секундах (default `28800` =
   * 8 часов). Никогда не равно `null` для свежих операций — БД
   * возвращает default; nullable оставлено для обратной совместимости
   * со старыми строками, у которых поле могло остаться `NULL` до
   * первого сохранения.
   */
  salaryPlanShiftSeconds: number | null;
  /**
   * Признак «операция выпускает готовую продукцию» (см.
   * `prisma/schema.prisma::Operation.producesFinishedGoods`).
   *
   * При успешном прохождении такой операции по паспорту backend
   * создаёт `FinishedGoodsMovement PRODUCTION_RECEIPT IN` на склад
   * `Order.finishedGoodsWarehouseId`. Default `false` — операция
   * не считается выпускной, пока менеджер явно не включит признак.
   */
  producesFinishedGoods: boolean;
}

/** Карточка операции `GET /api/operations/:id`. */
export interface OperationDetailDto extends OperationSummaryDto {
  /** Полный список ставок по размерам (для BY_SIZE; иначе пустой). */
  ratesBySize: OperationRateBySizeDto[];
  /**
   * Полный список плановых норм времени по размерам (для BY_SIZE;
   * иначе пустой). Источник истины — `OperationTimeNormBySize`.
   */
  timeNormsBySize: OperationTimeNormBySizeDto[];
  /**
   * Все размеры из справочника, отсортированные по `sortOrder`.
   * Удобно для UI: один источник истины «какие размеры существуют»,
   * чтобы фронт не делал отдельный запрос к `/catalog/sizes`.
   */
  sizes: Array<{ id: string; code: string; sortOrder: number }>;
}

// ---------------------------------------------------------------------------
// Удаление операции (blockers)
// ---------------------------------------------------------------------------

/**
 * Виды ссылок, которые блокируют физическое удаление операции
 * (`DELETE /api/operations/:id`). Каждый соответствует обратной
 * связи в `prisma/schema.prisma::Operation`:
 *
 *   - `OperationEntry`         — сдельные начисления (зарплатная история);
 *   - `PassportEvent`          — события паспортов (аудит-история; считаем
 *                                и `operationId`, и `fromOperationId`);
 *   - `OrderRouteStep`         — шаги в маршрутах заказов;
 *   - `RouteTemplateStep`      — шаги в шаблонах маршрутов;
 *   - `ShiftSession`           — смены, открытые на этой операции;
 *   - `CurrentPassport`        — паспорта, стоящие на этой операции сейчас
 *                                (`Passport.currentOperationId`);
 *   - `MasterCall`             — вызовы мастера, привязанные к операции;
 *   - `OperationSubstitution`  — substitute-правила параллельной группы.
 *
 * Конфигурация, у которой в схеме стоит `onDelete: Cascade`
 * (`OperationRateBySize`, `OperationTimeNormBySize`,
 * `EquipmentOperation`), в блокеры НЕ входит — она снимается каскадно
 * вместе с операцией. `OperationSubstitution` тоже каскадная, но мы
 * выносим её в блокеры сознательно: молча оборвать substitute-правило
 * AND-гейта опаснее, чем тариф, поэтому менеджер должен увидеть его и
 * принять решение.
 */
export const OPERATION_DELETE_BLOCKER_KINDS = [
  'OperationEntry',
  'PassportEvent',
  'OrderRouteStep',
  'RouteTemplateStep',
  'ShiftSession',
  'CurrentPassport',
  'MasterCall',
  'OperationSubstitution',
] as const;
export type OperationDeleteBlockerKind =
  (typeof OPERATION_DELETE_BLOCKER_KINDS)[number];

export interface OperationDeleteBlockerDto {
  kind: OperationDeleteBlockerKind;
  count: number;
}

/**
 * Превью «можно ли физически удалить операцию» (`GET
 * /api/operations/:id/blockers`). UI на основе этого решает, показать
 * ли кнопку «Удалить» (hard) или только «Деактивировать» (soft).
 * Backend пересчитывает то же самое при самом `DELETE`, чтобы между
 * preflight'ом и удалением не проехал race.
 */
export interface OperationBlockersResponse {
  /** `true` — `DELETE` безопасен (никаких ссылок на операцию). */
  hardDeleteAllowed: boolean;
  /** Непустой список ссылок-блокеров (kind + count). */
  blockers: OperationDeleteBlockerDto[];
}
