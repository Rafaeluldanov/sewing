/**
 * Контракты фичи «Варианты просчёта заказа» (order calculations).
 *
 * Клиент часто просит посчитать заказ в нескольких вариантах (другой
 * материал/техкарта, другие операции, другая цена) — в производство
 * уходит ровно один. Бэкенд: `apps/api/src/modules/order-calculations/*`
 * (`/api/orders/:id/calculations`). Веб: `apps/web/lib/order-calculations-api.ts`,
 * `components/orders/calculations/*`. Фича под флагом
 * `FEATURE_ORDER_CALCULATIONS` (на проде OFF по умолчанию, на dev ON).
 *
 * Дизайн «активный = живые данные» (см. JSDoc `model OrderCalculation`
 * в `prisma/schema.prisma`): активный вариант не хранит данных — его
 * состояние и есть текущие данные заказа; неактивные хранят снимок
 * «входов» (`OrderCalculationSnapshotV1Schema`), из которых расчётное
 * поддерево полностью пересобирается при переключении вкладки.
 *
 * НЕ путать с «Расцветками» (`colorways.ts`, `OrderVariant`): расцветки —
 * часть ОДНОГО варианта просчёта и производятся все; варианты просчёта —
 * взаимоисключающие альтернативы.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Снимок входов варианта (v1)
// ---------------------------------------------------------------------------

/** Decimal сериализуем строкой (как везде в shared-DTO). */
const decimalString = z.string();

/** Поразмерный план расцветки внутри снимка. */
const SnapshotVariantSizeSchema = z.object({
  sizeId: z.string().min(1),
  qtyPlan: z.number().int().min(0),
});

/** Расцветка (`OrderVariant`) внутри снимка варианта. */
const SnapshotVariantSchema = z.object({
  ordinal: z.number().int().min(0),
  color: z.string(),
  techCardId: z.string().nullable(),
  sizes: z.array(SnapshotVariantSizeSchema),
});

/**
 * Per-order оверрайды одного шага маршрута (`OrderRouteStep`), ключ —
 * `operationId` (та же carry-семантика, что у
 * `OrdersService.syncOrderRouteStepsSnapshot`). В снимок попадают только
 * шаги, где есть хоть один оверрайд; при restore остальным шагам
 * пишутся явные `null` — иначе carry протащит оверрайды предыдущего
 * варианта.
 */
const SnapshotRouteOverrideSchema = z.object({
  operationId: z.string().min(1),
  rateOverride: decimalString.nullable(),
  timeNormSecOverride: z.number().int().nullable(),
  pricingModeOverride: z.string().nullable(),
  sizeOverrides: z.array(
    z.object({
      sizeId: z.string().min(1),
      rate: decimalString.nullable(),
      seconds: z.number().int().nullable(),
    }),
  ),
});

/**
 * Полный ряд `OrderTechCardParameter` (определение + значение), с
 * `variantOrdinal` вместо `orderVariantId` (id расцветок при restore
 * пересоздаются — remap по ordinal).
 */
const SnapshotTechCardParameterSchema = z.object({
  variantOrdinal: z.number().int().min(0).nullable(),
  key: z.string(),
  label: z.string(),
  inputType: z.string(),
  options: z.unknown().nullable(),
  unit: z.string().nullable(),
  isRequired: z.boolean(),
  sortOrder: z.number().int(),
  owner: z.string(),
  sourceTechCardId: z.string().nullable(),
  /**
   * Этап 3 «техкарты → номенклатура»: слот из спецификации карточки.
   * `nullish` — старые снимки лежат без поля.
   */
  sourcePatternItemId: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  sourceParameterId: z.string().nullable(),
  value: z.string().nullable(),
  valueSource: z.string(),
  valueUpdatedAt: z.string().nullable(),
  valueUpdatedById: z.string().nullable(),
});

/**
 * Полный ряд `OrderMaterialRequirement` — снимок материалов варианта
 * (ФАЗА 2 «техкарта живёт в заказе»: правки ячеек / ручные строки —
 * состояние варианта, обязаны переживать переключение).
 *
 * `id` сохраняется ИСХОДНЫЙ: `WorkshopNeed.sourceId` ссылается на него
 * без FK — после restore ссылка снова указывает на живую строку, и
 * match-ключ восстановления цен закупщика продолжает работать.
 */
const SnapshotMaterialRequirementSchema = z.object({
  id: z.string().min(1),
  variantOrdinal: z.number().int().min(0).nullable(),
  variantColor: z.string().nullable(),
  sourceTechCardLineId: z.string().nullable(),
  sortOrder: z.number().int(),
  name: z.string(),
  unit: z.string(),
  /**
   * Единица нормы, если строка развела расход и закупку.
   *
   * `nullish`, а не `nullable`: снимки неактивных вариантов уже лежат в БД без
   * этого поля, и обязательное поле уронило бы их разбор в `SNAPSHOT_INVALID`.
   * Потерять поле при восстановлении нельзя — строка «схлопнется» обратно, и
   * ближайший пересчёт положит длину в килограммовую ячейку.
   */
  normUnit: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  qtyPerUnit: decimalString,
  totalQty: decimalString,
  note: z.string().nullable(),
  materialRole: z.string().nullable(),
  fabricType: z.string().nullable(),
  densityGsm: z.number().int().nullable(),
  plannedWidthCm: z.number().int().nullable(),
  colorRule: z.string().nullable(),
  fixedColorText: z.string().nullable(),
  resolvedColorText: z.string().nullable(),
  requiresColorSelection: z.boolean(),
  selectedColorText: z.string().nullable(),
  hardwareSizeText: z.string().nullable(),
  hardwareMaterialText: z.string().nullable(),
  materialImageUrl: z.string().nullable(),
  materialImageOriginalFileName: z.string().nullable(),
  subtypeKey: z.string().nullable(),
  characteristics: z.unknown().nullable(),
  parameterBindings: z.unknown().nullable(),
  sourceTechCardId: z.string().nullable(),
  /**
   * Этап 3 «техкарты → номенклатура»: трассировка строки на спецификацию
   * карточки. `nullish` — старые снимки лежат без полей; потерять их при
   * restore нельзя, иначе ФАЗА-2 перематериализовала бы снимок.
   */
  sourcePatternItemId: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  sourcePatternLineId: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  isManual: z.boolean(),
  /**
   * Откуда взята норма и к какой норме номенклатуры привязана строка.
   *
   * `nullish` по той же причине, что `normUnit`: снимки, снятые до этой
   * правки, лежат в БД без полей, и обязательные уронили бы их в
   * `SNAPSHOT_INVALID`.
   *
   * Терять их нельзя: `qtySource = 'ORDER'` означает «норму ввели руками, она
   * главнее номенклатуры». Без него активация другого варианта просчёта
   * обнуляла признак у ВСЕХ строк, включая заведённые в заказе, и потребность
   * начинала считаться по номенклатурной норме вместо введённой.
   */
  qtySource: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  qtySourceRef: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

/**
 * Ценовые/ручные поля закупщика на строке `WorkshopNeed` — best-effort
 * восстановление после пересчёта потребностей (сами строки при
 * переключении пересоздаются `calculateForOrder`). Match-ключ:
 * `variantOrdinal|sourceType|sourceId|unit`, fallback —
 * `variantOrdinal|materialRole|sourceName|unit` при уникальности с
 * обеих сторон. Статус строки НЕ восстанавливается (остаётся
 * CALCULATED — закупщик перепроверяет).
 */
const SnapshotWorkshopNeedValuesSchema = z.object({
  variantOrdinal: z.number().int().min(0).nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  materialRole: z.string().nullable(),
  sourceName: z.string().nullable(),
  unit: z.string(),
  purchaseQty: decimalString.nullable(),
  packSize: decimalString.nullable(),
  quotedPrice: decimalString.nullable(),
  quotedCurrency: z.string().nullable(),
  supplierNameText: z.string().nullable(),
  purchaseItemNameText: z.string().nullable(),
  selectedSupplierId: z.string().nullable(),
  selectedSupplierCatalogItemId: z.string().nullable(),
  comment: z.string().nullable(),
  expectedDeliveryDate: z.string().nullable(),
});

/**
 * Снимок входов варианта просчёта, версия 1.
 *
 * Осознанно НЕ входят (order-level, общие для всех вариантов):
 * ручные строки `WorkshopNeed` (isManual), `OrderExtraCost`,
 * `OrderApplication`, `OrderLogisticsLine`, `patternItemId` (лекало —
 * идентичность заказа, варианты отличаются материалами/операциями).
 */
export const OrderCalculationSnapshotV1Schema = z.object({
  version: z.literal(1),
  order: z.object({
    routeTemplateId: z.string().nullable(),
    /** Зеркало первой расцветки — `resyncColorwayDerived` мостит сам,
     *  но кладём для целостности/отладки. */
    techCardId: z.string().nullable(),
    /** Цвет заказа: питает `colorRule = ORDER_COLOR` снимка материалов. */
    color: z.string().nullable(),
    customerUnitPrice: decimalString.nullable(),
    customerCurrency: z.string().nullable(),
    materialsAndHardwareCostPolicy: z.string(),
    patternDevelopmentCostRub: decimalString.nullable(),
    patternDevelopmentCostInCostPrice: z.boolean(),
  }),
  variants: z.array(SnapshotVariantSchema),
  routeOverrides: z.array(SnapshotRouteOverrideSchema),
  techCardParameters: z.array(SnapshotTechCardParameterSchema),
  materialRequirements: z.array(SnapshotMaterialRequirementSchema),
  workshopNeedValues: z.array(SnapshotWorkshopNeedValuesSchema),
});
export type OrderCalculationSnapshotV1 = z.infer<
  typeof OrderCalculationSnapshotV1Schema
>;

// ---------------------------------------------------------------------------
// DTO вкладок
// ---------------------------------------------------------------------------

/** Одна вкладка варианта просчёта. */
export interface OrderCalculationTabDto {
  id: string;
  ordinal: number;
  title: string;
  isActive: boolean;
  /**
   * Ярлык себестоимости: у неактивных — снимок на момент переключения,
   * у активной — живой `Order.costEstimateTotalRub` (может быть null,
   * пока расчёт не завершён).
   */
  costTotalRub: string | null;
  /**
   * Стадия варианта (итерация 3): когда вариант ЯВНО отправлен на
   * расчёт (потребности посчитаны). `null` — черновик: считается только
   * кнопкой «Перевести в расчёт»/«Рассчитать вариант», ни активация, ни
   * клонирование расчёт не запускают. UI рисует чип «черновик».
   */
  sentToCalculationAt: string | null;
  updatedAt: string;
}

/** Ответ `GET /api/orders/:id/calculations` и всех write-ручек. */
export interface OrderCalculationsDto {
  orderId: string;
  activeId: string;
  /**
   * Можно ли переключать/создавать/удалять варианты: статус заказа
   * DRAFT|CALCULATION. Гейты потребностей (закупщик/склад) проверяются
   * на activate и приходят адресной 409.
   */
  canSwitch: boolean;
  items: OrderCalculationTabDto[];
}

// ---------------------------------------------------------------------------
// Входные схемы
// ---------------------------------------------------------------------------

export const CreateOrderCalculationSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
});
export type CreateOrderCalculationDto = z.infer<
  typeof CreateOrderCalculationSchema
>;

export const RenameOrderCalculationSchema = z.object({
  title: z.string().trim().min(1, 'Укажите название варианта').max(80),
});
export type RenameOrderCalculationDto = z.infer<
  typeof RenameOrderCalculationSchema
>;

// ---------------------------------------------------------------------------
// Коды ошибок (BusinessException.code на бэке; UI показывает message)
// ---------------------------------------------------------------------------

export const ORDER_CALCULATION_ERROR_CODES = {
  /** Статус заказа вне DRAFT|CALCULATION — варианты зафиксированы. */
  LOCKED: 'ORDER_CALCULATION_LOCKED',
  /** Потребности уже в работе у закупщика (строки ≠ CALCULATED). */
  NEEDS_IN_PROGRESS: 'ORDER_CALCULATION_NEEDS_IN_PROGRESS',
  NOT_FOUND: 'ORDER_CALCULATION_NOT_FOUND',
  ACTIVE_DELETE_FORBIDDEN: 'ORDER_CALCULATION_ACTIVE_DELETE_FORBIDDEN',
  LAST_DELETE_FORBIDDEN: 'ORDER_CALCULATION_LAST_DELETE_FORBIDDEN',
  /** Снимок неактивного варианта не прошёл zod-валидацию. */
  SNAPSHOT_INVALID: 'ORDER_CALCULATION_SNAPSHOT_INVALID',
  /** Параллельное изменение вариантов (optimistic-guard). */
  CONFLICT: 'ORDER_CALCULATION_CONFLICT',
} as const;
