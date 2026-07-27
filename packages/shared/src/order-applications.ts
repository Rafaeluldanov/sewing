/**
 * Контракты модуля «Нанесение на заказе покупателя»
 * (см. `prisma/schema.prisma::OrderApplication`,
 * `apps/api/src/modules/order-applications/*`,
 * `apps/web/lib/order-applications-api.ts`).
 *
 * Бизнес-логика:
 *   - В заказе покупателя может быть одно или несколько нанесений
 *     (`OrderApplication`). Параметры — атрибут конкретного заказа,
 *     а не техкарты или маршрута.
 *   - Если `stage = CUT_PARTS` (нанесение на крое / на деталях до
 *     пошива), то до запуска кроя система обязана убедиться, что
 *     параметры заполнены (см. `CutReadinessService`). При
 *     заполненных параметрах крой не блокируется, но появляется
 *     warning «после кроя детали нужно отправить на нанесение».
 *   - Если `stage = FINISHED_ITEM` — крой не блокируется, в готовности
 *     к крою показывается info/warning «нанесение выполняется на
 *     готовом изделии».
 *
 * Поля и типы — точная копия Prisma-модели (см. JSDoc на
 * `OrderApplication` в schema.prisma). Decimal-поля сериализуются как
 * строки — таким же стилем, как `WorkshopNeed.calculatedQty` /
 * `OrderMaterialRequirement.qtyPerUnit`. Это позволяет UI безопасно
 * показывать значения, не теряя точности через JS-`number`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types: enums-as-strings + labels
// ---------------------------------------------------------------------------

/**
 * Допустимые типы нанесения. Хранится как свободная строка в БД
 * (`OrderApplication.type`), Zod-схема и UI-формы используют этот
 * массив как источник истины. Расширение списка не требует миграции.
 */
export const ORDER_APPLICATION_TYPES = [
  'SCREEN_PRINT',
  'DTF',
  'EMBROIDERY',
  'HEAT_TRANSFER',
  'SUBLIMATION',
  'OTHER',
] as const;

export const OrderApplicationTypeSchema = z.enum(ORDER_APPLICATION_TYPES);
export type OrderApplicationType = z.infer<typeof OrderApplicationTypeSchema>;

/**
 * Человекочитаемые лейблы для UI карточки заказа и select-а
 * «Тип нанесения».
 */
export const ORDER_APPLICATION_TYPE_LABELS: Record<
  OrderApplicationType,
  string
> = {
  SCREEN_PRINT: 'Шелкография',
  DTF: 'DTF',
  EMBROIDERY: 'Вышивка',
  HEAT_TRANSFER: 'Термотрансфер',
  SUBLIMATION: 'Сублимация',
  OTHER: 'Другое',
};

/**
 * `stage` — на каком этапе выполняется нанесение:
 *   - `CUT_PARTS`     — на крое / на деталях до пошива;
 *   - `FINISHED_ITEM` — на готовом изделии.
 *
 * От `stage` зависит логика готовности к крою (см.
 * `CutReadinessService`).
 */
export const ORDER_APPLICATION_STAGES = [
  'CUT_PARTS',
  'FINISHED_ITEM',
] as const;

export const OrderApplicationStageSchema = z.enum(ORDER_APPLICATION_STAGES);
export type OrderApplicationStage = z.infer<typeof OrderApplicationStageSchema>;

export const ORDER_APPLICATION_STAGE_LABELS: Record<
  OrderApplicationStage,
  string
> = {
  CUT_PARTS: 'На крое',
  FINISHED_ITEM: 'На готовом изделии',
};

/**
 * `status` — жизненный цикл нанесения. На MVP:
 *   - `PLANNED`   — менеджер завёл строку, ещё ничего не сделано;
 *   - `SENT`      — отправлено подрядчику / в нанесение;
 *   - `DONE`      — выполнено;
 *   - `CANCELLED` — отменено (учитывается как «не делаем»).
 *
 * Переходы статуса на этом этапе не валидируются строго — менеджер
 * двигает руками. Жёсткий state-machine добавится позже, когда
 * подключим UI «отдать на нанесение / получить обратно».
 */
export const ORDER_APPLICATION_STATUSES = [
  'PLANNED',
  'SENT',
  'DONE',
  'CANCELLED',
] as const;

export const OrderApplicationStatusSchema = z.enum(
  ORDER_APPLICATION_STATUSES,
);
export type OrderApplicationStatus = z.infer<
  typeof OrderApplicationStatusSchema
>;

export const ORDER_APPLICATION_STATUS_LABELS: Record<
  OrderApplicationStatus,
  string
> = {
  PLANNED: 'Запланировано',
  SENT: 'Отправлено',
  DONE: 'Выполнено',
  CANCELLED: 'Отменено',
};

// ---------------------------------------------------------------------------
// Field schemas (reusable)
// ---------------------------------------------------------------------------

/**
 * Optional строковое поле с тримом + null/empty → null. Используется
 * для placement / colorText / description / comment / fileUrl.
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
 * Положительное целое число с null/undefined-fallback. Используется
 * для widthMm / heightMm / colorsCount: значение либо положительное,
 * либо «не задано».
 */
const positiveIntOptional = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    return v;
  },
  z
    .number({ invalid_type_error: 'Должно быть числом' })
    .int('Целое число')
    .positive('Должно быть > 0')
    .nullable()
    .optional(),
);

/**
 * Optional Decimal-строка для `quantity`. Принимаем строку или число,
 * нормализуем в строку с точкой; пустую строку и null трактуем как
 * «не задано». На сервере оборачиваем в `Prisma.Decimal`.
 */
const decimalQuantityOptional = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return v;
      return v.toString();
    }
    if (typeof v === 'string') {
      const trimmed = v.trim().replace(',', '.');
      return trimmed === '' ? null : trimmed;
    }
    return v;
  },
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, 'Число с точкой')
    .refine(
      (v) => Number(v) > 0,
      { message: 'Количество должно быть > 0' },
    )
    .nullable()
    .optional(),
);

/**
 * Optional unit. Дефолт «шт» проставляется на бэкенде, если поле
 * не задано / пустая строка. Принимаем 1..32 символа.
 */
const unitOptional = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return undefined;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? undefined : trimmed;
  },
  z
    .string()
    .min(1)
    .max(32, 'Единица не длиннее 32 символов')
    .optional(),
);

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * Одна адресация нанесения на размер заказа (этап «Нанесение по
 * размерам / части тиража»).
 *   - `sizeId` обязателен;
 *   - `quantity` опционально: null/пусто = «весь этот размер»
 *     (фоллбэк на `OrderItem.qtyPlan`), число = «N штук размера».
 */
export const OrderApplicationSizeInputSchema = z.object({
  sizeId: z.string().min(1, 'Не выбран размер'),
  quantity: decimalQuantityOptional,
});

export type OrderApplicationSizeInput = z.infer<
  typeof OrderApplicationSizeInputSchema
>;

/**
 * Одна строка ввода в `PUT /api/orders/:id/applications`. Поля:
 *   - `type` обязателен;
 *   - `stage` обязателен (CUT_PARTS / FINISHED_ITEM);
 *   - размеры/количество/cnt цветов — необязательно, но если задано
 *     — валидируется как «> 0».
 *   - `sizes` — адресация по размерам (этап «Нанесение по размерам»).
 *     Пустой массив = нанесение на весь тираж. Непустой = нанесение
 *     только на перечисленные размеры; в этом случае order-level
 *     `quantity` игнорируется (количество берётся по каждому размеру).
 *   - `status` опционален, дефолт `PLANNED` на бэке.
 */
export const OrderApplicationInputSchema = z.object({
  type: OrderApplicationTypeSchema,
  stage: OrderApplicationStageSchema,
  placement: optionalNullableString(200, 'Место'),
  widthMm: positiveIntOptional,
  heightMm: positiveIntOptional,
  colorsCount: positiveIntOptional,
  quantity: decimalQuantityOptional,
  unit: unitOptional,
  colorText: optionalNullableString(200, 'Цвет'),
  description: optionalNullableString(2000, 'Описание'),
  comment: optionalNullableString(2000, 'Комментарий'),
  fileUrl: optionalNullableString(2000, 'Ссылка на файл'),
  status: OrderApplicationStatusSchema.optional(),
  // Комплект нанесений (этап «Комплекты нанесений»): groupKey —
  // стабильный id комплекта, groupLabel — название. Оба пустые =
  // одиночное нанесение.
  groupKey: optionalNullableString(60, 'Комплект'),
  groupLabel: optionalNullableString(120, 'Название комплекта'),
  sizes: z
    .array(OrderApplicationSizeInputSchema)
    // Один размер не может фигурировать в нанесении дважды (совпадает с
    // `@@unique([applicationId, sizeId])` в БД).
    .refine(
      (rows) => new Set(rows.map((r) => r.sizeId)).size === rows.length,
      { message: 'Размер указан дважды в одном нанесении' },
    )
    .optional()
    .default([]),
});

export type OrderApplicationInput = z.infer<typeof OrderApplicationInputSchema>;

/**
 * Тело запроса `PUT /api/orders/:id/applications`. Семантика — full
 * replace списка нанесений по заказу: backend в одной транзакции
 * удаляет существующие и создаёт переданные. Это сознательная
 * простота на MVP — те же кейсы, что у `replaceMaterialLines` /
 * `replaceMaterialAreas`.
 */
export const ReplaceOrderApplicationsSchema = z.object({
  applications: z.array(OrderApplicationInputSchema),
});

export type ReplaceOrderApplicationsDto = z.infer<
  typeof ReplaceOrderApplicationsSchema
>;

// ---------------------------------------------------------------------------
// Output DTO
// ---------------------------------------------------------------------------

/**
 * Серверная сериализация одной строки `OrderApplication`.
 * `quantity` — строка (Decimal), чтобы UI не терял точности.
 * Для удобства в UI добавляются `typeLabel` / `stageLabel` /
 * `statusLabel` — backend сразу подставляет лейблы, чтобы UI не
 * дублировал словари при каждом рендере.
 */
/**
 * Адресация нанесения на один размер заказа в DTO. `quantity` —
 * строка (Decimal) или null = «весь размер».
 */
export interface OrderApplicationSizeDto {
  sizeId: string;
  sizeCode: string;
  quantity: string | null;
}

export interface OrderApplicationDto {
  id: string;
  orderId: string;
  type: OrderApplicationType;
  typeLabel: string;
  stage: OrderApplicationStage;
  stageLabel: string;
  placement: string | null;
  widthMm: number | null;
  heightMm: number | null;
  colorsCount: number | null;
  quantity: string | null;
  unit: string;
  colorText: string | null;
  description: string | null;
  comment: string | null;
  fileUrl: string | null;
  status: OrderApplicationStatus;
  statusLabel: string;
  /**
   * Комплект нанесений (этап «Комплекты нанесений»). `groupKey` —
   * стабильный id комплекта, `groupLabel` — его название. Оба null =
   * одиночное нанесение (вне комплекта). У всех нанесений одного
   * комплекта одинаковая адресация (`quantity`/`sizes`).
   */
  groupKey: string | null;
  groupLabel: string | null;
  /**
   * Адресация по размерам (этап «Нанесение по размерам / части
   * тиража»). Пустой массив = нанесение на весь тираж. Непустой =
   * нанесение только на эти размеры.
   */
  sizes: OrderApplicationSizeDto[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Окно редактирования
// ---------------------------------------------------------------------------

/**
 * Статусы заказа, в которых список нанесений можно менять, —
 * ЕДИНЫЙ источник правды для backend-гейта
 * (`OrderApplicationsService.replaceForOrder` → 409
 * `ORDER_APPLICATION_ORDER_LOCKED`) и для UI (карточка «Нанесение» в
 * форме правки заказа и во вкладке «Производство»).
 *
 * Окно — «пока расчёт не завершён»: черновик и идущий расчёт. На
 * `CALCULATION` правка нанесений тянет за собой пересчёт потребности
 * цеха (строки `WorkshopNeed` с `sourceType = ORDER_APPLICATION`),
 * поэтому сервис после сохранения сам зовёт пересчёт — ровно то же
 * окно и та же механика, что у расцветок (`ORDER_COLORWAYS_LOCKED` +
 * `resyncColorwayDerived`).
 *
 * С `CALCULATION_DONE` и дальше себестоимость и потребность
 * зафиксированы — список read-only, менять через «Вернуть на
 * пересчёт».
 */
export const ORDER_APPLICATION_EDITABLE_ORDER_STATUSES = [
  'DRAFT',
  'CALCULATION',
] as const;

/**
 * Можно ли править нанесения на заказе в этом статусе. Строка, а не
 * `OrderStatus`, — чтобы не тянуть сюда `orders.ts` (он сам импортирует
 * этот модуль ради `OrderDetailDto.applications`).
 */
export function isOrderApplicationsEditable(status: string): boolean {
  return (ORDER_APPLICATION_EDITABLE_ORDER_STATUSES as readonly string[]).includes(
    status,
  );
}

/**
 * Человекочитаемое описание «области применения» нанесения — для
 * read-only карточки заказа, описания потребности цеха и т.п.
 *   - нет размеров → «Весь тираж» или «N <unit> из тиража», если задан
 *     order-level `quantity`;
 *   - есть размеры → «M — 10 шт, L — весь размер».
 */
export function describeApplicationScope(
  app: Pick<OrderApplicationDto, 'quantity' | 'unit' | 'sizes'>,
): string {
  if (app.sizes.length > 0) {
    return app.sizes
      .map((s) =>
        s.quantity != null
          ? `${s.sizeCode} — ${s.quantity} ${app.unit}`
          : `${s.sizeCode} — весь размер`,
      )
      .join(', ');
  }
  if (app.quantity != null) {
    return `${app.quantity} ${app.unit} из тиража`;
  }
  return 'Весь тираж';
}

/**
 * Helper «есть ли в строке нанесения базовое описание» — использует
 * `CutReadinessService`, чтобы решить, считать ли CUT_PARTS-строку
 * «заполненной». Условия копируются здесь и в backend-сервисе, чтобы
 * shared-helper можно было использовать на UI для подсветки строк.
 *
 * Правило: считаем строку «заполненной», если есть тип (он всегда
 * есть, валидируется Zod-ом) И хотя бы одно из:
 *   - `placement` (место);
 *   - `description` (текст принта / описание);
 *   - размер (`widthMm` И `heightMm`).
 *
 * `quantity` сознательно НЕ считаем обязательным — без него
 * `WorkshopNeedsService` фоллбэчит на `Σ OrderItem.qtyPlan`, и крой
 * не должен из-за этого блокироваться.
 */
export function isOrderApplicationDataFilled(
  app: Pick<
    OrderApplicationDto,
    'type' | 'placement' | 'description' | 'widthMm' | 'heightMm'
  >,
): boolean {
  if (!app.type) return false;
  if (app.placement && app.placement.trim() !== '') return true;
  if (app.description && app.description.trim() !== '') return true;
  if (app.widthMm != null && app.heightMm != null) return true;
  return false;
}
