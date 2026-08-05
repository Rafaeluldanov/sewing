/**
 * Контракты модуля «Заказы» (Шаг 4 MVP).
 *
 * Zod-схемы здесь — источник истины для валидации запросов на API и
 * клиентских форм на web. `type`-алиасы ниже выведены из схем, чтобы
 * web и api жили на одних и тех же DTO.
 *
 * ВАЖНО (Шаг 5):
 * - `qtyCutFact*` — заполняется из паспортов (`Σ passport.qtyCut` по
 *   сохранённым паспортам заказа, см. `apps/api/src/modules/orders/order-aggregator.ts`);
 * - `qtyInSewing*` / `qtyQc*` / `qtyWto*` / `qtyPacking*` /
 *   `qtyFinished*` / `qtyDefect*` — пока всегда 0; подключатся на
 *   Шагах 6–8 (выдача кроя, пошивные операции, ОТК, ВТО, упаковка) без
 *   изменения этого DTO-контракта.
 */

import { z } from 'zod';

import { normalizeColor } from './colors';
import { ColorwaySizeInputSchema } from './colorways';
import type { OrderDeadlineEvaluation, OrderDeadlineStatus } from './order-deadlines';
import { ORDER_DEADLINE_STATUSES } from './order-deadlines';
import type { OrderCostEstimateDto } from './order-cost-estimates';
// Type-only импорт: `order-transitions` в свою очередь тянет
// `OrderStatus` отсюда — цикл существует только на уровне типов и
// стирается при компиляции.
import type { OrderTransitionDto } from './order-transitions';
import type {
  OrderRouteStepDto,
  OrderRouteStepSizeOverrideDto,
} from './routes';
import type {
  OutsourceTriggerType,
  TechCardMaterialColorRule,
} from './tech-cards';
import type { MaterialRole } from './material-roles';
import type { OrderApplicationDto } from './order-applications';
import type { ConstructorTaskSummaryDto } from './constructor-tasks';
import {
  OrderApplicationInputSchema,
  type OrderApplicationInput,
} from './order-applications';
import { MoneyCurrencySchema, type MoneyCurrency } from './money';

/**
 * Re-export snapshot-шага маршрута, чтобы консьюмеры `OrderDetailDto`
 * могли импортировать оба типа из одного модуля
 * (`@sewing/shared/orders`) — это backward-compatible расширение
 * поверхности модуля «Заказы».
 */
export type { OrderRouteStepDto };
export type { OrderRouteStepSizeOverrideDto };

/**
 * Re-export типа триггера активации внешней потребности — чтобы UI
 * карточки заказа мог импортировать всё необходимое из одного
 * модуля (`@sewing/shared/orders`) и не зависеть напрямую от
 * `@sewing/shared/tech-cards`.
 */
export type { OutsourceTriggerType };

// ---------------------------------------------------------------------------
// Outsource execution status (MVP-3 техкарт, ADR-0022
// §«Manual execution status»).
// ---------------------------------------------------------------------------

/**
 * Ручной операционный статус выполнения внешней потребности
 * (`OrderOutsourceRequirement.executionStatus`). Источник истины —
 * Prisma enum `OrderOutsourceExecutionStatus`.
 *
 * - `PLANNED`  — дефолтное состояние, ручной перевод ещё не делался;
 * - `ORDERED`  — менеджер отметил «отдали подрядчику»;
 * - `RECEIVED` — менеджер отметил «получено обратно».
 *
 * `READY_TO_ORDER` сюда **не входит** — это derived display-state, в
 * БД не хранится (см. `OrderOutsourceDisplayStatus` ниже).
 */
export const ORDER_OUTSOURCE_EXECUTION_STATUSES = [
  'PLANNED',
  'ORDERED',
  'RECEIVED',
] as const;
export const OrderOutsourceExecutionStatusSchema = z.enum(
  ORDER_OUTSOURCE_EXECUTION_STATUSES,
);
export type OrderOutsourceExecutionStatus = z.infer<
  typeof OrderOutsourceExecutionStatusSchema
>;

/**
 * Композитный display-статус строки внешней потребности, который
 * показывает UI карточки заказа. Считается at-read backend-ом в
 * `OrdersService.getOne()` по правилу:
 *
 *   - `executionStatus === 'RECEIVED'` → `RECEIVED`
 *   - `executionStatus === 'ORDERED'` → `ORDERED`
 *   - `executionStatus === 'PLANNED'` && `triggerType === 'CUT_READY'`
 *     && `isReadyToOrder` → `READY_TO_ORDER`
 *   - иначе → `PLANNED`
 *
 * В БД **не хранится** — это read-model. См. ADR-0022, «Почему
 * READY_TO_ORDER не пишем в БД».
 */
export const ORDER_OUTSOURCE_DISPLAY_STATUSES = [
  'PLANNED',
  'READY_TO_ORDER',
  'ORDERED',
  'RECEIVED',
] as const;
export type OrderOutsourceDisplayStatus =
  (typeof ORDER_OUTSOURCE_DISPLAY_STATUSES)[number];

/**
 * Этап «Указать в заказе» (см. ТЗ §4): тело
 * `PATCH /api/orders/:id/material-requirements/:requirementId/color`.
 *
 * Допускается:
 *   - непустая строка длиной ≤ 120 символов — сохранить цвет;
 *   - пустая строка / `null` — стереть ранее сохранённый цвет.
 *
 * Backend сохраняет значение только для строк, у которых
 * `requiresColorSelection = true` (т.е. в техкарте `colorRule =
 * ORDER_SELECTED_COLOR`); для прочих строк отвечает 409
 * `ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED`.
 */
export const UpdateOrderMaterialRequirementColorSchema = z.object({
  selectedColorText: z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const n = normalizeColor(v);
      return n === '' ? null : n;
    },
    z
      .string()
      .max(120, 'Цвет: не длиннее 120 символов')
      .nullable(),
  ),
});
export type UpdateOrderMaterialRequirementColorDto = z.infer<
  typeof UpdateOrderMaterialRequirementColorSchema
>;

/**
 * Zod-схема тела `POST /api/orders/:id/outsource-requirements/:requirementId/status`
 * (см. `docs/api.md §«orders»`).
 *
 * Через action разрешены **только** прямые переходы вперёд:
 * `PLANNED → ORDERED` и `ORDERED → RECEIVED`. Поэтому `executionStatus`
 * принимает только два значения; обратный откат в `PLANNED` через
 * action сознательно запрещён (см. ADR-0022 §«Manual execution
 * status», «Почему линейные переходы»).
 */
export const UpdateOrderOutsourceRequirementStatusSchema = z.object({
  executionStatus: z.enum(['ORDERED', 'RECEIVED']),
});
export type UpdateOrderOutsourceRequirementStatusDto = z.infer<
  typeof UpdateOrderOutsourceRequirementStatusSchema
>;

// ---------------------------------------------------------------------------
// Order logistics lines (ручные строки логистики в таблице «Операции»
// карточки заказа). Источник истины — Prisma-модель `OrderLogisticsLine`
// + enum `OrderLogisticsStatus`. См.
// `apps/api/src/modules/orders/orders.service.ts`,
// `apps/web/components/orders/operations/*`.
// ---------------------------------------------------------------------------

/**
 * Статус ручной строки логистики заказа. Совпадает с Prisma enum
 * `OrderLogisticsStatus`. Поле «Статус» в окне «Добавить поле»
 * необязательно — его можно убрать перед сохранением, тогда на строке
 * `status = null` (DTO отдаёт `null`, а не значение из этого списка).
 */
export const ORDER_LOGISTICS_STATUSES = [
  'ORDERED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
] as const;
export const OrderLogisticsStatusSchema = z.enum(ORDER_LOGISTICS_STATUSES);
export type OrderLogisticsStatus = z.infer<typeof OrderLogisticsStatusSchema>;

/**
 * Человекочитаемые подписи статусов логистики для UI (выпадающий
 * список в окне + бейдж в таблице). Единая точка правды — UI словари
 * не дублирует.
 */
export const ORDER_LOGISTICS_STATUS_LABELS: Record<
  OrderLogisticsStatus,
  string
> = {
  ORDERED: 'Заказано',
  IN_TRANSIT: 'В пути',
  DELIVERED: 'Доставлено',
  CANCELLED: 'Отменено',
};

/**
 * DTO ручной строки логистики заказа (отдаётся в
 * `OrderDetailDto.logisticsLines`).
 *
 *   - `name`             — «Операция» (название строки), всегда есть;
 *   - `status`           — выбранный статус или `null` (поле убрано);
 *   - `statusLabel`      — derived-подпись статуса (или `null`);
 *   - `deliveryDeadline` — «Сроки доставки», ISO-string или `null`;
 *   - `costRub`          — «Стоимость» в рублях, Decimal сериализуется
 *     строкой (как у `OrderMaterialRequirementDto.totalQty`).
 */
export interface OrderLogisticsLineDto {
  id: string;
  sortOrder: number;
  name: string;
  status: OrderLogisticsStatus | null;
  statusLabel: string | null;
  deliveryDeadline: string | null;
  costRub: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * `costRub` приходит из формы строкой (`"1 200,50"`) или числом —
 * нормализуем запятую и пробелы, валидируем как неотрицательное число.
 * Источник истины формата — это место, чтобы api и web считали одинаково.
 */
const OrderLogisticsCostSchema = z.preprocess(
  (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const cleaned = v.replace(/\s/g, '').replace(',', '.');
      if (cleaned === '') return undefined;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : v;
    }
    return v;
  },
  z
    .number({ invalid_type_error: 'Стоимость: укажите число' })
    .min(0, 'Стоимость не может быть отрицательной')
    .max(1_000_000_000, 'Стоимость слишком большая'),
);

/**
 * `deliveryDeadline` — необязательная дата доставки. Принимаем ISO-
 * строку (`YYYY-MM-DD` из `<input type="date">` или полный ISO) либо
 * `null`/пустую строку → `null` (поле «Сроки доставки» убрано). На
 * выходе — нормализованная ISO-строка либо `null`.
 */
const OrderLogisticsDeadlineSchema = z.preprocess(
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
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: 'Сроки доставки: некорректная дата',
    })
    .nullable(),
);

const OrderLogisticsNameSchema = z
  .string({ required_error: 'Укажите операцию' })
  .trim()
  .min(1, 'Укажите операцию')
  .max(200, 'Операция: не длиннее 200 символов');

/**
 * Тело `POST /api/orders/:id/logistics-lines` — создание ручной строки
 * логистики. `name` и `costRub` обязательны (поля нельзя удалить в
 * окне); `status` и `deliveryDeadline` опциональны — их поля можно
 * убрать перед сохранением, тогда они `null`/отсутствуют.
 */
export const CreateOrderLogisticsLineSchema = z.object({
  name: OrderLogisticsNameSchema,
  costRub: OrderLogisticsCostSchema,
  status: OrderLogisticsStatusSchema.nullish(),
  deliveryDeadline: OrderLogisticsDeadlineSchema.optional(),
});
export type CreateOrderLogisticsLineDto = z.infer<
  typeof CreateOrderLogisticsLineSchema
>;

/**
 * Тело `PATCH /api/orders/:id/logistics-lines/:lineId` — правка строки.
 * Контракт совпадает с create: UI отправляет полный набор полей (форма
 * пере-собирается целиком), поэтому отдельной partial-схемы не вводим.
 */
export const UpdateOrderLogisticsLineSchema = CreateOrderLogisticsLineSchema;
export type UpdateOrderLogisticsLineDto = z.infer<
  typeof UpdateOrderLogisticsLineSchema
>;

// ---------------------------------------------------------------------------
// Tech card snapshot DTO (см. `docs/domain.md §«Техкарты»`, ADR-0022)
// ---------------------------------------------------------------------------

/**
 * Snapshot строки материала на конкретном заказе. Источник истины —
 * `OrderMaterialRequirement` (см. `prisma/schema.prisma`). Поля копируют
 * `TechCardMaterialLine` в момент `OrdersService.start()` плюс
 * посчитанный `totalQty = qtyPerUnit * Σ qtyPlan` по строкам заказа.
 */
export interface OrderMaterialRequirementDto {
  id: string;
  sortOrder: number;
  name: string;
  unit: string;
  /** Decimal как строка (см. `Prisma.Decimal`). */
  qtyPerUnit: string;
  totalQty: string;
  note: string | null;
  /**
   * Этап 3 «Потребности цеха» (см. `docs/recon-soft-integration.md
   * §«Этап 3»`). Snapshot-копии новых полей `TechCardMaterialLine`,
   * зафиксированные в `OrdersService.start()`. Все nullable +
   * backward-compatible: для старых snapshot-строк (созданных до
   * этапа 3) отдаются `null` — UI на это рассчитан.
   *
   * `resolvedColorText` — derived в момент `start()` по `colorRule`:
   *   - `ORDER_COLOR` → `Order.color` (или null);
   *   - `FIXED_COLOR` → `fixedColorText` (или null);
   *   - `NO_COLOR`    → null;
   *   - null/empty    → null.
   */
  /**
   * `materialRole` хранится в БД свободной строкой (`String?`) — list
   * ролей расширяется без миграции (см.
   * `@sewing/shared/pattern-categories::PATTERN_CATEGORY_PARAMETER_GROUPS`).
   * UI карточки заказа должен через `getTechCardMaterialRoleLabel`
   * получить человекочитаемую строку, не делая `MATERIAL_ROLE_LABELS[r]`
   * (последний знает только legacy whitelist).
   */
  materialRole: MaterialRole | string | null;
  fabricType: string | null;
  densityGsm: number | null;
  plannedWidthCm: number | null;
  colorRule: TechCardMaterialColorRule | null;
  fixedColorText: string | null;
  resolvedColorText: string | null;
  /**
   * Этап «Указать в заказе» (см. ТЗ §4): если строка материала
   * техкарты создана с `colorRule = ORDER_SELECTED_COLOR`, в snapshot
   * заказа фиксируется флаг `requiresColorSelection = true` — UI
   * карточки заказа показывает поле «Цвет» с подсказкой «Цвет нужно
   * указать в заказе». Менеджер вводит значение через
   * `PATCH /api/orders/:id/material-requirements/:requirementId/color`.
   *
   * `selectedColorText` — введённое менеджером значение; по умолчанию
   * `null`. Когда оно заполнено, `resolvedColorText` для строки
   * становится равен `selectedColorText` (см.
   * `OrdersService.updateMaterialRequirementColor`).
   *
   * Оба поля опциональны (`?`) — старые потребители без пересборки
   * shared-пакета продолжают компилироваться, snapshot-строки до
   * введения этой фичи отдают `requiresColorSelection = false` и
   * `selectedColorText = null`.
   */
  requiresColorSelection?: boolean;
  selectedColorText?: string | null;
  /**
   * Этап «Фурнитура / изображение» (см. ТЗ §3, §5): snapshot-копии
   * новых полей `TechCardMaterialLine`. Snapshot-логика прежняя:
   * заполняются в `OrdersService.start()` из шаблона, дальше живут
   * независимо. Старые snapshot-строки → `null` по каждому полю.
   */
  hardwareSizeText?: string | null;
  hardwareMaterialText?: string | null;
  materialImageUrl?: string | null;
  materialImageOriginalFileName?: string | null;
}

/**
 * Snapshot строки внешнего подрядного размещения на конкретном заказе.
 * `qtyPerUnit`/`totalQty`/`unit` могут быть null — это нормально для
 * подряда, который считается «за партию» без явной нормы.
 *
 * Поля `triggerType`, `isReadyToOrder`, `readinessLabel` относятся к
 * MVP-2 «Готовность кроя для внешней потребности» (ADR-0022
 * §«Cut-ready readiness»). Это **derived read-only** поля:
 *
 *   - `triggerType` копируется в snapshot из шаблона при
 *     `OrdersService.start()` и хранится в БД (см. Prisma model
 *     `OrderOutsourceRequirement.triggerType`);
 *   - `isReadyToOrder` и `readinessLabel` **не хранятся в БД**, а
 *     вычисляются на чтении в `OrdersService.getOne()` по правилу
 *     ALL_PASSPORTS: «у заказа есть паспорта и у каждого
 *     `Passport.currentCellId != null`». Никаких side-effect / БД-
 *     статусов / cron-ов на MVP не вводится.
 *
 * Для `triggerType = MANUAL` всегда `isReadyToOrder = false` и
 * `readinessLabel = null` — UI на карточке заказа в этом случае не
 * рисует индикатор готовности.
 */
export interface OrderOutsourceRequirementDto {
  id: string;
  sortOrder: number;
  name: string;
  unit: string | null;
  qtyPerUnit: string | null;
  totalQty: string | null;
  vendorName: string | null;
  note: string | null;
  /**
   * Snapshot триггера активации (см. `OutsourceTriggerType` в
   * `@sewing/shared/tech-cards`). На MVP — `MANUAL` или `CUT_READY`.
   */
  triggerType: OutsourceTriggerType;
  /**
   * Derived: «потребность готова к заказу». На MVP true только если
   * `triggerType === 'CUT_READY'` и весь крой заказа размещён в
   * ячейки. Для `MANUAL` всегда false.
   */
  isReadyToOrder: boolean;
  /**
   * Derived: человекочитаемая подпись индикатора. Для `CUT_READY` —
   * `"Готово к заказу"` или `"Ожидает размещения кроя"`; для
   * `MANUAL` — `null` (UI не показывает индикатор).
   */
  readinessLabel: string | null;
  /**
   * MVP-3 (ADR-0022 §«Manual execution status»): ручной операционный
   * статус выполнения внешней потребности (источник истины — БД).
   * Меняется только через action
   * `POST /api/orders/:id/outsource-requirements/:requirementId/status`.
   */
  executionStatus: OrderOutsourceExecutionStatus;
  /**
   * Когда менеджер впервые перевёл строку в `ORDERED` (ISO-string).
   * `null` пока перехода не было. Не редактируется руками.
   */
  orderedAt: string | null;
  /**
   * Когда менеджер перевёл строку в `RECEIVED` (ISO-string).
   * `null` пока перехода не было. Не редактируется руками.
   */
  receivedAt: string | null;
  /**
   * Композитный display-статус для UI карточки заказа. Считается
   * at-read backend-ом из `executionStatus` + `triggerType` +
   * `isReadyToOrder`. В БД **не хранится** (см. ADR-0022).
   */
  displayStatus: OrderOutsourceDisplayStatus;
  /**
   * Человекочитаемая подпись `displayStatus` для UI:
   * - `RECEIVED` → "Получено";
   * - `ORDERED` → "Заказано";
   * - `READY_TO_ORDER` → "Готово к заказу";
   * - `PLANNED` + `CUT_READY` → "Ожидает размещения кроя";
   * - `PLANNED` + `MANUAL` → `null` (UI остаётся нейтральным,
   *   ничего не дорисовывает).
   */
  displayStatusLabel: string | null;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Статусы заказа. Совпадают с `OrderStatus` в Prisma-схеме.
 *
 * - `DRAFT`            — черновик, план ещё редактируется
 * - `CALCULATION`      — менеджер перевёл заказ в расчёт; backend
 *   автоматически собрал «Потребность цеха»
 *   (см. `OrdersService.startCalculation`,
 *   `WorkshopNeedsService.calculateForOrder`).
 *   Из этого статуса можно либо вернуться к ручному пересчёту
 *   потребности (force), либо запустить заказ в производство.
 * - `CALCULATION_DONE` — расчёт себестоимости завершён (см.
 *   `OrdersService.completeCalculation`,
 *   `prisma/schema.prisma::OrderCostEstimate`). Закупщик заполнил
 *   `purchaseQty` / `quotedPrice` / `quotedCurrency` по строкам
 *   `WorkshopNeed`, нажал «Завершить расчёт» — backend зафиксировал
 *   `OrderCostEstimate` и snapshot-поля `Order.costEstimate*`.
 *   Из этого статуса допустимо: (а) запустить заказ в производство
 *   (`start()` принимает CALCULATION_DONE так же, как CALCULATION /
 *   DRAFT), (б) вернуть на пересчёт (`reopenCalculation`).
 * - `SAMPLE_PRODUCTION` — производство сигнального образца: образец
 *   запущен (`OrderSamplesService.start`) без запуска тиража; тиражный
 *   крой/паспорта не создаются. Дальше → `IN_PRODUCTION` (полный запуск).
 * - `IN_PRODUCTION`    — запущен в производство, план иммутабелен (ADR-0006)
 * - `DONE`             — завершён (ручной перевод на Шаге 4)
 * - `CANCELLED`        — отменён
 *
 * UI-порядок статусов задаётся явно через этот массив (Postgres
 * enum складывает новые значения «в конец» по `ALTER TYPE … ADD
 * VALUE`, поэтому БД-порядок и UI-порядок различаются — это
 * нормально).
 */
export const ORDER_STATUSES = [
  'DRAFT',
  'CALCULATION',
  'CALCULATION_DONE',
  'SAMPLE_PRODUCTION',
  'IN_PRODUCTION',
  'DONE',
  'CANCELLED',
] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/**
 * Статусы заказа, из которых разрешён запуск сигнального образца
 * (`OrderSamplesService.start`). Источник истины — используется и в
 * backend-гейте, и в web-UI (кнопка «Запустить образец»):
 *   - `CALCULATION` / `CALCULATION_DONE` — образец запускается без
 *     тиража, заказ переходит в `SAMPLE_PRODUCTION`;
 *   - `SAMPLE_PRODUCTION` — можно запустить ещё образец (статус не
 *     меняется);
 *   - `IN_PRODUCTION` — образец параллельно с тиражом (статус не
 *     меняется).
 * `DRAFT` исключён намеренно: образец требует рассчитанного плана
 * (маршрут/техкарта зафиксированы на этапе расчёта). `DONE` /
 * `CANCELLED` — заказ закрыт.
 */
export const ORDER_SAMPLE_LAUNCHABLE_STATUSES = [
  'CALCULATION',
  'CALCULATION_DONE',
  'SAMPLE_PRODUCTION',
  'IN_PRODUCTION',
] as const satisfies readonly OrderStatus[];

export function isOrderSampleLaunchable(status: OrderStatus): boolean {
  return (ORDER_SAMPLE_LAUNCHABLE_STATUSES as readonly OrderStatus[]).includes(
    status,
  );
}

/**
 * Статусы, при которых заказ считается «в архиве» — то есть уезжает из
 * рабочего списка `/admin/orders` на вкладку «Архив».
 *
 * Пока это только `CANCELLED`: отменённый заказ уже никогда не вернётся
 * в работу (`evaluateOrderTransitions` считает `CANCELLED` терминальным
 * и блокирует ВСЕ переходы из него), но и удалять его нельзя — за ним
 * висят паспорта, начисления и история. Такому заказу не место в
 * ежедневном списке, но он должен оставаться доступен для просмотра.
 *
 * `DONE` в архив сознательно НЕ уводим: завершённый заказ — это нормальный
 * управленческий срез (выработка, себестоимость, сроки), его смотрят
 * постоянно и фильтруют статусом.
 *
 * Отдельного поля `archivedAt` у заказа нет и не заводится: архивность
 * заказа — ПРОИЗВОДНАЯ от статуса, а не самостоятельный флаг. Иначе
 * появилось бы второе состояние, которое надо синхронизировать с
 * отменой (и оно бы разъехалось). Ср. с 9 справочниками админки, где
 * архив — именно поле `archivedAt` (см. `shared/archive.ts`): там нет
 * статуса, который бы это выражал.
 */
export const ORDER_ARCHIVED_STATUSES = [
  'CANCELLED',
] as const satisfies readonly OrderStatus[];

/** Уехал ли заказ с таким статусом на вкладку «Архив». */
export function isOrderArchived(status: OrderStatus): boolean {
  return (ORDER_ARCHIVED_STATUSES as readonly OrderStatus[]).includes(status);
}

/**
 * Статусы, в которых разрешена правка «плановых полей» заказа ДО запуска
 * производства — единый источник истины и для backend-гейта
 * (`OrdersService.update`), и для web-UI (кнопка «Редактировать», селекты
 * формы редактирования).
 *
 * Окно `DRAFT → CALCULATION → CALCULATION_DONE`: до старта производства ещё
 * нет паспортов/кроя, ссылающихся на снимок, поэтому безопасные плановые
 * поля (**подразделение**, **маршрут**) правятся на месте; маршрут при этом
 * дособирает план операций и снимок шагов.
 *
 * Осознанно НЕ покрывает:
 *   - материалозатрагивающие правки (состав/размеры, лекало, привязка
 *     техкарты, спецификация): на `CALCULATION_DONE` у потребностей уже
 *     проставлены цены закупщика, а их пересчёт их сотрёт — такие правки
 *     идут через «Вернуть на пересчёт» (`reopenCalculation` → `CALCULATION`),
 *     где действует своё окно (см. Group A: colorways/tech-card params);
 *   - `SAMPLE_PRODUCTION`/`IN_PRODUCTION`/`DONE`/`CANCELLED` — план заморожен
 *     (правки в производстве — отдельный ярус amendments).
 */
export const ORDER_PLAN_EDITABLE_STATUSES = [
  'DRAFT',
  'CALCULATION',
  'CALCULATION_DONE',
] as const satisfies readonly OrderStatus[];

export function isOrderPlanEditable(status: OrderStatus): boolean {
  return (ORDER_PLAN_EDITABLE_STATUSES as readonly OrderStatus[]).includes(
    status,
  );
}

/**
 * Статусы, в которых маршрут заказа правится ХОЛСТОМ (состав, порядок и
 * параллельные группы шагов `OrderRouteStep`) — карточка «Маршрут операций»
 * на вкладке «Производство», окно `PUT /orders/:id/amendments/route`.
 * Единый источник истины для backend-гейта (`OrderAmendmentsService`) и UI.
 *
 * Окно шире `ORDER_PLAN_EDITABLE_STATUSES` намеренно: состав операций
 * меняют «на ходу» и после запуска — до запуска трогать можно весь маршрут,
 * после запуска правка ограничена **фронтом производства** (шаги, которые
 * паспорта прошли или проходят сейчас, заморожены; см. `planRouteAmendment`).
 * Это не два разных правила, а одно: `frontierIndex` до запуска равен −1,
 * поэтому замороженный префикс пуст и холст размораживается целиком.
 *
 * `DONE` / `CANCELLED` исключены: заказ закрыт, менять в нём нечего (та же
 * граница, что у режима «Расценки и нормы» в блоке «Операции»).
 *
 * ВАЖНО: ручная правка маршрута выставляет `Order.routeCustomizedAt` и с
 * этого момента ре-синк снимка из шаблона (`syncOrderRouteStepsSnapshot`)
 * выключается — иначе «Пересчитать план операций» молча вернул бы маршрут
 * к шаблону. Флаг снимается, когда менеджер осознанно выбирает ДРУГОЙ
 * шаблон маршрута в форме редактирования заказа.
 */
export const ORDER_ROUTE_EDITABLE_STATUSES = [
  'DRAFT',
  'CALCULATION',
  'CALCULATION_DONE',
  'SAMPLE_PRODUCTION',
  'IN_PRODUCTION',
] as const satisfies readonly OrderStatus[];

export function isOrderRouteEditable(status: OrderStatus): boolean {
  return (ORDER_ROUTE_EDITABLE_STATUSES as readonly OrderStatus[]).includes(
    status,
  );
}

/**
 * Заказ уже запущен: по нему есть (или могут быть) паспорта, поэтому у
 * правки маршрута появляется фронт производства и обязательная причина
 * правки. До запуска маршрут — часть плана, причина не нужна.
 */
export function isOrderStarted(status: OrderStatus): boolean {
  return (
    status === 'SAMPLE_PRODUCTION' ||
    status === 'IN_PRODUCTION' ||
    status === 'DONE'
  );
}

/**
 * Человекочитаемые лейблы статуса заказа. Источник истины для всех
 * UI: легаси `/orders/*`, новый `/admin/orders/*`, форма
 * редактирования. Бэкенд лейблы не отдаёт — он отдаёт raw-enum, а
 * UI приводит к человеческому виду через эту таблицу (см.
 * `apps/web/lib/orders-api.ts::ORDER_STATUS_LABELS` и
 * `apps/web/lib/admin-labels.ts::formatOrderStatus`).
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  CALCULATION: 'Расчёт',
  CALCULATION_DONE: 'Расчёт завершён',
  SAMPLE_PRODUCTION: 'Производство сигнального образца',
  IN_PRODUCTION: 'В производстве',
  DONE: 'Завершён',
  CANCELLED: 'Отменён',
};

// ---------------------------------------------------------------------------
// Materials & hardware cost policy (упрощённый MVP давальческого сырья)
// ---------------------------------------------------------------------------

/**
 * Политика учёта материалов и фурнитуры в себестоимости заказа (см.
 * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
 * `apps/api/src/modules/orders/orders.service.ts`,
 * `apps/api/src/modules/costs/costs.service.ts`,
 * `docs/current-state.md §«Давальческое сырьё клиента»`).
 *
 *   - `INCLUDE` — материалы и фурнитура учитываются в себестоимости
 *     заказа и в production cost (default);
 *   - `EXCLUDE` — давальческое сырьё / фурнитура клиента: расчёт
 *     потребности и складские движения продолжают работать, но
 *     MATERIAL / HARDWARE не включаются в себестоимость заказа и
 *     production cost.
 */
export const ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES = [
  'INCLUDE',
  'EXCLUDE',
] as const;
export const OrderMaterialsAndHardwareCostPolicySchema = z.enum(
  ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES,
);
export type OrderMaterialsAndHardwareCostPolicy = z.infer<
  typeof OrderMaterialsAndHardwareCostPolicySchema
>;

/**
 * Человекочитаемые лейблы политики. Источник истины для UI форм
 * (`/admin/orders/new`, `/admin/orders/[id]/edit`) и карточки заказа.
 */
export const ORDER_MATERIALS_AND_HARDWARE_COST_POLICY_LABELS: Record<
  OrderMaterialsAndHardwareCostPolicy,
  string
> = {
  INCLUDE: 'Учитывать материалы и фурнитуру',
  EXCLUDE: 'Не учитывать материалы и фурнитуру',
};

/**
 * Backend-приём политики из тела запроса:
 *   - `'INCLUDE'` / `'EXCLUDE'` — валидные значения;
 *   - `null` / `undefined` / пустая строка — `INCLUDE` (default).
 *
 * Используется в `CreateOrderSchema` / `UpdateOrderSchema`. Семантика
 * `null → INCLUDE` (а не «не трогать колонку») сознательная — это
 * upper-level политика заказа, не nullable-поле.
 */
const OrderMaterialsAndHardwareCostPolicyField: z.ZodType<
  OrderMaterialsAndHardwareCostPolicy | undefined
> = z
  .preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null) return 'INCLUDE';
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed === '') return 'INCLUDE';
        return trimmed.toUpperCase();
      }
      return v;
    },
    OrderMaterialsAndHardwareCostPolicySchema.optional(),
  ) as unknown as z.ZodType<OrderMaterialsAndHardwareCostPolicy | undefined>;

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

const DateStringSchema = z
  .string()
  .min(1, 'Дата обязательна')
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Некорректная дата',
  });

/**
 * Этап «Цена продажи за единицу» (см. `model Order.customerUnitPrice`,
 * `prisma/migrations/20260521100000_add_order_customer_unit_price`).
 *
 * `customerUnitPrice` принимает `string | number | null | undefined`,
 * нормализует к строке с `.` (без локалей), валидирует как
 * неотрицательное число с не более чем 2 знаками после запятой
 * (DECIMAL(14,2)).
 *
 * Семантика:
 *   - `undefined` — поле не передано, backend не трогает колонку;
 *   - `null` или пустая строка — стирание (UI «Цена продажи не
 *     указана»);
 *   - `0` допускаем (бесплатный/демо-заказ), отрицательные — нет.
 */
const CustomerUnitPriceField: z.ZodType<string | null | undefined> = z
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
        message: 'Цена продажи: число, не более 2 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена продажи должна быть >= 0',
      });
      return z.NEVER;
    }
    if (n > 1_000_000_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена продажи: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

/**
 * Валюта цены продажи. Та же стратегия, что `WorkshopNeed.quotedCurrency`:
 * сужено до `MoneyCurrencySchema` (`RUB` / `USD`); пустая строка —
 * `null` (стирание). На MVP exchange-rate API не подключаем — для
 * USD-цен UI показывает выручку в долларах и не считает маржу в
 * рублях без явного курса.
 */
const CustomerCurrencyField: z.ZodType<MoneyCurrency | null | undefined> = z
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

export const CreateOrderItemSchema = z.object({
  sizeId: z.string().min(1, 'sizeId обязателен'),
  qtyPlan: z
    .number({ invalid_type_error: 'qtyPlan должен быть числом' })
    .int('qtyPlan должен быть целым')
    .positive('qtyPlan должен быть > 0'),
});

// ---------------------------------------------------------------------------
// Inline-создание изделия из формы заказа
// (см. `prisma/schema.prisma::Order.productCreationMode`,
//   `apps/api/src/modules/orders/orders.service.ts::create`,
//   `apps/web/app/admin/orders/new/admin-create-order-form.tsx`).
// ---------------------------------------------------------------------------

export const ORDER_PRODUCT_CREATION_MODES = [
  'EXISTING_PATTERN',
  'CREATE_FOR_CALCULATION',
  'SEND_TO_CONSTRUCTOR',
] as const;
export const OrderProductCreationModeSchema = z.enum(
  ORDER_PRODUCT_CREATION_MODES,
);
export type OrderProductCreationMode = z.infer<
  typeof OrderProductCreationModeSchema
>;

const AreaM2StringField: z.ZodType<string> = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw =
      typeof v === 'number' ? String(v) : String(v).trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'areaM2 обязателен' });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'areaM2: число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'areaM2 должен быть > 0',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string>;

const PatternDevelopmentCostRubField: z.ZodType<
  string | null | undefined
> = z
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
        message:
          'Стоимость разработки лекала: число, не более 2 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Стоимость разработки лекала должна быть >= 0',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

export const CreateOrderProductCalculationSizeAreaSchema = z.object({
  roleKey: z.string().trim().min(1, 'roleKey обязателен').max(64),
  areaM2: AreaM2StringField,
});
export type CreateOrderProductCalculationSizeArea = z.infer<
  typeof CreateOrderProductCalculationSizeAreaSchema
>;

export const CreateOrderProductCalculationSizeRowSchema = z.object({
  sizeId: z.string().min(1, 'sizeId обязателен'),
  qtyPlan: z
    .number({ invalid_type_error: 'qtyPlan должен быть числом' })
    .int('qtyPlan должен быть целым')
    .positive('qtyPlan должен быть > 0'),
  /**
   * Расход по AREA_M2_BY_SIZE-параметрам категории. Может быть пустым,
   * если у заказа нет привязки к категории либо у выбранной категории
   * нет AREA_M2_BY_SIZE-параметров — backend в таком случае просто не
   * пишет `PatternMaterialArea[]`.
   */
  areas: z
    .array(CreateOrderProductCalculationSizeAreaSchema)
    .default([]),
});
export type CreateOrderProductCalculationSizeRow = z.infer<
  typeof CreateOrderProductCalculationSizeRowSchema
>;

export const CreateOrderNewProductCalculationSchema = z
  .object({
    /**
     * Группа номенклатуры — опциональна. Если выбрана, backend
     * валидирует существование/активность; иначе создаёт PatternItem
     * без `categoryId` (это допустимо — поле nullable в БД).
     */
    categoryId: z.string().min(1).nullable().optional(),
    /**
     * Техкарта — опциональна. Если выбрана, backend валидирует
     * совместимость с категорией (когда категория тоже задана);
     * иначе создаёт заказ без `techCardId`. Для запуска расчёта
     * (`startCalculation`) техкарта понадобится, но на этап create
     * это не блокирует.
     */
    techCardId: z.string().min(1).nullable().optional(),
    patternDevelopmentCostRub: PatternDevelopmentCostRubField,
    /**
     * Чекбокс «входит в текущий расчёт себестоимости» рядом с полем
     * «Стоимость разработки лекала». По умолчанию `true` (чекбокс
     * нажат). Если `true` и `patternDevelopmentCostRub > 0`, backend
     * `completeCalculation` добавит сумму отдельной строкой сметы и
     * она войдёт в `OrderCostEstimate.totalCostRub`. Принимаем
     * boolean / "true"/"false"/"on" строки от FormData — нормализуем
     * к boolean, дефолт true.
     */
    patternDevelopmentCostInCostPrice: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((v) => {
        if (v === undefined) return true;
        if (typeof v === 'boolean') return v;
        const s = v.trim().toLowerCase();
        return s === 'true' || s === 'on' || s === '1';
      }),
    /**
     * Размерная матрица — может быть пустой (заказ создаётся как
     * «черновик без размеров»). Для запуска расчёта потребуется
     * хотя бы одна строка с `qtyPlan > 0`.
     */
    sizes: z
      .array(CreateOrderProductCalculationSizeRowSchema)
      .default([]),
  })
  .superRefine((dto, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < dto.sizes.length; i += 1) {
      const sid = dto.sizes[i].sizeId;
      if (seen.has(sid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sizes', i, 'sizeId'],
          message: 'Размер не должен повторяться',
        });
      }
      seen.add(sid);
    }
  });
export type CreateOrderNewProductCalculationDto = z.infer<
  typeof CreateOrderNewProductCalculationSchema
>;

export const CreateOrderSchema = z.object({
  orderDate: DateStringSchema,
  /**
   * Учётный (legacy) `Product.id`. Этап «Номенклатура = Лекала» (см.
   * `docs/recon-soft-integration.md §«Номенклатура = Лекала»`):
   *
   * - в новой admin-форме (`/admin/orders/new`) поле НЕ заполняется
   *   и в DTO не приходит — пользователь выбирает только `patternItemId`,
   *   а backend подставит технический Product через
   *   `OrdersService.ensureLegacyProductForPattern()`;
   * - старый flow (CUTTER_ASSISTANT, прямой POST `/api/orders` без
   *   `patternItemId`) продолжает работать: достаточно прислать
   *   `productId`, backend сохранит обратную совместимость.
   *
   * Хотя бы одно из полей `patternItemId` / `productId` обязано быть
   * передано — это enforced ниже в `superRefine`. Передать оба тоже
   * можно: тогда `patternItemId` главный, helper использует его и
   * пере-привяжет/создаст legacy Product при необходимости.
   */
  productId: z.string().min(1).optional(),
  /**
   * Цвет: опционален. На MVP приходит с фронта и может быть перезаписан
   * сервером значением `Product.color`, если явно не задан и заказ
   * заведён в legacy product-only flow (без `patternItemId`).
   */
  color: z
    .preprocess(
      (v) => (typeof v === 'string' ? normalizeColor(v) : v),
      z.string().min(1).max(64),
    )
    .optional(),
  comment: z.string().max(2000).optional(),
  customer: z.string().max(200).optional(),
  /**
   * Управленческая привязка заказа к карточке клиента из справочника
   * `Client`. Backend дополнительно проверяет, что клиент существует и
   * активен — иначе 400 `CLIENT_NOT_FOUND` / `CLIENT_INACTIVE`.
   *
   * Этап «Клиент — обязательный атрибут заказа»: на уровне DTO поле
   * ОСТАЁТСЯ опциональным — `POST /api/orders` держит обратную
   * совместимость (легаси `/orders/new`, CUTTER_ASSISTANT, прямой POST,
   * DRAFT-заказ из КБ-задачи). Обязательность обеспечивают:
   *   - формы web-а: `required`-селект «Клиент» + гейты server actions
   *     (`createOrderAction` / `configureOrderDraftAction` отдают
   *     `fieldErrors.clientId`, если поле есть в FormData и пустое);
   *   - бизнес-гейт `OrdersService.startCalculation` → 400
   *     `ORDER_CLIENT_REQUIRED`: заказ без клиента не уедет дальше
   *     `DRAFT`.
   * `null`/пусто = «клиент не выбран», такой заказ можно только
   * дозаполнить.
   */
  clientId: z.string().min(1).nullable().optional(),
  dueDate: DateStringSchema.nullable().optional(),
  /**
   * Soft-route MVP: опциональная привязка к шаблону маршрута. Шаги
   * шаблона фиксируются в snapshot `OrderRouteStep[]` при первом
   * `OrdersService.start()`. Не задан — заказ запускается «без маршрута»
   * (полная backward compatibility со старым flow).
   */
  routeTemplateId: z.string().min(1).optional(),
  /**
   * Tech card MVP (ADR-0022): опциональная привязка к шаблону техкарты.
   * Строки техкарты фиксируются snapshot-ами `materialRequirements[]` /
   * `outsourceRequirements[]` при `OrdersService.start()`. Не задан —
   * заказ запускается «без техкарты», snapshot-ы остаются пустыми.
   */
  techCardId: z.string().min(1).optional(),
  /**
   * Soft-pattern MVP (этап 2 «Лекала»): опциональная привязка к
   * карточке лекала (`PatternItem`). Не блокирует запуск заказа без
   * лекала — поле сознательно nullable. Backend проверяет, что
   * лекало существует и `status = ACTIVE` (см.
   * `OrdersService.assertPatternUsable`). При запуске заказа в
   * производство (`start()`) snapshot полей лекала фиксируется в
   * `Order.patternNameSnapshot` / `patternArticleSnapshot` /
   * `patternPreviewSnapshotUrl`.
   */
  patternItemId: z.string().min(1).nullable().optional(),
  /**
   * Подразделение заказа — FK на master-справочник `CompanyDivision`
   * (см. `prisma/schema.prisma::Order.companyDivisionId`,
   * `docs/domain.md §«Подразделения заказа»`,
   * `OrdersService.create`).
   *
   * Опционально и nullable: если фронт/интеграция не передал
   * значение, заказ создаётся без привязки к подразделению — UI
   * показывает «Не указано», earnings-helper
   * `getCutterCompensationSchemeForDivision` для отсутствующего
   * кода даёт безопасный default `B2B_SEWING_PERCENT`.
   */
  companyDivisionId: z.string().min(1).nullable().optional(),
  /**
   * Этап «Нанесение на заказе покупателя» (см. `model OrderApplication`,
   * `apps/api/src/modules/order-applications/*`). Опциональный список
   * заказных нанесений, который backend создаёт в **той же транзакции**,
   * что и сам заказ (см. `OrdersService.create`). Это нужно, чтобы
   * пользователь на `/admin/orders/new` мог завести нанесения сразу с
   * заказом — без второго запроса `PUT /orders/:id/applications`.
   *
   * Семантика:
   *   - поле опционально и nullable; отсутствие или пустой массив =
   *     «заказ создаётся без нанесений» (legacy-flow `/orders/new`
   *     ничего не передаёт и продолжает работать как раньше);
   *   - каждая строка — `OrderApplicationInputSchema` (тот же контракт,
   *     что у `PUT /orders/:id/applications`), Zod нормализует
   *     пустые/числовые поля;
   *   - дефолты на бэке: `unit = "шт"`, `status = PLANNED`,
   *     `stage = CUT_PARTS` — те же, что в `OrderApplicationsService.
   *     replaceForOrder`. Менять только в DRAFT — на момент `create`
   *     заказ только что родился в DRAFT, ограничения нет.
   *
   * Маршрут / техкарта / Product / Passport / payroll НЕ затрагиваются:
   * нанесение хранится отдельной таблицей `OrderApplication`, привязка
   * только через `orderId`.
   */
  applications: z.array(OrderApplicationInputSchema).optional(),
  /**
   * Этап «Цена продажи за единицу»: цена и валюта продажи 1 изделия.
   * Поле опционально и nullable — backend сохранит ровно то, что
   * пришло, без подстановок default-ов.
   *
   * Дефолт валюты «по требованию ТЗ» — если `customerUnitPrice > 0`
   * пришла без `customerCurrency`, backend проставит `RUB`.
   * Подробнее — в `OrdersService.create` / `update`.
   */
  customerUnitPrice: CustomerUnitPriceField,
  customerCurrency: CustomerCurrencyField,
  /**
   * Этап «Склад выпуска готовой продукции» (см.
   * `prisma/schema.prisma::Order.finishedGoodsWarehouseId`,
   * `OrdersService.create` / `update`,
   * `docs/current-state.md §«Склад выпуска готовой продукции»`).
   *
   * Управленческое поле: id `Warehouse`, на который менеджер
   * планирует выпустить готовую продукцию (B2B / Marketplace /
   * Образцы / …). Это НЕ склад материалов — backend никак не
   * затрагивает `StockBalance` / `StockMovement` / `MaterialIssue` /
   * `PurchaseReceipt` / `WorkshopNeed`.
   *
   * Поле опциональное и nullable: на create `null` / `undefined` →
   * заказ создаётся без выбранного склада. Если передан непустой
   * id — backend проверяет existence и `isActive = true`.
   */
  finishedGoodsWarehouseId: z.string().min(1).nullable().optional(),
  /**
   * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
   * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
   * `OrderMaterialsAndHardwareCostPolicy` выше).
   *
   *   - `INCLUDE` — материалы и фурнитура учитываются в себестоимости
   *     заказа (default);
   *   - `EXCLUDE` — давальческое сырьё / фурнитура клиента: расчёт
   *     потребности и складские движения продолжают работать, но
   *     MATERIAL / HARDWARE не включаются в себестоимость и
   *     production cost.
   *
   * `undefined` / `null` / пустая строка трактуется как `INCLUDE`.
   */
  materialsAndHardwareCostPolicy: OrderMaterialsAndHardwareCostPolicyField,
  /**
   * Inline-создание изделия из формы заказа (см.
   * `OrderProductCreationModeSchema` выше). Default `EXISTING_PATTERN`
   * — стандартный путь, заказ требует `patternItemId` или legacy
   * `productId`. Для `CREATE_FOR_CALCULATION` backend сам создаёт
   * `PatternItem` / `PatternMaterialArea[]` / technical `Product` по
   * `newProductCalculation`.
   */
  productMode: OrderProductCreationModeSchema.optional(),
  newProductCalculation: CreateOrderNewProductCalculationSchema.optional(),
  items: z
    .array(CreateOrderItemSchema)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i += 1) {
        const sid = items[i].sizeId;
        if (seen.has(sid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'sizeId'],
            message: 'Размер не должен повторяться в одном заказе',
          });
        }
        seen.add(sid);
      }
    })
    .optional()
    .default([]),
  /**
   * Фича «Расцветки» (FEATURE_COLORWAYS): опциональный список расцветок
   * заказа — цвет + своя техкарта материалов + поразмерный план. Когда
   * передан, backend создаёт `OrderVariant` / `OrderVariantSize` в той
   * же транзакции, что и заказ. `items` (агрегированный план заказа)
   * фронт считает как Σ по всем цветам — производство/раскрой продолжают
   * работать по агрегату. Отсутствие / пустой массив = заказ без явных
   * расцветок: backend заведёт одну расцветку #0 из `color` + `items`
   * (зеркало). Полная backward-compat со старым flow.
   */
  variants: z
    .array(
      z.object({
        color: z.string().trim().min(1, 'Укажите цвет расцветки').max(60),
        techCardId: z.string().min(1).nullable().optional(),
        sizes: z.array(ColorwaySizeInputSchema).default([]),
      }),
    )
    .optional(),
}).superRefine((dto, ctx) => {
  const mode = dto.productMode ?? 'EXISTING_PATTERN';
  const hasPattern =
    typeof dto.patternItemId === 'string' && dto.patternItemId.length > 0;
  const hasProduct =
    typeof dto.productId === 'string' && dto.productId.length > 0;
  const hasNewCalc =
    dto.newProductCalculation !== undefined &&
    dto.newProductCalculation !== null;

  if (mode === 'CREATE_FOR_CALCULATION') {
    if (!hasNewCalc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newProductCalculation'],
        message:
          'Для режима «Создать изделие» нужны данные нового изделия',
      });
    }
    if (hasPattern) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patternItemId'],
        message:
          'Нельзя одновременно выбрать существующее лекало и создать новое',
      });
    }
    return;
  }

  if (mode === 'SEND_TO_CONSTRUCTOR') {
    // Этап «Отправить изделие конструктору»: на момент parent submit
    // создания заказа черновое изделие УЖЕ создано отдельным server
    // action-ом `saveConstructorDraftAction` (внутри модалки, по клику
    // «Сохранить изделие» на вкладке `constructor`). Действие создаёт
    // `PatternItem (status='DRAFT')` + `ConstructorTask (status='NEW')`
    // и возвращает `patternItemId`, который родительская форма
    // сохраняет в hidden input как обычное `patternItemId`. Поэтому
    // ровно как `EXISTING_PATTERN` — заказ должен иметь `patternItemId`,
    // и НЕ должен иметь `newProductCalculation` (та форма заполняется
    // только во вкладке «Сделать расчёт»).
    if (!hasPattern) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patternItemId'],
        message:
          'Нажмите «Сохранить изделие» на вкладке «Отправить конструктору» — без этого заказ не создать',
      });
    }
    if (hasNewCalc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newProductCalculation'],
        message:
          'newProductCalculation допустим только для режима CREATE_FOR_CALCULATION',
      });
    }
    return;
  }

  // mode === 'EXISTING_PATTERN' (default).
  if (!hasPattern && !hasProduct) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['patternItemId'],
      message: 'Выберите номенклатуру / лекало',
    });
  }
  if (hasNewCalc) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['newProductCalculation'],
      message:
        'newProductCalculation допустим только для режима CREATE_FOR_CALCULATION',
    });
  }
  if (!dto.items || dto.items.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['items'],
      message: 'Заказ должен содержать хотя бы одну строку по размеру',
    });
  }
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;
export type CreateOrderItemDto = z.infer<typeof CreateOrderItemSchema>;

/**
 * Редактирование заказа.
 *
 * Поля делятся на два класса (см. `OrdersService.update`):
 *
 *   - «безопасные» (`clientId`, `dueDate`, `orderDate`, `comment`,
 *     `customer`, `color`, `status`) — менеджер может править на
 *     любом статусе, в том числе после запуска заказа;
 *   - «потенциально опасные» (`items`, `productId`, `routeTemplateId`,
 *     `techCardId`, `companyDivisionId`) — допустимы только пока заказ
 *     в `DRAFT`; на не-DRAFT заказе backend отвечает 409 `ORDER_LOCKED`.
 *
 * Дополнительные инварианты остаются:
 *   - `clientId` можно переставить, но не снять: `null` → 400
 *     `ORDER_CLIENT_REQUIRED` (этап «Клиент — обязательный атрибут
 *     заказа»);
 *   - смена `routeTemplateId` блокируется, если уже зафиксирован
 *     snapshot маршрута (`OrderRouteStep[]`) → 409
 *     `ORDER_ROUTE_ALREADY_STARTED`;
 *   - смена `techCardId` блокируется, если уже зафиксированы
 *     snapshot-ы материалов / внешних потребностей → 409
 *     `ORDER_TECH_CARD_ALREADY_STARTED`;
 *   - `status` принимает только безопасные переходы:
 *       `DRAFT → IN_PRODUCTION` (делегирует `OrdersService.start`),
 *       `IN_PRODUCTION → DONE` (делегирует `complete`),
 *       `(DRAFT|IN_PRODUCTION) → CANCELLED` (делегирует `cancel`).
 *     Любой другой переход возвращает 409 `ORDER_INVALID_TRANSITION`.
 */
export const UpdateOrderSchema = z.object({
  orderDate: DateStringSchema.optional(),
  productId: z.string().min(1).optional(),
  color: z
    .preprocess(
      (v) => {
        if (v === null || v === undefined) return v;
        if (typeof v !== 'string') return v;
        const n = normalizeColor(v);
        return n === '' ? null : n;
      },
      z.string().min(1).max(64).nullable(),
    )
    .optional(),
  comment: z.string().max(2000).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  /**
   * Управляемая смена статуса заказа. На уровне DTO допустимы все
   * значения `OrderStatus`, но backend разрешает только безопасные
   * переходы (см. описание схемы выше) — остальные → 409
   * `ORDER_INVALID_TRANSITION`. Поле опциональное: если не передано,
   * статус не трогается, и сохраняются текущие правила полей.
   */
  status: OrderStatusSchema.optional(),
  /**
   * Управленческая привязка заказа к карточке клиента (см.
   * `CreateOrderSchema.clientId`). «Безопасное» поле: клиента можно
   * переставить на любом статусе заказа.
   *
   * Этап «Клиент — обязательный атрибут заказа»: СНЯТЬ привязку нельзя
   * — `clientId: null` отбивается в `OrdersService.update` как 400
   * `ORDER_CLIENT_REQUIRED`. `null` в типе остаётся только потому, что
   * web-формы собирают DTO по правилу «поля нет = не трогать, поле есть
   * и пустое = null»: пустой селект должен долетать до адресной ошибки,
   * а не молча выпадать из PATCH.
   */
  clientId: z.string().min(1).nullable().optional(),
  dueDate: DateStringSchema.nullable().optional(),
  /**
   * Soft-route MVP: смена/сброс шаблона маршрута до запуска заказа
   * (status = DRAFT). После `start()` поле остаётся read-only — snapshot
   * уже зафиксирован.
   */
  routeTemplateId: z.string().min(1).nullable().optional(),
  /**
   * Tech card MVP (ADR-0022): смена/сброс шаблона техкарты до запуска
   * заказа (status = DRAFT). После `start()` snapshot материалов и
   * внешних потребностей зафиксирован, и поле здесь оставлять можно
   * только без изменений.
   */
  techCardId: z.string().min(1).nullable().optional(),
  /**
   * Soft-pattern MVP (этап 2 «Лекала»): смена/сброс выбранного лекала
   * до запуска заказа (status = DRAFT). После запуска поле read-only
   * (общий ORDER_LOCKED guard) — snapshot полей лекала уже
   * зафиксирован в `Order.patternNameSnapshot` / `…Article…` /
   * `…PreviewSnapshotUrl` и описывает «лекало по которому заказ ушёл
   * в работу». Передача `null` или пустой строки очищает связь
   * (только в DRAFT).
   */
  patternItemId: z.string().min(1).nullable().optional(),
  /**
   * Смена подразделения заказа через FK на `CompanyDivision`.
   * Меняется только пока заказ в `DRAFT` (общий ORDER_LOCKED guard).
   * `null` обнуляет привязку — UI карточки показывает «Не указано».
   */
  companyDivisionId: z.string().min(1).nullable().optional(),
  /**
   * Этап «Цена продажи за единицу»: то же поле, что в
   * `CreateOrderSchema`. Меняется на любом статусе заказа — это
   * управленческое поле, а не «опасное» (см. `OrdersService.update`).
   * `undefined` — не трогать, `null` или пустая строка — стереть.
   */
  customerUnitPrice: CustomerUnitPriceField,
  customerCurrency: CustomerCurrencyField,
  /**
   * Этап «Склад выпуска готовой продукции»: смена / сброс выбранного
   * склада выпуска. Это управленческое поле — менеджер может править
   * на любом статусе заказа (без `ORDER_LOCKED` guard), потому что
   * оно не затрагивает snapshot маршрута / техкарты / план операций.
   * `undefined` — поле не пришло, не трогать; `null` — сбросить;
   * непустая строка — переустановить (backend валидирует existence
   * и `isActive`).
   */
  finishedGoodsWarehouseId: z.string().min(1).nullable().optional(),
  /**
   * Упрощённый MVP давальческого сырья / фурнитуры клиента — то же
   * поле, что в `CreateOrderSchema`. Меняется на любом статусе заказа
   * (это управленческая политика учёта в себестоимости, а не
   * «опасное» поле). `undefined` — не трогать, `null` / пустая
   * строка — `INCLUDE`.
   */
  materialsAndHardwareCostPolicy: OrderMaterialsAndHardwareCostPolicyField,
  items: z
    .array(CreateOrderItemSchema)
    .min(1, 'Заказ должен содержать хотя бы одну строку по размеру')
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i += 1) {
        const sid = items[i].sizeId;
        if (seen.has(sid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'sizeId'],
            message: 'Размер не должен повторяться в одном заказе',
          });
        }
        seen.add(sid);
      }
    })
    .optional(),
  /**
   * Фича «Расцветки» (FEATURE_COLORWAYS): при редактировании заказа
   * (`/admin/orders/[id]/edit`) форма шлёт полный список расцветок — цвет
   * + своя техкарта + поразмерный план. Когда передан, backend делает
   * ПОЛНУЮ ЗАМЕНУ `OrderVariant` / `OrderVariantSize` и пересобирает
   * агрегат `OrderItem` = Σ по цветам через тот же `resyncColorwayDerived`,
   * что и карточки на странице просмотра — обе поверхности сходятся на
   * одном движке. Форма шлёт `variants` ВМЕСТО `items`, чтобы прямая
   * запись агрегата не конфликтовала с ресинком. Разрешено в DRAFT /
   * CALCULATION (то же окно, что у API расцветок); иначе backend отдаёт
   * 409 `ORDER_COLORWAYS_LOCKED`. Та же форма, что в `CreateOrderSchema`.
   */
  variants: z
    .array(
      z.object({
        color: z.string().trim().min(1, 'Укажите цвет расцветки').max(60),
        techCardId: z.string().min(1).nullable().optional(),
        sizes: z.array(ColorwaySizeInputSchema).default([]),
      }),
    )
    .optional(),
});
export type UpdateOrderDto = z.infer<typeof UpdateOrderSchema>;

// ---------------------------------------------------------------------------
// Route mode override (адаптивный сплит-распошив)
// ---------------------------------------------------------------------------

/** Зеркалит prisma enum `RouteModeOverride` (поле `Order.routeModeOverride`). */
export const ROUTE_MODE_OVERRIDES = ['AUTO', 'FORCE_SPLIT', 'FORCE_COLLAPSED'] as const;
export type RouteModeOverride = (typeof ROUTE_MODE_OVERRIDES)[number];

/** Тело ручки `PATCH /orders/:id/route-mode`. */
export const SetOrderRouteModeSchema = z.object({
  routeModeOverride: z.enum(ROUTE_MODE_OVERRIDES),
});
export type SetOrderRouteModeDto = z.infer<typeof SetOrderRouteModeSchema>;

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ORDER_SORTS = [
  'orderDate_desc',
  'orderDate_asc',
  'createdAt_desc',
  'createdAt_asc',
] as const;
export const OrderSortSchema = z.enum(ORDER_SORTS);
export type OrderSort = z.infer<typeof OrderSortSchema>;

/**
 * Zod-enum статуса контроля сроков заказа. Источник истины —
 * `OrderDeadlineStatus` из `./order-deadlines`. Здесь дублируется
 * как enum для query-валидации фильтра `?deadline=…` на API
 * (`OrdersService.list`) и web (`/admin/orders`).
 */
export const OrderDeadlineStatusSchema = z.enum(ORDER_DEADLINE_STATUSES);

/**
 * Вкладка списка заказов: рабочие («Активные») или архивные
 * («Архив» = `ORDER_ARCHIVED_STATUSES`). Договорённость по URL та же,
 * что у справочников админки (см. `AdminArchiveTabs`): активная
 * вкладка — БЕЗ параметра, архив — `?tab=archive`.
 */
export const ORDER_LIST_TABS = ['active', 'archive'] as const;
export const OrderListTabSchema = z.enum(ORDER_LIST_TABS);
export type OrderListTab = z.infer<typeof OrderListTabSchema>;

export const ListOrdersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: OrderStatusSchema.optional(),
  /**
   * Управленческая привязка: фильтр заказов по карточке клиента.
   * Используется блоком «Заказы клиента» в `/admin/clients/[id]` и
   * любыми будущими отчётами «по клиенту». На MVP backend честно
   * фильтрует через `Order.clientId = …`.
   */
  clientId: z.string().min(1).optional(),
  /**
   * Управленческий фильтр заказов по подразделению-исполнителю
   * (FK `Order.companyDivisionId` → master-справочник `CompanyDivision`).
   * Backend честно фильтрует через `Order.companyDivisionId = …`.
   * Используется селектом «Подразделение» в `/admin/orders`.
   */
  companyDivisionId: z.string().min(1).optional(),
  /**
   * Фильтр по бакету «контроля сроков» (см. `evaluateOrderDeadline`).
   * Backend применяет фильтр после вычисления `deadline.status` для
   * каждого заказа в текущем срезе; учитывает все заказы, даже без
   * dueDate (`NO_DUE_DATE`). Подробнее — комментарий в
   * `OrdersService.list`.
   */
  deadline: OrderDeadlineStatusSchema.optional(),
  /**
   * Вкладка списка: `active` — рабочие заказы (всё, кроме
   * `ORDER_ARCHIVED_STATUSES`), `archive` — только архивные
   * (отменённые). Параметр НЕ обязателен и НЕ имеет default-а: без него
   * ручка отдаёт список как раньше — все заказы разом. Так старые
   * потребители (`/admin` дашборд, блок «Заказы клиента») не теряют
   * отменённые заказы молча; вкладку выбирает только `/admin/orders`.
   *
   * Когда `tab` передан, ответ дополнительно содержит `tabCounts` —
   * счётчики обеих вкладок под ТЕМИ ЖЕ фильтрами (поиск / клиент /
   * подразделение / срок), чтобы цифра на вкладке совпадала с тем, что
   * пользователь увидит после переключения.
   */
  tab: OrderListTabSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  sort: OrderSortSchema.default('createdAt_desc'),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

/**
 * Агрегированная сводка по заказу. На Шаге 4 все `*Fact*` / `*Total` поля
 * кроме `qtyPlanTotal` возвращаются как 0 — они подключатся при появлении
 * паспортов и событий (Шаг 5+). Структура здесь нужна заранее, чтобы
 * клиенту не пришлось переписывать интеграцию.
 */
export interface OrderSummary {
  qtyPlanTotal: number;
  qtyCutFactTotal: number;
  qtyInSewingTotal: number;
  qtyQcTotal: number;
  qtyWtoTotal: number;
  qtyPackingTotal: number;
  qtyFinishedTotal: number;
  qtyDefectTotal: number;
  /** Отклонение факта кроя от плана: `qtyCutFactTotal - qtyPlanTotal`. */
  qtyDeltaTotal: number;
}

export interface OrderSizeBreakdownRow {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyPlan: number;
  qtyCutFact: number;
  qtyInSewing: number;
  qtyQc: number;
  qtyWto: number;
  qtyPacking: number;
  qtyFinished: number;
  qtyDefect: number;
  /**
   * Остаток плана к раскрою: `max(qtyPlan - qtyCutFact, 0)`.
   * На Шаге 5 фактом считается выпуск паспортов; на следующих шагах
   * (упаковка) интерпретация может уточниться, но контракт остаётся.
   */
  qtyRemaining: number;
  /** Отклонение факта кроя: `qtyCutFact - qtyPlan`. */
  qtyDelta: number;
}

export interface OrderItemDto {
  id: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyPlan: number;
}

/**
 * DTO «контроля сроков» — то же, что вернёт `evaluateOrderDeadline`,
 * но `tone` ужат до `string`, чтобы фронту не пришлось узко типизироваться
 * на shared-enum в местах, где он только показывает бейдж. Web
 * сужает обратно к `OrderDeadlineTone` через `as`/маппинг — это
 * безопасно, т.к. `evaluateOrderDeadline` всегда отдаёт корректное
 * значение из `OrderDeadlineTone`.
 */
export interface OrderDeadlineDto {
  status: OrderDeadlineStatus;
  label: string;
  tone: string;
  daysLeft: number | null;
  progressPercent: number | null;
  reason: string;
}

/** Re-export для удобства потребителей `@sewing/shared/orders`. */
export type { OrderDeadlineEvaluation, OrderDeadlineStatus };

export interface OrderListItemDto {
  id: string;
  number: string;
  orderDate: string; // ISO
  createdAt: string; // ISO
  updatedAt: string; // ISO
  /**
   * Момент перехода заказа в производство (… → IN_PRODUCTION),
   * проставляется один раз в `OrdersService.start()`. `null` — заказ
   * ещё не запущен в производство. Управленческое поле «Ввод в
   * производство» в карточке заказа.
   *
   * Опционально (`?`) для backward-compat: старые потребители без
   * пересборки shared-пакета продолжают компилироваться.
   */
  inProductionAt?: string | null;
  status: OrderStatus;
  productId: string | null;
  productName: string | null;
  color: string | null;
  comment: string | null;
  customer: string | null;
  /**
   * Управленческая привязка к карточке клиента (см. `model Client`).
   * `null` — заказ без явной связи (старый flow `customer`-free-text
   * либо клиент не выбран в новой форме). Краткие поля (`id`/`name`)
   * приходят отдельно в `client` ниже, чтобы не делать
   * дополнительный запрос на UI.
   */
  clientId: string | null;
  client: { id: string; name: string } | null;
  dueDate: string | null;
  qtyPlanTotal: number;
  /**
   * Σ выпуска по заказу (= `summary.qtyFinishedTotal` на детали).
   * Считается на бэке из `Passport.qtyGood` по паспортам в статусе
   * `PACKED`. Нужен на списке, чтобы UI и `evaluateOrderDeadline`
   * видели прогресс выпуска без дополнительного запроса детали.
   */
  qtyFinishedTotal: number;
  /**
   * Управленческий «контроль срока». Считается на бэке через общий
   * `evaluateOrderDeadline` (см. `@sewing/shared/order-deadlines`).
   * Опционально только для backward-compat: старые потребители без
   * пересборки shared-пакета продолжают компилироваться.
   */
  deadline?: OrderDeadlineDto;
  /**
   * Подразделение заказа — FK на master-справочник `CompanyDivision`
   * (см. `prisma/schema.prisma::Order.companyDivisionId`,
   * `OrdersService.toListItemDto`).
   *
   * `companyDivisionId === null` означает «подразделение не указано»
   * — UI карточки показывает «Не указано», earnings-helper
   * `getCutterCompensationSchemeForDivision` для отсутствующего
   * кода даёт безопасный default `B2B_SEWING_PERCENT`.
   *
   * `companyDivision` — краткая ссылка на карточку подразделения,
   * чтобы списки/карточки заказа могли отрисовать имя без
   * дополнительного запроса в `/api/company-divisions`.
   */
  companyDivisionId: string | null;
  companyDivision: { id: string; code: string; name: string } | null;
  /**
   * Soft-route MVP: привязанный шаблон маршрута (или `null`, если заказ
   * запускается без маршрута). Хранится id + краткие поля для UI, чтобы
   * не делать дополнительный запрос за `code`/`name` шаблона.
   */
  routeTemplateId: string | null;
  routeTemplateCode: string | null;
  routeTemplateName: string | null;
  /**
   * Маршрут заказа правили холстом вручную (`Order.routeCustomizedAt`), и
   * снимок шагов больше не повторяет шаблон. UI обязан это показывать:
   * иначе карточка «Маршрут операций» называет шаблон, цепочка под ним
   * другая, и различие выглядит багом. Одновременно это значит, что
   * правки шаблона в справочнике до заказа больше не доезжают.
   */
  routeCustomized: boolean;
  /**
   * Ручное переопределение адаптивного режима сплит-распошива (см.
   * `apps/api/src/modules/passports/route-mode.ts`). AUTO — режим
   * вычисляется на лету; FORCE_SPLIT / FORCE_COLLAPSED — мастер фиксирует
   * две колонки распошива / одну. Меняется ручкой `PATCH /orders/:id/route-mode`.
   */
  routeModeOverride: RouteModeOverride;
  /**
   * Soft-pattern MVP (этап 2 «Лекала»): краткая ссылка на выбранное
   * лекало для `/admin/orders` и виджетов превью.
   *
   * Правило отображения (UI):
   *   - если есть `patternPreviewSnapshotUrl` — показываем snapshot
   *     (заказ уже в работе, лекало «застыло»);
   *   - иначе если есть live `patternPreviewImageUrl` — показываем
   *     актуальное превью карточки лекала;
   *   - иначе показываем placeholder.
   *
   * Все четыре поля nullable, чтобы старые/исторические заказы без
   * лекала отображались корректно.
   */
  patternItemId: string | null;
  patternName: string | null;
  patternArticle: string | null;
  patternPreviewImageUrl: string | null;
  patternNameSnapshot: string | null;
  patternArticleSnapshot: string | null;
  patternPreviewSnapshotUrl: string | null;

  /**
   * Этап «Конструкторское бюро» — статус связанной `ConstructorTask`,
   * если pattern был создан через flow «Отправить конструктору».
   *
   * `null` — заказ создан с уже готовым лекалом (стандартный flow),
   * либо лекало вообще не привязано. UI на `/admin/orders` показывает
   * маленький бейдж рядом со статусом заказа только для статусов
   * NEW/IN_PROGRESS/PENDING_ACCEPT/REWORK (DONE/CANCELLED не
   * показывает — оператору неинтересно).
   *
   * Поле опционально (`?`) — старые потребители без пересборки
   * shared-пакета продолжают компилироваться.
   */
  constructorTaskId?: string | null;
  constructorTaskStatus?: string | null;

  /**
   * Этап «Цена продажи за единицу» (см.
   * `prisma/schema.prisma::Order.customerUnitPrice`,
   * `apps/api/src/modules/orders/orders.service.ts::create`/`update`).
   *
   * Цена продажи 1 изделия и валюта (`RUB`/`USD`/`null`). Decimal
   * сериализуется строкой (`Prisma.Decimal.toString()`); либо
   * строкой, либо числом — `string | number` сохранён для
   * backward-compat с DTO-консьюмерами, которые могли ожидать
   * число.
   *
   * Поля опциональны (`?`) и nullable — старые потребители без
   * пересборки shared-пакета продолжают компилироваться, новые
   * заказы без указанной цены приходят с `null`.
   */
  customerUnitPrice?: string | number | null;
  customerCurrency?: MoneyCurrency | null;

  /**
   * Этап «Склад выпуска готовой продукции» (см.
   * `prisma/schema.prisma::Order.finishedGoodsWarehouseId`).
   *
   * Управленческая ссылка на склад, на который менеджер планирует
   * выпустить готовую продукцию по заказу. Краткий объект
   * `{ id, name, code }` — для UI списков и карточек, чтобы не
   * делать дополнительный запрос за именем. `null` означает «не
   * выбран» (исторические заказы / новый создаваемый заказ без
   * указания склада).
   *
   * Поле сознательно опционально (`?`) — старые потребители без
   * пересборки shared-пакета продолжают компилироваться. Новые
   * клиенты получают `null` или объект.
   */
  finishedGoodsWarehouseId?: string | null;
  finishedGoodsWarehouse?: {
    id: string;
    name: string;
    code: string | null;
  } | null;

  /**
   * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
   * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
   * `apps/api/src/modules/orders/orders.service.ts`,
   * `apps/api/src/modules/costs/costs.service.ts`,
   * `docs/current-state.md §«Давальческое сырьё клиента»`).
   *
   *   - `INCLUDE` — материалы и фурнитура учитываются в себестоимости
   *     заказа и в production cost (default);
   *   - `EXCLUDE` — давальческое сырьё / фурнитура клиента: расчёт
   *     потребности и складские движения продолжают работать, но
   *     MATERIAL / HARDWARE не включаются в себестоимость заказа и
   *     production cost.
   *
   * Поле сознательно опционально (`?`) — старые потребители без
   * пересборки shared-пакета продолжают компилироваться. Backend
   * всегда отдаёт значение (default `INCLUDE` для исторических
   * заказов после миграции).
   */
  materialsAndHardwareCostPolicy?: OrderMaterialsAndHardwareCostPolicy;

  /**
   * Этап 2 «План операций на заказе» (см.
   * `docs/operation-time-norms-recon.md §10/§11`,
   * `apps/api/src/modules/orders/order-operation-plan.service.ts`,
   * `prisma/schema.prisma::Order.operationCostPlanRub`).
   *
   * Snapshot плановой стоимости операций (₽) и плановое время
   * выполнения заказа (секунды) — рассчитываются на
   * `OrdersService.create` / `update` (DRAFT) / `startCalculation`
   * и замораживаются после `start()`. В отличие от `costEstimateTotalRub`
   * это плановая оценка операций, а не финансовый документ с
   * материалами/фурнитурой/курсами.
   *
   * Все четыре поля опциональны (`?`) и nullable — старые потребители
   * без пересборки shared-пакета продолжают компилироваться, новые
   * заказы без рассчитанного плана приходят с `null` и
   * `operationPlanWarnings = ['Маршрут не выбран — план операций не
   * рассчитан']` либо аналогичной причиной.
   *
   * Decimal сериализуется строкой (см. `Prisma.Decimal.toString()`).
   * Поле допускает `string | number` для backward-compat с
   * DTO-консьюмерами, которые могли ожидать число.
   */
  operationCostPlanRub?: string | number | null;
  operationTimePlanSec?: number | null;
  /** ISO-string `Order.operationPlanCalculatedAt` или `null`. */
  operationPlanCalculatedAt?: string | null;
  /**
   * Список человекочитаемых warnings, нормализованный в `string[]`
   * маппером backend-а (`OrdersService.toListItemDto/toDetailDto`).
   * `null` — warnings нет / план не считался.
   *
   * Если в БД (`Json?`) лежит не-массив (например, исторические данные
   * другого формата) — маппер отдаёт `null` без падения, см.
   * `normalizeOperationPlanWarnings` в `OrdersService`.
   */
  operationPlanWarnings?: string[] | null;

  /**
   * Inline-создание изделия из формы заказа (см.
   * `prisma/schema.prisma::Order.productCreationMode`).
   * Default `EXISTING_PATTERN` для всех исторических заказов.
   */
  productCreationMode?: OrderProductCreationMode;
  /**
   * Стоимость разработки лекала из inline-сценария «Сделать расчёт»
   * (см. `prisma/schema.prisma::Order.patternDevelopmentCostRub`).
   * Заполняется только при `productCreationMode = CREATE_FOR_CALCULATION`.
   */
  patternDevelopmentCostRub?: string | number | null;
  /**
   * Входит ли стоимость разработки лекала в себестоимость заказа
   * (см. `prisma/schema.prisma::Order.patternDevelopmentCostInCostPrice`).
   * Default `true`. При `true` и `patternDevelopmentCostRub > 0` в
   * `OrderCostEstimate` появляется отдельная строка «Разработка лекала».
   */
  patternDevelopmentCostInCostPrice?: boolean;
}

/**
 * Этап 2 «План операций на заказе» — stale-detection в карточке
 * заказа (см. `docs/operation-time-norms-recon.md §11`,
 * `apps/api/src/modules/orders/order-operation-plan.service.ts::getFreshnessForOrder`).
 *
 * Поля **computed** в маппере `OrdersService.toDetailDto` — в БД не
 * хранятся, в `Order` колонок нет. Помогают UI карточки заказа
 * показать badge «Требует пересчёта» и человекочитаемую причину
 * («После расчёта менялись операции, ставки или нормы времени» и т.п.).
 *
 * Все три поля опциональны (`?`) и nullable, чтобы:
 *   - старые потребители без пересборки shared-пакета продолжали
 *     компилироваться;
 *   - на списке заказов (`OrderListItemDto`) поля сознательно
 *     отсутствуют — расчёт freshness требует доп.запросов в БД,
 *     и на MVP мы не хотим грузить им список (см. ТЗ §2 «не делать
 *     дорогое вычисление в списке заказов, если это тяжело»).
 */
export interface OrderOperationPlanFreshness {
  /** `true` ⇔ источник плана был изменён после snapshot-а либо
   * snapshot ещё не считался при наличии маршрута и items. */
  operationPlanIsStale?: boolean | null;
  /** Человекочитаемая причина для UI badge.
   * Например:
   *   - «После расчёта менялись операции, ставки или нормы времени»;
   *   - «План операций ещё не рассчитан»;
   *   - `null` — план свежий или маршрут не выбран. */
  operationPlanStaleReason?: string | null;
  /** ISO-string max(updatedAt) источников плана: `RouteTemplate`,
   * `Operation`, `OperationRateBySize`, `OperationTimeNormBySize`.
   * `null`, если источников нет (заказ без маршрута). */
  operationPlanSourceUpdatedAt?: string | null;
}

export interface OrderDetailDto
  extends OrderListItemDto,
    OrderOperationPlanFreshness {
  items: OrderItemDto[];
  summary: OrderSummary;
  sizeBreakdown: OrderSizeBreakdownRow[];
  /**
   * Snapshot маршрута на заказе. Заполняется в `OrdersService.start()`
   * по шаблону `routeTemplateId`; пустой массив = «маршрут не
   * фиксировался» (заказ либо ещё не запущен, либо запущен без шаблона).
   */
  routeSteps: OrderRouteStepDto[];
  /**
   * Tech card MVP (ADR-0022): привязка к шаблону техкарты. Хранится id
   * + краткое имя для UI карточки заказа, чтобы не делать
   * дополнительный запрос за деталями. `null` означает «техкарта не
   * выбрана» — snapshot будет пуст и после `start()`.
   */
  techCardId: string | null;
  techCardCode: string | null;
  techCardName: string | null;
  /**
   * Спецификацию правили, а автопересчёт потребности не прошёл
   * (`OrdersService.recalcNeedsAndMarkStale`). Отметка ДУБЛИРУЕТСЯ в каждой
   * строке потребности (`orderNeedsStaleAt`), но строк может не быть вовсе —
   * тогда единственный носитель отметки этот, иначе отказ пересчёта остаётся
   * невидимым: вкладка показывает пустоту без объяснения.
   * Опционально (`?`) для backward-compat.
   */
  needsStaleAt?: string | null;
  needsStaleReason?: string | null;
  /**
   * Snapshot строк материалов на заказе. Заполняется в
   * `OrdersService.start()` по шаблону `techCardId`; пустой массив =
   * «техкарта не фиксировалась» (заказ либо ещё не запущен, либо
   * запущен без техкарты).
   */
  materialRequirements: OrderMaterialRequirementDto[];
  /**
   * Snapshot строк внешних подрядных размещений на заказе. Семантика
   * аналогична `materialRequirements`.
   */
  outsourceRequirements: OrderOutsourceRequirementDto[];
  /**
   * Ручные строки логистики/доставки заказа (см. `model
   * OrderLogisticsLine`, `OrderLogisticsLineDto`). Менеджер добавляет
   * их вручную в конце таблицы «Операции» карточки заказа. Опционально
   * (`?`) для backward-compat: старые потребители без пересборки
   * shared-пакета продолжают компилироваться. Backend всегда отдаёт
   * массив (может быть пустым).
   */
  logisticsLines?: OrderLogisticsLineDto[];
  /**
   * Этап «Нанесение на заказе покупателя» (см. `model OrderApplication`,
   * `apps/api/src/modules/order-applications/*`,
   * `packages/shared/src/order-applications.ts`).
   *
   * Список заказных нанесений — параметры конкретного заказа
   * (тип / stage / размер / количество / цвет / описание / файл /
   * статус). Менять можно только в `DRAFT`. Используется в
   * `CutReadinessService` для проверки готовности к крою и в
   * `WorkshopNeedsService` как новый источник `APPLICATION`-потребностей.
   *
   * `OrderApplicationDto[]` опционально (`?`) для backward-compat:
   * старые потребители без пересборки shared-пакета продолжают
   * компилироваться. Backend всегда отдаёт массив (может быть пустым).
   */
  applications?: OrderApplicationDto[];

  /**
   * Этап «Себестоимость заказа» (см.
   * `prisma/schema.prisma::OrderCostEstimate`,
   * `apps/api/src/modules/orders/orders.service.ts::completeCalculation`).
   *
   * Snapshot-поля заполняются при `completeCalculation` и
   * сбрасываются в `null` при `reopenCalculation`. Все поля
   * опциональны и nullable — старые заказы без завершённого расчёта
   * остаются валидными.
   *
   *   - `costEstimateTotalRub`     — итоговая сумма заказа в рублях;
   *   - `costEstimateCompletedAt`  — когда расчёт был зафиксирован;
   *   - `costEstimateVersion`      — порядковый номер расчёта по этому
   *                                  заказу (растёт на каждый
   *                                  `completeCalculation`).
   *
   * Все поля Decimal сериализуются строкой
   * (см. `Prisma.Decimal.toString()`); либо строкой, либо числом —
   * `string | number` сохранён для backward-compat с DTO-консьюмерами,
   * которые могли ожидать число.
   */
  costEstimateTotalRub?: string | number | null;
  costEstimateCompletedAt?: string | null;
  costEstimateVersion?: number | null;
  /**
   * Полный документ активного расчёта (`status = COMPLETED`). На MVP
   * backend подгружает его одним include в `getOne`. `null` для
   * заказов без активного расчёта (DRAFT/CALCULATION/REVOKED-only).
   */
  currentCostEstimate?: OrderCostEstimateDto | null;

  /**
   * Этап «Конструкторское бюро» — полная карточка связанной задачи
   * (см. `model ConstructorTask`). Если есть, UI на странице заказа
   * рендерит блок «Конструкторское бюро» с действиями приёмки/возврата
   * на доработку. `null` — у заказа нет связанной задачи.
   *
   * Опционально (`?`) для backward-compat: старые потребители без
   * пересборки shared-пакета продолжают компилироваться. Backend
   * всегда отдаёт значение (`null` или объект).
   */
  constructorTask?: ConstructorTaskSummaryDto | null;

  /**
   * Переходы статуса заказа из текущего состояния — по одному элементу
   * на каждый статус, кроме текущего, включая НЕДОСТУПНЫЕ (с кодом и
   * текстом причины). Считается на бэке общим pure-helper-ом
   * `evaluateOrderTransitions` (см. `@sewing/shared/order-transitions`),
   * который зеркалит гейты `OrdersService`.
   *
   * Нужен контролу «Статус заказа» (выпадающий список в шапке карточки):
   * список показывает весь маршрут заказа, поэтому UI обязан знать
   * причину блокировки ДО клика. Считать её на фронте нельзя — правила
   * разъедутся с backend-гейтами.
   *
   * Опционально (`?`) для backward-compat: старые потребители без
   * пересборки shared-пакета продолжают компилироваться. Backend
   * всегда отдаёт массив.
   */
  availableTransitions?: OrderTransitionDto[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Счётчики вкладок «Активные» / «Архив» списка заказов. Считаются под
 * теми же фильтрами, что и сама выдача (поиск / клиент / подразделение /
 * бакет срока), но БЕЗ фильтра вкладки — иначе цифра на неактивной
 * вкладке всегда была бы нулём.
 */
export interface OrderListTabCounts {
  active: number;
  archive: number;
}

/**
 * Ответ `GET /orders`. Это `Paginated<OrderListItemDto>` плюс
 * опциональные счётчики вкладок — они приходят, только если в запросе
 * был `tab` (см. `ListOrdersQuerySchema.tab`).
 */
export interface OrderListResponse extends Paginated<OrderListItemDto> {
  tabCounts?: OrderListTabCounts;
}

// ---------------------------------------------------------------------------
// Dictionaries (minimal for order form UI)
// ---------------------------------------------------------------------------

export interface SizeDto {
  id: string;
  code: string;
  sortOrder: number;
}

export interface ProductDto {
  id: string;
  name: string;
  color: string;
  active: boolean;
}
