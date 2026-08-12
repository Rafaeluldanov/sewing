/**
 * Контракты «Параметры техкарты внутри заказа».
 *
 * Технолог открывает расцветку и заполняет слоты, объявленные в шаблоне
 * («Плотность полотна» = 190), либо заводит свой — прямо в заказе. Значения
 * ВСЕГДА принадлежат расцветке: наследования «уровень заказа → расцветка» нет
 * (оно порождает вопрос «унаследовано или переопределено» и второй источник
 * истины). От повторного ввода спасает `apply-to-all-variants` — разовое
 * копирование, а не связь.
 *
 * Модуль — зеркало `./colorways.ts`: каждый write возвращает свежий полный
 * DTO. Окно правки ШИРЕ, чем у расцветок: расцветки правятся только пока
 * план не заморожен (`DRAFT`/`CALCULATION`), а спецификация техкарты —
 * вплоть до `IN_PRODUCTION` (см. `OrderTechCardEditMode`).
 */

import { z } from 'zod';

import type { MaterialCharacteristics } from './material-characteristics';
import {
  TechCardParameterInputTypeSchema,
  TechCardParameterKeySchema,
  TechCardParameterTargetSchema,
  type OrderTechCardParameterDto,
} from './tech-card-parameters';

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/** Ячейка строки материала, доступная для привязки ad-hoc параметра. */
export interface OrderTechCardTargetOptionDto {
  /** `OrderMaterialRequirement.id` — строка снимка ЭТОЙ расцветки. */
  requirementId: string;
  lineName: string;
  field: string;
  fieldLabel: string;
  valueType: 'text' | 'number';
  unit: string | null;
  /** Ячейка уже занята другим параметром — привязать второй нельзя. */
  takenByKey: string | null;
}

/** Параметры одной расцветки (или order-level группы при 0–1 расцветке). */
export interface OrderTechCardVariantParamsDto {
  orderVariantId: string | null;
  color: string | null;
  techCardId: string | null;
  techCardName: string | null;
  parameters: OrderTechCardParameterDto[];
  /** Сколько обязательных слотов ещё пустые (для плитки расцветки). */
  missingRequiredCount: number;
  /** Куда можно привязать новый параметр. */
  targets: OrderTechCardTargetOptionDto[];
  /** Строки материалов этой расцветки — из шаблона и добавленные в заказе. */
  lines: OrderTechCardLineDto[];
}

/**
 * Режим окна правки спецификации техкарты внутри заказа.
 *
 *   - `PLAN`      — `DRAFT`/`CALCULATION`: план заказа ещё не заморожен,
 *     правка пересобирает всё производное обычным путём
 *     (`OrdersService.resyncColorwayDerived`): агрегат `OrderItem`, снимок
 *     материалов, план операций, снимок маршрута, потребности цеха.
 *   - `AMENDMENT` — `CALCULATION_DONE`/`SAMPLE_PRODUCTION`/`IN_PRODUCTION`:
 *     правка РАЗРЕШЕНА, но идёт тем же контуром, что правки заказа в
 *     производстве: пересобираются только снимок материалов и плановая
 *     стоимость операций, маршрут и паспорта не трогаются, потребности
 *     пересчитываются best-effort, событие пишется в журнал правок.
 *     Уже выданные/закупленные материалы правка не отменяет — расхождение
 *     видно в план-факте.
 *   - `LOCKED`    — `DONE`/`CANCELLED`: заказ закрыт, правка запрещена.
 */
export type OrderTechCardEditMode = 'PLAN' | 'AMENDMENT' | 'LOCKED';

export interface OrderTechCardParametersDto {
  orderId: string;
  /**
   * Можно ли сейчас править спецификацию (`editMode !== 'LOCKED'`).
   * Оставлено отдельным полем ради обратной совместимости фронта.
   */
  editable: boolean;
  /** Чем правка обернётся для производных данных — см. `OrderTechCardEditMode`. */
  editMode: OrderTechCardEditMode;
  variants: OrderTechCardVariantParamsDto[];
}

/**
 * Найти группу параметров расцветки по её `orderVariantId` — ЕДИНОЕ правило
 * сопоставления для плитки, окна и записи.
 *
 * Снимок группируется от числа расцветок (см. бэкенд `listForOrder`): при ≥2
 * расцветках — по группе на расцветку (`orderVariantId = <id>`), при 0–1 —
 * одна order-level группа под `orderVariantId = null`. У единственной
 * расцветки есть реальный id (плитка знает его), но её группа лежит под
 * `null`, поэтому строгий поиск по id промахивается. Без общего фолбэка это
 * всплывало то тут, то там: окно не находило группу и показывало «нет
 * техкарты», а запись улетала под id в группу, которую чтение не читает
 * (тихий no-op). Резолвер держит одно правило в одном месте.
 *
 * @returns группа или `undefined`, если её действительно нет.
 */
export function resolveVariantParamsGroup(
  params: OrderTechCardParametersDto | null | undefined,
  variantId: string | null,
): OrderTechCardVariantParamsDto | undefined {
  if (!params) return undefined;
  const exact = params.variants.find((g) => g.orderVariantId === variantId);
  if (exact) return exact;
  // Одна order-level группа обслуживает и «нет расцветок», и единственную
  // расцветку: её реальный id прилетает из плитки, но группа под `null`.
  if (
    params.variants.length === 1 &&
    params.variants[0].orderVariantId === null
  ) {
    return params.variants[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Значение слота. `null` / пустая строка = «не заполнено»: ячейка очищается
 * (она принадлежит параметру). Гейта полноты нет — обязательность снята
 * 16.07 (вернётся точечно для позиций из ЕРП по `owner=ERP`).
 */
export const SetOrderTechCardParameterValueSchema = z.object({
  value: z.string().trim().max(200).nullish(),
});
export type SetOrderTechCardParameterValueDto = z.infer<
  typeof SetOrderTechCardParameterValueSchema
>;

/**
 * Ad-hoc слот, заведённый прямо в заказе (в шаблоне его нет).
 *
 * `target` обязателен по смыслу: параметр — это переменная, подставляемая в
 * ЯЧЕЙКУ. Без цели значение некуда девать. Исключение — `target: null`:
 * «просто зафиксировать в спецификации» (параметр-запись для цеха, ни на что
 * не влияет).
 */
export const CreateOrderTechCardParameterSchema = z
  .object({
    /** null = order-level группа (заказ с 0–1 расцветкой). */
    orderVariantId: z.string().min(1).nullish(),
    key: TechCardParameterKeySchema,
    label: z.string().trim().min(1, 'Укажите название параметра').max(120),
    inputType: TechCardParameterInputTypeSchema.default('TEXT'),
    options: z.array(z.string().trim().min(1)).max(50).optional(),
    unit: z.string().trim().max(20).nullish(),
    isRequired: z.boolean().default(false),
    value: z.string().trim().max(200).nullish(),
    target: z
      .object({
        requirementId: z.string().min(1),
        field: TechCardParameterTargetSchema,
      })
      .nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.inputType === 'ENUM' && (!v.options || v.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Для параметра-списка укажите хотя бы одно значение',
      });
    }
  });
export type CreateOrderTechCardParameterDto = z.infer<
  typeof CreateOrderTechCardParameterSchema
>;


// ---------------------------------------------------------------------------
// Ручные строки материала (добавленные прямо в заказе)
// ---------------------------------------------------------------------------

/**
 * Откуда взялась норма расхода строки (`OrderMaterialRequirement.qtySource`):
 *
 *   - `NOMENCLATURE` — из карточки номенклатуры (нормы фурнитуры, погонные
 *     метры по размерам, площади). Пересчёт заказа освежает её при смене
 *     размерного плана — это и есть «одно число в спецификации и в закупке»;
 *   - `TEMPLATE`     — из шаблона техкарты (в номенклатуре источника не нашлось);
 *   - `ORDER`        — норму правили прямо в заказе; она главнее номенклатуры
 *     и переживает пересчёт, сбрасывает её только «Обновить нормы».
 *
 * `null` — строки, созданные до появления признака: показываем как «из
 * шаблона», пересчёт их из номенклатуры не переписывает.
 */
export type OrderMaterialQtySource = 'NOMENCLATURE' | 'TEMPLATE' | 'ORDER';

/** Норма из номенклатуры в разрезе размеров (погонные метры / площади). */
export interface OrderTechCardLineSizeNormDto {
  sizeId: string;
  sizeCode: string;
  /** Норма на изделие этого размера (Decimal строкой). */
  value: string;
  /** План по размеру у этой расцветки — по нему считается средневзвешенная. */
  qtyPlan: number;
}

/** Строка материала расцветки: из шаблона или добавленная в заказе. */
export interface OrderTechCardLineDto {
  /** `OrderMaterialRequirement.id`. */
  id: string;
  name: string;
  /** Единица ЗАКУПКИ («кг» у трикотажа) — в ней же считается `totalQty`. */
  unit: string;
  /**
   * Единица НОРМЫ, если строка развела расход и закупку («м пог.» при закупке
   * в «кг»). `null` — не расщеплена: норма и закупка в одной единице `unit`,
   * и экран показывает один блок вместо двух.
   */
  normUnit: string | null;
  /** Decimal как строка. Норма на изделие в `normUnit ?? unit`. */
  qtyPerUnit: string;
  /** Количество К ЗАКУПКЕ в `unit`. */
  totalQty: string;
  /**
   * Расход на весь тираж в единице НОРМЫ (`qtyPerUnit × тираж`). Заполнен
   * только у расщеплённых строк — у остальных совпал бы с `totalQty`.
   */
  totalNorm: string | null;
  /**
   * Почему пересчёт в закупочную единицу не сделан («не указана ширина
   * рулона»). `null` — либо пересчёт удался, либо он не требуется.
   * Показывается вместо числа: молчаливый ноль читается как «не нужно».
   */
  purchaseProblem: string | null;
  /** Цепочка пересчёта для примечания: «823.2 м пог. × 185 см / 100 × …». */
  purchaseFormula: string | null;
  materialRole: string | null;
  fabricType: string | null;
  colorText: string | null;
  /** Плотность (legacy-колонка `densityGsm`; зеркалится в characteristics). */
  densityGsm: number | null;
  /** true — добавлена прямо в заказе; шаблон о ней не знает. */
  isManual: boolean;
  /** Подтип материала (Молния / Кулирка / …) — задаёт набор характеристик. */
  subtypeKey: string | null;
  /** Значения характеристик подтипа: `{ density: 190, rollWidth: 180, … }`. */
  characteristics: MaterialCharacteristics | null;
  /** Откуда взята норма — см. {@link OrderMaterialQtySource}. */
  qtySource: OrderMaterialQtySource | null;
  /** Человекочитаемый источник нормы («Молния» из номенклатуры и т.п.). */
  qtySourceLabel: string | null;
  /**
   * Разбивка нормы по размерам, если в номенклатуре она задана поразмерно.
   * Пустой массив — норма плоская. Правится в заказе ОДНИМ числом: снимок
   * хранит одну норму на штуку, поразмерная разбивка — только показ источника.
   */
  qtyBySize: OrderTechCardLineSizeNormDto[];
  /**
   * Ячейки строки, занятые параметрами (`parameterBindings`): ключи вида
   * `core:qtyPerUnit` / `char:density`. Такую ячейку UI правит через
   * ЗНАЧЕНИЕ параметра, а не напрямую — два писателя в одну ячейку
   * запрещены (прямую правку backend отбивает 409
   * `ORDER_TECH_CARD_CELL_TAKEN`).
   */
  boundFields: string[];
}

/**
 * Добавить строку материала прямо в заказ (усилительная лента, которой нет в
 * шаблоне). Строка живёт в заказе и НЕ сносится пересборкой — даже при смене
 * техкарты: шаблон о ней не знает, значит и заменить её собой не может.
 */
export const CreateOrderTechCardLineSchema = z.object({
  /** null = order-level группа (заказ с 0–1 расцветкой). */
  orderVariantId: z.string().min(1).nullish(),
  name: z.string().trim().min(1, 'Укажите название материала').max(200),
  unit: z.string().trim().min(1, 'Укажите единицу измерения').max(20),
  /** Единица нормы, если она отличается от закупочной. Пусто — не расщепляем. */
  normUnit: z.string().trim().max(20).nullish(),
  qtyPerUnit: z
    .string()
    .trim()
    .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, {
      message: 'Норма расхода — положительное число',
    }),
  materialRole: z.string().trim().max(40).nullish(),
  fabricType: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
  /** Цвет строки: пусто = «не задан» (как `NO_COLOR` в шаблоне). */
  colorText: z.string().trim().max(120).nullish(),
  /**
   * Подтип материала — он задаёт НАБОР характеристик. Как и в правке, руками
   * не выбирается: UI выводит его из `fabricType` и присылает вместе с ним.
   */
  subtypeKey: z.string().trim().max(60).nullish(),
  /**
   * Значения характеристик: `{ density: 190, rollWidth: '180' }`. Пусто/`null`
   * — просто не записываем (очищать в новой строке нечего).
   *
   * Задавать характеристики при заведении НЕОБЯЗАТЕЛЬНО: строка создаётся
   * «голой», а параметры дозаполняются после — иначе заведение десяти
   * материалов упиралось бы в десять панелей характеристик.
   */
  characteristics: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional(),
});
export type CreateOrderTechCardLineDto = z.infer<
  typeof CreateOrderTechCardLineSchema
>;

/**
 * Максимум строк в одной пачке. Ограничение не про БД, а про пересборку:
 * каждая пачка тянет за собой ОДИН `resyncTechCardDerived` (снимок
 * материалов + план операций + потребности цеха), и его стоимость растёт
 * вместе с числом строк. Двадцати хватает на любой реальный список
 * фурнитуры; упрёмся — поднимем по факту замера.
 */
export const ORDER_TECH_CARD_LINES_BATCH_MAX = 20;

/**
 * Завести НЕСКОЛЬКО строк материала за один заход.
 *
 * Раньше материалы добавлялись по одному, и каждый вызов заканчивался
 * пересборкой производных (`createManualLine` → `resyncTechCardDerived`):
 * десять материалов = десять пересборок и десять шансов упасть на середине.
 * Пачка идёт одной транзакцией и одной пересборкой в конце.
 *
 * Расцветка — общая на всю пачку: строки заводятся в одной таблице, и
 * разъезжаться по разным группам им незачем.
 */
export const CreateOrderTechCardLinesSchema = z.object({
  /** null = order-level группа (заказ с 0–1 расцветкой). */
  orderVariantId: z.string().min(1).nullish(),
  lines: z
    .array(CreateOrderTechCardLineSchema.omit({ orderVariantId: true }))
    .min(1, 'Добавьте хотя бы одну строку')
    .max(
      ORDER_TECH_CARD_LINES_BATCH_MAX,
      `За один раз можно добавить не больше ${ORDER_TECH_CARD_LINES_BATCH_MAX} материалов`,
    ),
});
export type CreateOrderTechCardLinesDto = z.infer<
  typeof CreateOrderTechCardLinesSchema
>;

/**
 * Правка строки материала в заказе — ЛЮБОЙ строки, и шаблонной, и ручной.
 * «Техкарта живёт в заказе»: шаблон только сеет список, дальше каждая
 * строка — собственность заказа (решение 16.07, обязательность снята).
 *
 * Семантика полей — как в `UpdateOrderSchema`: поля нет = не трогать;
 * `colorText: null` / пустая строка = снять цвет; `densityGsm: null` =
 * убрать плотность. Ячейка, занятая параметром (`boundFields`), прямой
 * правке не подлежит — backend отвечает 409 `ORDER_TECH_CARD_CELL_TAKEN`,
 * UI правит её через значение параметра.
 *
 * Пересборка снимка (`resyncColorwayDerived`) правки переживает: ветка
 * ПЕРЕСЧЁТА читает собственные значения строки, а не шаблон (Фаза 2).
 * Правка цвета фиксируется как `FIXED_COLOR` — иначе пересчёт заново
 * вывел бы цвет из `colorRule` и правка тихо откатилась бы.
 */
export const UpdateOrderTechCardLineSchema = z
  .object({
    name: z.string().trim().min(1, 'Название не может быть пустым').max(200).optional(),
    unit: z.string().trim().min(1, 'Единица не может быть пустой').max(20).optional(),
    /**
     * Единица НОРМЫ. Пустая строка / `null` — схлопнуть расщепление обратно:
     * норма и закупка снова в одной единице `unit`.
     *
     * Правка одной только этой единицы норму не меняет, поэтому источник
     * нормы (`qtySource`) она НЕ понижает до `ORDER` — иначе строка перестала
     * бы освежаться из номенклатуры, хотя число осталось прежним.
     */
    normUnit: z.string().trim().max(20).nullish(),
    qtyPerUnit: z
      .string()
      .trim()
      .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, {
        message: 'Норма расхода — положительное число',
      })
      .optional(),
    colorText: z.string().trim().max(120).nullish(),
    densityGsm: z.number().int().positive().max(100_000).nullish(),
    /**
     * Характеристика материала («кулирка», «Молния», «кашкорсе 2×2») — то,
     * что менеджер выбирает в комбобоксе вместо убранного поля «Подтип»
     * (решение пользователя 29.07.2026). `null`/пусто — снять значение.
     */
    fabricType: z.string().trim().max(120).nullish(),
    /**
     * Подтип материала. Он задаёт НАБОР характеристик, поэтому смена подтипа
     * — событие того же уровня, что смена роли: сервис чистит значения,
     * которых у нового подтипа нет. `null` — снять подтип.
     *
     * Руками больше не выбирается: UI выводит его из `fabricType` (значение
     * из списка совпало с лейблом подтипа → его ключ) и присылает вместе с
     * ним. Поле остаётся в контракте, потому что снимок, cut-readiness и
     * costing продолжают читать `subtypeKey`.
     */
    subtypeKey: z.string().trim().max(60).nullish(),
    /**
     * Значения характеристик подтипа: `{ density: 190, rollWidth: '180' }`.
     * Ключ с `null`/пустой строкой = ОЧИСТИТЬ характеристику (вместе с её
     * legacy-колонкой — иначе зеркало тихо восстановит старое значение).
     * Ячейка под слот-параметром правке не подлежит: 409
     * `ORDER_TECH_CARD_CELL_TAKEN`.
     */
    characteristics: z
      .record(z.string(), z.union([z.string(), z.number(), z.null()]))
      .optional(),
  })
  .superRefine((v, ctx) => {
    // `normUnit` В СПИСКЕ ОБЯЗАТЕЛЕН: у расщеплённой строки («расход в
    // м пог., закупка в кг») правка ячейки единицы расхода шлёт патч
    // ровно из одного этого поля. Пока его тут не было, Zod отбивал
    // такой патч как «пустой», запрос до API не уходил вовсе, и снять
    // расщепление (`normUnit: null`) тоже было нельзя.
    if (
      v.name === undefined &&
      v.unit === undefined &&
      v.normUnit === undefined &&
      v.qtyPerUnit === undefined &&
      v.colorText === undefined &&
      v.densityGsm === undefined &&
      v.fabricType === undefined &&
      v.subtypeKey === undefined &&
      v.characteristics === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Укажите хотя бы одно поле для правки',
      });
    }
  });
export type UpdateOrderTechCardLineDto = z.infer<
  typeof UpdateOrderTechCardLineSchema
>;

export type { OrderTechCardParameterDto };
