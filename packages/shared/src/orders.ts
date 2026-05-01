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

import type { OrderRouteStepDto } from './routes';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Статусы заказа. Совпадают с `OrderStatus` в Prisma-схеме.
 *
 * - `DRAFT`          — черновик, план ещё редактируется
 * - `IN_PRODUCTION`  — запущен в производство, план иммутабелен (ADR-0006)
 * - `DONE`           — завершён (ручной перевод на Шаге 4)
 * - `CANCELLED`      — отменён
 */
export const ORDER_STATUSES = ['DRAFT', 'IN_PRODUCTION', 'DONE', 'CANCELLED'] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

const DateStringSchema = z
  .string()
  .min(1, 'Дата обязательна')
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Некорректная дата',
  });

export const CreateOrderItemSchema = z.object({
  sizeId: z.string().min(1, 'sizeId обязателен'),
  qtyPlan: z
    .number({ invalid_type_error: 'qtyPlan должен быть числом' })
    .int('qtyPlan должен быть целым')
    .positive('qtyPlan должен быть > 0'),
});

export const CreateOrderSchema = z.object({
  orderDate: DateStringSchema,
  productId: z.string().min(1, 'productId обязателен'),
  /**
   * Цвет: опционален. На MVP приходит с фронта и может быть перезаписан
   * сервером значением `Product.color`, если явно не задан.
   */
  color: z.string().trim().min(1).max(64).optional(),
  comment: z.string().max(2000).optional(),
  customer: z.string().max(200).optional(),
  dueDate: DateStringSchema.optional(),
  /**
   * Soft-route MVP: опциональная привязка к шаблону маршрута. Шаги
   * шаблона фиксируются в snapshot `OrderRouteStep[]` при первом
   * `OrdersService.start()`. Не задан — заказ запускается «без маршрута»
   * (полная backward compatibility со старым flow).
   */
  routeTemplateId: z.string().min(1).optional(),
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
    }),
});
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;
export type CreateOrderItemDto = z.infer<typeof CreateOrderItemSchema>;

/**
 * Редактирование заказа. Допускается только пока `status = DRAFT`
 * (см. ADR-0006). При `IN_PRODUCTION` API отдаёт 409 `ORDER_LOCKED`.
 *
 * Правила:
 * - если передан `items` — полностью заменяет текущий набор строк;
 * - если поле не передано — не меняется.
 */
export const UpdateOrderSchema = z.object({
  orderDate: DateStringSchema.optional(),
  productId: z.string().min(1).optional(),
  color: z.string().trim().min(1).max(64).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  dueDate: DateStringSchema.nullable().optional(),
  /**
   * Soft-route MVP: смена/сброс шаблона маршрута до запуска заказа
   * (status = DRAFT). После `start()` поле остаётся read-only — snapshot
   * уже зафиксирован.
   */
  routeTemplateId: z.string().min(1).nullable().optional(),
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
});
export type UpdateOrderDto = z.infer<typeof UpdateOrderSchema>;

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

export const ListOrdersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: OrderStatusSchema.optional(),
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

export interface OrderListItemDto {
  id: string;
  number: string;
  orderDate: string; // ISO
  createdAt: string; // ISO
  updatedAt: string; // ISO
  status: OrderStatus;
  productId: string | null;
  productName: string | null;
  color: string | null;
  comment: string | null;
  customer: string | null;
  dueDate: string | null;
  qtyPlanTotal: number;
  /**
   * Soft-route MVP: привязанный шаблон маршрута (или `null`, если заказ
   * запускается без маршрута). Хранится id + краткие поля для UI, чтобы
   * не делать дополнительный запрос за `code`/`name` шаблона.
   */
  routeTemplateId: string | null;
  routeTemplateCode: string | null;
  routeTemplateName: string | null;
}

export interface OrderDetailDto extends OrderListItemDto {
  items: OrderItemDto[];
  summary: OrderSummary;
  sizeBreakdown: OrderSizeBreakdownRow[];
  /**
   * Snapshot маршрута на заказе. Заполняется в `OrdersService.start()`
   * по шаблону `routeTemplateId`; пустой массив = «маршрут не
   * фиксировался» (заказ либо ещё не запущен, либо запущен без шаблона).
   */
  routeSteps: OrderRouteStepDto[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
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
