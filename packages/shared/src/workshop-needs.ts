/**
 * Контракты модуля «Потребность цеха» (Workshop Needs, Этап 4А).
 *
 * См. `docs/recon-soft-integration.md §«Этап 4А»`,
 * `prisma/schema.prisma::WorkshopNeed`,
 * `apps/api/src/modules/workshop-needs/*`.
 *
 * Дизайн MVP:
 *   - закупщик НЕ имеет своей роли: используем существующие
 *     `ADMIN`/`SHOP_MANAGER`;
 *   - НЕТ справочника поставщиков, НЕТ закупочной номенклатуры —
 *     `supplierNameText` / `purchaseItemNameText` свободные строки;
 *   - НЕТ потерь / коэффициентов: считаем только чистую потребность;
 *   - `calculatedQty` пишет система, `purchaseQty` пишет закупщик
 *     руками;
 *   - `status` и `calculationMethod` — свободные строки в БД,
 *     валидируются Zod-ом по спискам ниже (расширение списка не
 *     требует миграции).
 *
 * Связь с уже существующими модулями:
 *   - источник «лекало → площадь × материалу»
 *     (`PatternMaterialArea.areaM2` × `PatternMaterialArea.sizeId` ×
 *     `OrderItem.qtyPlan`);
 *   - источник «техкарта → плотность/ширина/правило цвета»
 *     (`TechCardMaterialLine.*` для DRAFT-заказа,
 *     `OrderMaterialRequirement.*` snapshot для запущенного).
 */

import { z } from 'zod';

import {
  MATERIAL_ROLE_LABELS,
  MaterialRoleSchema,
  type MaterialRole,
} from './material-roles';
import {
  MONEY_CURRENCIES,
  MoneyCurrencySchema,
  type MoneyCurrency,
} from './money';
import {
  TECH_CARD_MATERIAL_COLOR_RULE_LABELS,
  type TechCardMaterialColorRule,
} from './tech-cards';

// ---------------------------------------------------------------------------
// Statuses / methods (свободные строки в БД, валидация Zod)
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл потребности:
 *
 * - `CALCULATED`        — система рассчитала строку, закупщик ещё
 *   не трогал. Пересчёт без `force` пересоздаёт только такие
 *   строки.
 * - `REVIEWED`          — закупщик посмотрел, проставил/проверил
 *   `purchaseQty` / поставщика, но в закупку ещё не отдавал.
 * - `PURCHASE_PLANNED`  — закупщик решил «эту строку идём
 *   покупать». Ручные поля защищены от случайного пересчёта.
 * - `ORDERED`           — этап 6А «Заказы поставщикам»: по строке
 *   создан `PurchaseOrderLine` (см.
 *   `apps/api/src/modules/purchase-orders/*`). Возвращается в
 *   `PURCHASE_PLANNED` при отмене PO, если по потребности больше
 *   нет активных строк (`DRAFT`/`SENT`/`CONFIRMED`).
 * - `CANCELLED`         — потребность снята вручную. Не считается
 *   автоматически и не блокирует пересчёт.
 *
 * Новые статусы добавляются в этот массив + лейбл ниже, без
 * миграции БД.
 */
export const WORKSHOP_NEED_STATUSES = [
  'CALCULATED',
  'REVIEWED',
  'PURCHASE_PLANNED',
  'ORDERED',
  /**
   * Этап 7А «Приёмка поставок»: по потребности зарегистрирована
   * минимум одна `PurchaseReceiptLine` (`status = POSTED`), но
   * хотя бы одна активная строка PO ещё в `SENT`/`CONFIRMED`/
   * `PARTIALLY_RECEIVED`.
   */
  'PARTIALLY_RECEIVED',
  /**
   * Этап 7А: все активные строки PO по этой потребности —
   * `RECEIVED`.
   */
  'RECEIVED',
  'CANCELLED',
] as const;
export type WorkshopNeedStatus = (typeof WORKSHOP_NEED_STATUSES)[number];
export const WorkshopNeedStatusSchema = z.enum(WORKSHOP_NEED_STATUSES);

export const WORKSHOP_NEED_STATUS_LABELS: Record<WorkshopNeedStatus, string> = {
  CALCULATED: 'Рассчитано',
  REVIEWED: 'Проверено закупщиком',
  PURCHASE_PLANNED: 'К закупке',
  ORDERED: 'Заказано поставщику',
  PARTIALLY_RECEIVED: 'Частично получено',
  RECEIVED: 'Получено',
  CANCELLED: 'Отменено',
};

/**
 * Метод расчёта строки. Управленческая ось «как мы получили число»:
 *
 * - `AREA_DENSITY`     — для тканей с `materialRole + densityGsm`,
 *   когда у заказа есть `patternItemId` и в лекале для этой роли
 *   заданы `PatternMaterialArea`. Формула:
 *   `Σ(areaM2 × qtyPlan) × densityGsm / 1000`, единица — кг.
 * - `LINEAR_M_BY_SIZE` — этап «Погонные метры по размерам»: для
 *   каждого параметра категории с `inputType = LINEAR_M_BY_SIZE`
 *   считаем `Σ(value × qtyPlan)` по размерам лекала (см.
 *   `PatternItemSizeParameterValue`). Единица — `unit` параметра
 *   (по умолчанию «м пог.»).
 * - `QTY_PER_UNIT`     — fallback для пакетов, ниток, фурнитуры.
 *   Берём `qtyPerUnit × Σ qtyPlan` (или snapshot `totalQty`),
 *   единица — `unit` строки техкарты / snapshot.
 */
export const WORKSHOP_NEED_CALCULATION_METHODS = [
  'AREA_DENSITY',
  'LINEAR_M_BY_SIZE',
  'QTY_PER_UNIT',
] as const;
export type WorkshopNeedCalculationMethod =
  (typeof WORKSHOP_NEED_CALCULATION_METHODS)[number];
export const WorkshopNeedCalculationMethodSchema = z.enum(
  WORKSHOP_NEED_CALCULATION_METHODS,
);

export const WORKSHOP_NEED_CALCULATION_METHOD_LABELS: Record<
  WorkshopNeedCalculationMethod,
  string
> = {
  AREA_DENSITY: 'По площади и плотности',
  LINEAR_M_BY_SIZE: 'Погонные метры по размерам',
  QTY_PER_UNIT: 'По норме техкарты',
};

/**
 * Источник, из которого расчёт взял описание материала. Используется
 * только в аудите/UI; не влияет на логику UI закупщика.
 *
 * - `TECH_CARD_MATERIAL_LINE` — материал из live-техкарты заказа.
 * - `ORDER_MATERIAL_REQUIREMENT` — snapshot строка заказа (после
 *   `OrdersService.start()`).
 * - `ORDER_APPLICATION` — нанесение из заказа покупателя.
 * - `PATTERN_PARAMETER_NORM` — этап «Фурнитура и нормы»: норма
 *   «количество на изделие» из карточки лекала
 *   (`PatternItemParameterNorm`). Каждая норма раскрывается в
 *   отдельную строку `WorkshopNeed` (`sourceId = norm.id`), даже
 *   если несколько норм имеют один `roleKey = PACKAGING` —
 *   Люверсы / Шнур / Наконечники не объединяются.
 * - `PATTERN_SIZE_PARAMETER_VALUE` — этап «Погонные метры по
 *   размерам»: набор значений по размерам для одного
 *   `PatternCategoryParameter` с `inputType = LINEAR_M_BY_SIZE`
 *   (`PatternItemSizeParameterValue`). Один параметр = одна строка
 *   `WorkshopNeed`; `sourceId = categoryParameterId`,
 *   `calculatedQty = Σ(value × qtyPlan)` по размерам.
 */
export const WORKSHOP_NEED_SOURCE_TYPES = [
  'TECH_CARD_MATERIAL_LINE',
  'ORDER_MATERIAL_REQUIREMENT',
  'ORDER_APPLICATION',
  'PATTERN_PARAMETER_NORM',
  'PATTERN_SIZE_PARAMETER_VALUE',
  /**
   * Этап «Категории номенклатуры» (см. ТЗ «Исправить формирование
   * Потребности цеха»). Для category-driven заказов
   * (`PatternItem.categoryId` + заполнены параметры категории) строки
   * с `inputType = AREA_M2_BY_SIZE` рассчитываются напрямую из
   * `PatternMaterialArea` (не из строки техкарты, как раньше). Это
   * нужно, чтобы лишняя «Спанбонд / Синтепон» из техкарты, под которую
   * нет заполненного параметра номенклатуры, не попадали в потребность.
   *
   * `sourceId = "<categoryParameterId>"` (если параметр категории
   * найден) или `"<materialRole>"` (legacy fallback). Описание
   * обогащается из строки техкарты с тем же `materialRole`.
   * Расчёт делает `WorkshopNeedsService.computeMaterialAreaByRole`.
   */
  'PATTERN_MATERIAL_AREA',
] as const;
export type WorkshopNeedSourceType =
  (typeof WORKSHOP_NEED_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const WORKSHOP_NEED_DESCRIPTION_MAX_LENGTH = 500;
export const WORKSHOP_NEED_UNIT_MAX_LENGTH = 32;
export const WORKSHOP_NEED_TEXT_FIELD_MAX_LENGTH = 200;
export const WORKSHOP_NEED_CURRENCY_MAX_LENGTH = 16;
export const WORKSHOP_NEED_COMMENT_MAX_LENGTH = 1000;
/**
 * `purchaseQty` хранится как `Decimal(14, 4)`. Жёстких бизнес-границ
 * нет, ставим только sanity-предел против опечаток.
 */
export const WORKSHOP_NEED_QTY_MAX = 1_000_000_000;
export const WORKSHOP_NEED_PRICE_MAX = 1_000_000_000;

// ---------------------------------------------------------------------------
// Reusable Zod helpers
// ---------------------------------------------------------------------------

/**
 * Optional строка, которая нормализуется в `null` для пустых значений.
 * Backend получает либо `null`, либо непустую trimmed-строку.
 */
function optionalNullableText(maxLength: number, label: string) {
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

const SupplierNameField = optionalNullableText(
  WORKSHOP_NEED_TEXT_FIELD_MAX_LENGTH,
  'Поставщик',
);
const PurchaseItemNameField = optionalNullableText(
  WORKSHOP_NEED_TEXT_FIELD_MAX_LENGTH,
  'Номенклатура поставщика',
);
/**
 * Этап «Себестоимость заказа» (см. `./money.ts`,
 * `./order-cost-estimates.ts`): валюта строки `WorkshopNeed`
 * ограничена фиксированным списком `MONEY_CURRENCIES` (`RUB` /
 * `USD`). Принимаем `string | null | undefined`:
 *   - `undefined` — поле не пришло, backend не трогает колонку;
 *   - `null` или `''` — закупщик очищает валюту (legacy, для строк
 *     без выбранной валюты);
 *   - любое значение из `MONEY_CURRENCIES` — после `.toUpperCase()`
 *     попадёт в БД как есть.
 *
 * Свободная строка более не допускается: «EUR» / «UAH» отбиваются
 * Zod-ом и UI рисует select RUB/USD.
 */
const QuotedCurrencyField: z.ZodType<MoneyCurrency | null | undefined> = z
  .preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    if (trimmed === '') return null;
    return trimmed.toUpperCase();
  }, MoneyCurrencySchema.nullable().optional()) as unknown as z.ZodType<
    MoneyCurrency | null | undefined
  >;
const CommentField = optionalNullableText(
  WORKSHOP_NEED_COMMENT_MAX_LENGTH,
  'Комментарий',
);

/**
 * `purchaseQty` принимает `string | number | null | undefined`,
 * нормализует к строке с `.` (без локалей), валидирует как
 * положительное число с не более чем 4 знаками после запятой.
 * Возвращает либо строку (`Prisma.Decimal` принимает её как есть),
 * либо `null` (если пользователь очистил поле).
 *
 * Пустые строки / `null` нормализуются в `null` — это стирание
 * `purchaseQty`. Это дешевле, чем заводить отдельный action
 * «очистить purchaseQty».
 */
const PurchaseQtyField: z.ZodType<string | null | undefined> = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw =
      typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') return null;
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'К закупке: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'К закупке должно быть > 0',
      });
      return z.NEVER;
    }
    if (n > WORKSHOP_NEED_QTY_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'К закупке: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

/**
 * `quotedPrice` принимает `string | number | null | undefined`.
 * Допускает `0` (бесплатный материал), не допускает отрицательных.
 * Decimal(14,2).
 */
const QuotedPriceField: z.ZodType<string | null | undefined> = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw =
      typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена: число, не более 2 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена должна быть >= 0',
      });
      return z.NEVER;
    }
    if (n > WORKSHOP_NEED_PRICE_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

/**
 * Дата ожидаемой поставки. Принимаем ISO-строку (`YYYY-MM-DD` или
 * полную ISO datetime), пустую строку нормализуем в null. Backend
 * сам преобразует в `Date`.
 */
const ExpectedDeliveryDateField: z.ZodType<string | null | undefined> = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw = v.trim();
    if (raw === '') return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ожидаемая дата: некорректный формат',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

// ---------------------------------------------------------------------------
// Order calculation filter (UI-фильтр «Статус расчёта»)
// ---------------------------------------------------------------------------

/**
 * Управленческий фильтр верхнего уровня для `/admin/workshop-needs`.
 *
 * Это НЕ статус строки `WorkshopNeed.status` (для этого есть
 * `WORKSHOP_NEED_STATUSES`). Это фильтр по статусу заказа-документа
 * (`Order.status`):
 *
 *   - `ACTIVE` → `Order.status = 'CALCULATION'` — заказы, по которым
 *     закупщик ещё в работе. Default для общего списка.
 *   - `DONE`   → `Order.status = 'CALCULATION_DONE'` — расчёт по
 *     заказу зафиксирован, в текущей работе не мешает.
 *   - `ALL`    → не фильтруем по `Order.status` вообще.
 *
 * Дефолт сознательно «прячет» завершённые расчёты из глобального
 * списка, чтобы рабочее место закупщика не обрастало хвостом
 * закрытых документов. В endpoint-е конкретного заказа default
 * меняется на `ALL` — карточка заказа продолжает видеть свои
 * потребности независимо от того, идёт расчёт или закончен.
 */
export const WORKSHOP_NEED_ORDER_CALCULATION_FILTERS = [
  'ACTIVE',
  'DONE',
  'ALL',
] as const;
export type WorkshopNeedOrderCalculationFilter =
  (typeof WORKSHOP_NEED_ORDER_CALCULATION_FILTERS)[number];
export const WorkshopNeedOrderCalculationFilterSchema = z.enum(
  WORKSHOP_NEED_ORDER_CALCULATION_FILTERS,
);

export const WORKSHOP_NEED_ORDER_CALCULATION_FILTER_LABELS: Record<
  WorkshopNeedOrderCalculationFilter,
  string
> = {
  ACTIVE: 'В расчёте',
  DONE: 'Расчёт завершён',
  ALL: 'Все',
};

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListWorkshopNeedsQuerySchema = z.object({
  /** Опциональный фильтр по заказу. */
  orderId: z.string().min(1).optional(),
  /**
   * Технический фильтр по статусу строки `WorkshopNeed.status`.
   *
   * Сохранён в схеме, чтобы внутренние API-консьюмеры могли
   * по-прежнему фильтровать по статусу строки (например, выгрузить
   * все `PURCHASE_PLANNED`). UI страницы `/admin/workshop-needs`
   * этот фильтр больше не использует — для управленческой
   * фильтрации см. `orderCalculationStatus`.
   */
  status: WorkshopNeedStatusSchema.optional(),
  /**
   * Управленческий фильтр по статусу заказа-документа
   * (`Order.status`). См. `WORKSHOP_NEED_ORDER_CALCULATION_FILTERS`.
   *
   * Default определяется на стороне backend в зависимости от
   * наличия `orderId`:
   *   - без `orderId`            → `ACTIVE` (скрываем завершённые);
   *   - c `orderId`              → `ALL`    (карточка заказа всегда
   *                                          видит свои потребности).
   */
  orderCalculationStatus:
    WorkshopNeedOrderCalculationFilterSchema.optional(),
  /**
   * Поиск по `description` / `sourceName` / `supplierNameText` /
   * `purchaseItemNameText` / номеру заказа (case-insensitive
   * `contains`).
   */
  search: z.string().trim().max(120).optional(),
});
export type ListWorkshopNeedsQuery = z.infer<
  typeof ListWorkshopNeedsQuerySchema
>;

// ---------------------------------------------------------------------------
// Calculate DTO
// ---------------------------------------------------------------------------

/**
 * `force = true` — стирает все существующие потребности заказа,
 * даже `REVIEWED`/`PURCHASE_PLANNED`. По умолчанию (не передано или
 * `false`) пересчёт защищён: если есть строки в не-`CALCULATED`
 * статусе, backend возвращает 409 `WORKSHOP_NEEDS_ALREADY_REVIEWED`.
 */
export const CalculateWorkshopNeedsSchema = z.object({
  force: z.boolean().optional().default(false),
});
export type CalculateWorkshopNeedsDto = z.infer<
  typeof CalculateWorkshopNeedsSchema
>;

// ---------------------------------------------------------------------------
// Update DTO (закупщик)
// ---------------------------------------------------------------------------

/**
 * Этап 5 «Поставщики»: мягкая ссылка на карточку поставщика и его
 * номенклатуру. Принимает строку (id) или `null` (очистить связь);
 * `undefined` — поле не передано, backend оставляет колонку как есть.
 *
 * Пустая строка нормализуется в `null` — это удобно для `<select>`-а
 * с пустой опцией «Не выбрано».
 */
const SelectedSupplierIdField = z.preprocess(
  (v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  },
  z.string().min(1).nullable().optional(),
) as unknown as z.ZodType<string | null | undefined>;

const SelectedSupplierCatalogItemIdField = SelectedSupplierIdField;

export const UpdateWorkshopNeedSchema = z
  .object({
    purchaseQty: PurchaseQtyField,
    status: WorkshopNeedStatusSchema.optional(),
    supplierNameText: SupplierNameField,
    purchaseItemNameText: PurchaseItemNameField,
    quotedPrice: QuotedPriceField,
    quotedCurrency: QuotedCurrencyField,
    expectedDeliveryDate: ExpectedDeliveryDateField,
    comment: CommentField,
    /**
     * Этап 5 «Поставщики». Привязка к карточке поставщика из
     * справочника (`Supplier.id`). `null` — очистить связь и связанный
     * `selectedSupplierCatalogItem` (см. сервис).
     */
    selectedSupplierId: SelectedSupplierIdField,
    /**
     * Этап 5 «Поставщики». Привязка к конкретной позиции каталога
     * поставщика (`SupplierCatalogItem.id`). `null` — очистить только
     * номенклатуру (поставщик может остаться выбранным).
     *
     * Если передан без `selectedSupplierId`, backend сам подставит
     * `selectedSupplierId = item.supplierId`.
     */
    selectedSupplierCatalogItemId: SelectedSupplierCatalogItemIdField,
  })
  .refine(
    (obj) =>
      obj.purchaseQty !== undefined ||
      obj.status !== undefined ||
      obj.supplierNameText !== undefined ||
      obj.purchaseItemNameText !== undefined ||
      obj.quotedPrice !== undefined ||
      obj.quotedCurrency !== undefined ||
      obj.expectedDeliveryDate !== undefined ||
      obj.comment !== undefined ||
      obj.selectedSupplierId !== undefined ||
      obj.selectedSupplierCatalogItemId !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateWorkshopNeedDto = z.infer<typeof UpdateWorkshopNeedSchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Источник, из которого UI «Потребность цеха» взял `nomenclatureName`
 * / `nomenclatureArticle` / `nomenclaturePreviewImageUrl` (см. polish-
 * итерацию `/admin/workshop-needs`):
 *
 *   - `'snapshot'`      — `Order.patternNameSnapshot` есть; заказ был
 *                         переведён в «Расчёт»/`IN_PRODUCTION` и UI
 *                         обязан показывать snapshot, даже если
 *                         `PatternItem` после этого изменился.
 *   - `'pattern'`       — snapshot пуст, но live-привязка `patternItem`
 *                         есть. Используется для `DRAFT`-заказов.
 *   - `'legacyProduct'` — ни snapshot, ни live `PatternItem` нет —
 *                         fallback на legacy `Product.name`. На пилоте
 *                         сюда попадают только исторические заказы.
 *   - `'none'`          — ни одного источника. UI рисует «—».
 */
export type WorkshopNeedNomenclatureSource =
  | 'snapshot'
  | 'pattern'
  | 'legacyProduct'
  | 'none';

export interface WorkshopNeedDto {
  id: string;
  orderId: string;
  /** Краткая ссылка на заказ для UI-таблицы (имя/статус). */
  orderNumber: string | null;
  orderStatus: string | null;
  /**
   * Polish-итерация `/admin/workshop-needs`: дополнительные «лёгкие»
   * поля заказа, чтобы UI таблицы / карточек группировки по заказу
   * мог отрисоваться без дополнительного `GET /api/orders/:id`.
   *
   *   - `orderDueDate` — `Order.dueDate` (ISO).
   *   - `orderColor`   — `Order.color` (свободный текст, как и в
   *     карточке заказа).
   *   - `clientId` / `clientName` — связанная карточка `Client`
   *     (имя из справочника, либо `Order.customer` как fallback).
   *
   * Все поля additive и nullable — старые заказы (без клиента / срока)
   * остаются валидными.
   */
  orderDueDate: string | null;
  orderColor: string | null;

  clientId: string | null;
  clientName: string | null;

  /**
   * Polish-итерация `/admin/workshop-needs`: «Что заказано» —
   * номенклатура из карточки лекала. Resolver идентичен
   * `apps/web/lib/order-nomenclature.ts::resolveOrderNomenclature`:
   *
   *   nomenclatureName =
   *     Order.patternNameSnapshot ??
   *     PatternItem.name           ??
   *     Order.productName (legacy) ??
   *     null;
   *
   *   nomenclatureArticle =
   *     Order.patternArticleSnapshot ??
   *     PatternItem.article          ??
   *     null;
   *
   *   nomenclaturePreviewImageUrl =
   *     Order.patternPreviewSnapshotUrl ??
   *     PatternItem.previewImageUrl     ??
   *     null;
   *
   * `nomenclatureSource` указывает, какой источник победил — UI
   * пользуется им, чтобы решить, рисовать ли бейдж «снимок» /
   * «актуальное» / «legacy» рядом с названием.
   */
  nomenclatureName: string | null;
  nomenclatureArticle: string | null;
  nomenclaturePreviewImageUrl: string | null;
  nomenclatureSource: WorkshopNeedNomenclatureSource;

  sourceType: WorkshopNeedSourceType | string | null;
  sourceId: string | null;

  materialRole: MaterialRole | string | null;
  sourceName: string | null;
  description: string;

  fabricType: string | null;
  densityGsm: number | null;
  plannedWidthCm: number | null;

  colorRule: TechCardMaterialColorRule | string | null;
  fixedColorText: string | null;
  resolvedColorText: string | null;

  /** `null` для `QTY_PER_UNIT`. */
  totalAreaM2: string | null;
  /** Decimal как строка (см. `Prisma.Decimal`). */
  calculatedQty: string;
  /** Decimal как строка; `null` пока закупщик не заполнил. */
  purchaseQty: string | null;
  unit: string;

  calculationMethod: WorkshopNeedCalculationMethod | string;
  status: WorkshopNeedStatus | string;

  supplierNameText: string | null;
  purchaseItemNameText: string | null;
  quotedPrice: string | null;
  /**
   * Валюта закупочной цены — `RUB` / `USD` или `null`, если
   * закупщик ещё не выбрал. Сужено до `MoneyCurrency` после этапа
   * «Себестоимость заказа» (см. `./money.ts`). Для backward-compat
   * допускаем `string`, чтобы старые консьюмеры с раскраской чужих
   * валют ещё компилировались.
   */
  quotedCurrency: MoneyCurrency | string | null;
  /** ISO. */
  expectedDeliveryDate: string | null;

  /**
   * Этап 5 «Поставщики». Связь с карточкой `Supplier`:
   *
   * - `selectedSupplierId` / `selectedSupplierCatalogItemId` —
   *   id из справочника, или `null`, если закупщик ещё не выбрал
   *   (тогда UI должен показывать `supplierNameText` /
   *   `purchaseItemNameText` как fallback).
   * - `selectedSupplierName`, `selectedSupplierCatalogItemName`,
   *   `selectedSupplierCatalogItemArticle`,
   *   `selectedSupplierCatalogItemUnit`,
   *   `selectedSupplierCatalogItemLastPrice` — denormalised-копии
   *   полей выбранной позиции, чтобы UI таблицы мог рисовать строку
   *   без дополнительного fetch-а карточки поставщика.
   */
  selectedSupplierId: string | null;
  selectedSupplierCatalogItemId: string | null;
  selectedSupplierName: string | null;
  selectedSupplierCatalogItemName: string | null;
  selectedSupplierCatalogItemArticle: string | null;
  selectedSupplierCatalogItemUnit: string | null;
  /** Decimal как строка; `null` если у позиции нет lastPrice. */
  selectedSupplierCatalogItemLastPrice: string | null;

  comment: string | null;
  calculationNote: string | null;

  /**
   * Этап «Исправить формирование Потребности цеха» (см. ТЗ §5–6):
   * derived-обогащение из связанной строки техкарты / snapshot заказа
   * для UI закупщика. Все поля nullable + optional — старые консьюмеры
   * без пересборки shared-пакета продолжают компилироваться, а DB-модель
   * `WorkshopNeed` НЕ меняется (поля заполняет `WorkshopNeedsService.toDto`
   * при чтении, через include `order.materialRequirements` /
   * `order.techCard.materialLines`).
   *
   * Используются на странице `/admin/workshop-needs`:
   *   - `hardwareSizeText` / `hardwareMaterialText` показываются
   *     отдельной secondary-строкой под description для PACKAGING-ролей
   *     («Молния» → «60 см · пластик»);
   *   - `materialImageUrl` рендерится как маленькое preview;
   *   - `selectedColorText` / `requiresColorSelection` дают warning
   *     «Цвет нужно указать в заказе», если правило цвета
   *     `ORDER_SELECTED_COLOR` и менеджер цвет ещё не ввёл.
   */
  hardwareSizeText?: string | null;
  hardwareMaterialText?: string | null;
  materialImageUrl?: string | null;
  selectedColorText?: string | null;
  requiresColorSelection?: boolean;

  /** ISO. */
  calculatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Тонкий DTO для таблицы `/admin/workshop-needs`. Сейчас полностью
 * совпадает с `WorkshopNeedDto` — отдельный тип нужен, чтобы при
 * будущем расширении детальной формы (например, history полей) не
 * утяжелять список без необходимости.
 */
export type WorkshopNeedListItemDto = WorkshopNeedDto;

/**
 * Результат `POST /api/orders/:id/workshop-needs/calculate`. Возвращаем
 * сами потребности и сводку, чтобы UI мог сразу обновить блок «Потребность
 * цеха» без дополнительного `GET`.
 */
export interface CalculateWorkshopNeedsResultDto {
  orderId: string;
  needs: WorkshopNeedDto[];
  /** Сколько строк создано в этой итерации. */
  count: number;
  /** Использовался ли force-режим. */
  force: boolean;
  /** Свод по методам расчёта. Полезно для UI/аудита. */
  methods: {
    AREA_DENSITY: number;
    QTY_PER_UNIT: number;
  };
  /**
   * Человекочитаемые предупреждения, которые система решила не
   * превращать в ошибку (например, «Нет площади для размеров: M, L
   * по роли MAIN_FABRIC»). UI показывает строкой над таблицей.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// UI grouping: kind helper (Polish-итерация `/admin/workshop-needs`)
// ---------------------------------------------------------------------------

/**
 * Управленческий «тип» потребности — то, что менеджер видит в
 * карточке заказа: «Материалы» / «Фурнитура» / «Нанесение» / «Прочее».
 *
 * Это сознательно не БД-enum: один и тот же `materialRole` (например,
 * `PACKAGING`) может попасть в разные секции в зависимости от
 * `sourceType`, поэтому группировка идёт по `sourceType` (плюс
 * `calculationMethod` для редкого fallback-кейса AREA_DENSITY без
 * лекала).
 */
export const WORKSHOP_NEED_KINDS = [
  'MATERIAL',
  'HARDWARE',
  'APPLICATION',
  'OTHER',
] as const;
export type WorkshopNeedKind = (typeof WORKSHOP_NEED_KINDS)[number];

export const WORKSHOP_NEED_KIND_LABELS: Record<WorkshopNeedKind, string> = {
  MATERIAL: 'Материалы',
  HARDWARE: 'Фурнитура',
  APPLICATION: 'Нанесение',
  OTHER: 'Прочее',
};

/**
 * Минимальный набор полей, по которым UI решает «к какой секции
 * (Материалы / Фурнитура / Нанесение / Прочее) отнести строку».
 *
 * Принимаем `Pick`-совместимый объект, чтобы вызывающие компоненты
 * могли явно декларировать поля и не тащить весь `WorkshopNeedDto`
 * (тесты / mock-объекты).
 *
 * Этап «Исправить формирование Потребности цеха» (см. ТЗ §7
 * «Исправить классификацию секций»): теперь ось классификации — это
 * `materialRole`, а не только `sourceType`. Нитки / Синтепон /
 * Дублерин больше не падают в «Фурнитуру» только потому, что
 * `sourceType = PATTERN_PARAMETER_NORM` или `calculationMethod =
 * QTY_PER_UNIT` — для них роль (`THREAD` / `FILLER` / `INTERLINING`)
 * однозначно определяет секцию «Материалы».
 */
export interface WorkshopNeedKindInput {
  sourceType?: WorkshopNeedDto['sourceType'];
  calculationMethod?: WorkshopNeedDto['calculationMethod'];
  /**
   * Snapshot роли материала строки потребности
   * (`MAIN_FABRIC` / `RIB` / `LINING` / `THREAD` / `PACKAGING` /
   * `APPLICATION` / `MARKING` / `FILLER` / `INTERLINING` / …).
   * Хранится в БД свободной строкой; список расширяется без миграции
   * (см. `@sewing/shared/material-roles`,
   * `@sewing/shared/pattern-categories::PATTERN_CATEGORY_PARAMETER_GROUPS`).
   */
  materialRole?: WorkshopNeedDto['materialRole'];
}

/**
 * Роли материала, которые UI-классификатор относит к секции «Фурнитура».
 *
 * Сознательно держим список узким: только `PACKAGING`. На MVP это
 * единственная роль, которую менеджер видит как «фурнитура / упаковка»
 * (Молния / Люверсы / Кнопки / Шнур / Этикетка). Все остальные роли —
 * ткани и дополнительные материалы — попадают в секцию «Материалы»
 * вне зависимости от `sourceType` / `calculationMethod`.
 *
 * Если в будущем появится отдельная роль `MARKING` или `LABEL` —
 * добавим в этот set; пока наклейки и ярлыки идут как `PACKAGING` или
 * `MARKING` (и тогда возвращаем `OTHER`).
 */
const HARDWARE_MATERIAL_ROLES = new Set<string>(['PACKAGING']);

/**
 * Роль `APPLICATION` — UI-секция «Нанесение». Используется и для
 * `sourceType = ORDER_APPLICATION`, и для legacy-строк техкарты с
 * `materialRole = APPLICATION` (исторические заказы без `OrderApplication`).
 */
const APPLICATION_MATERIAL_ROLES = new Set<string>(['APPLICATION']);

/**
 * Решает, к какой UI-секции относится потребность.
 *
 * Правила (см. ТЗ §7 «Исправить классификацию секций»):
 *
 *   1. `sourceType === 'ORDER_APPLICATION'` → `APPLICATION` (нанесение
 *      из заказа покупателя).
 *   2. `materialRole === 'APPLICATION'` → `APPLICATION` (legacy-строка
 *      техкарты для нанесения).
 *   3. `materialRole === 'PACKAGING'` → `HARDWARE` (фурнитура: Молния /
 *      Люверсы / Шнур / …). Это работает для PATTERN_PARAMETER_NORM,
 *      TECH_CARD_MATERIAL_LINE и любого другого источника.
 *   4. `materialRole` входит в `MATERIAL_ROLES` (тип ткани / нити /
 *      наполнитель / дублерин / маркировка) → `MATERIAL`.
 *   5. По `sourceType` / `calculationMethod` пытаемся вывести
 *      «материал» (для строк без явной роли — например, legacy-нитки
 *      без materialRole).
 *   6. Иначе → `OTHER`.
 *
 * Принципиально: PATTERN_PARAMETER_NORM с `roleKey = THREAD` или
 * `FILLER` теперь классифицируется как MATERIAL, а не HARDWARE. Это
 * прямой ответ на ТЗ «Спанбонд / Синтепон / Нитки не должны попадать
 * в Фурнитуру только из-за QTY_PER_ITEM».
 *
 * Расчёт `WorkshopNeed` не меняется — это исключительно UI-классификатор.
 */
export function getWorkshopNeedKind(
  input: WorkshopNeedKindInput,
): WorkshopNeedKind {
  const src = input.sourceType ?? null;
  const method = input.calculationMethod ?? null;
  const role = input.materialRole ?? null;

  // 1. `ORDER_APPLICATION` всегда APPLICATION — даже если materialRole
  //    почему-то не выставлен (исторический заказ).
  if (src === 'ORDER_APPLICATION') return 'APPLICATION';

  // 2./3./4. Классификация по роли — главный приоритет.
  if (typeof role === 'string' && role.length > 0) {
    if (APPLICATION_MATERIAL_ROLES.has(role)) return 'APPLICATION';
    if (HARDWARE_MATERIAL_ROLES.has(role)) return 'HARDWARE';
    // Любая известная material-роль (ткани / нити / наполнители /
    // дублерин / маркировка) — это «Материалы».
    return 'MATERIAL';
  }

  // 5. Без роли — fallback по источнику / методу. Это поведение
  //    исторически было для legacy-строк техкарты без materialRole
  //    (старые техкарты до этапа 3).
  if (
    src === 'ORDER_MATERIAL_REQUIREMENT' ||
    src === 'TECH_CARD_MATERIAL_LINE' ||
    src === 'PATTERN_MATERIAL_AREA' ||
    src === 'PATTERN_SIZE_PARAMETER_VALUE' ||
    method === 'AREA_DENSITY' ||
    method === 'LINEAR_M_BY_SIZE'
  ) {
    return 'MATERIAL';
  }
  return 'OTHER';
}

// ---------------------------------------------------------------------------
// Re-exports for convenient barrel
// ---------------------------------------------------------------------------

export {
  MATERIAL_ROLE_LABELS,
  MaterialRoleSchema,
  MONEY_CURRENCIES,
  MoneyCurrencySchema,
};
export type { MaterialRole, MoneyCurrency, TechCardMaterialColorRule };
export { TECH_CARD_MATERIAL_COLOR_RULE_LABELS };
