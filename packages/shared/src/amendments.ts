/**
 * Контракты фичи «Правка заказа в производстве» (order amendments).
 *
 * Бэкенд: `apps/api/src/modules/order-amendments/*`
 * (`/api/orders/:id/amendments/*`). Веб: `apps/web/lib/amendments-api.ts`,
 * `components/orders/amendments/*`. Фича под флагом
 * `FEATURE_ORDER_AMENDMENTS` (на проде OFF по умолчанию, на dev ON).
 *
 * Смысл: после запуска заказа (`IN_PRODUCTION`) его план заморожен
 * (ADR-0006). Amendment — второй, узкий ярус редактируемости: аддитивные,
 * forward-only правки, которые ДОСТРАИВАЮТ производные снимки, а не
 * пересоздают их, и защищены проверкой уже выполненной работы.
 *
 * ФАЗА 1 (этот срез) — только «количество по размерам»:
 *   - меняем `OrderItem.qtyPlan` (+ `OrderVariantSize` у single-variant),
 *     `CuttingTaskSizeRow.qtyPlan`, снимок материалов и плановую
 *     стоимость/время операций;
 *   - нельзя опустить план ниже уже раскроенного (Σ `Passport.qtyCut`) —
 *     код `AMENDMENT_BELOW_CUT`;
 *   - заказы с ≥2 расцветками пока не поддержаны (правка per-цвет —
 *     следующая фаза), код `AMENDMENT_MULTIVARIANT_UNSUPPORTED`.
 */

import { z } from 'zod';

/** Верхняя граница планового количества (как у items/colorways). */
export const AMENDMENT_QTY_MAX = 1_000_000;

/** Одна правка: новый плановый тираж по размеру. */
export const QuantityAmendmentChangeSchema = z.object({
  sizeId: z.string().min(1),
  newQtyPlan: z.number().int().min(0).max(AMENDMENT_QTY_MAX),
});
export type QuantityAmendmentChange = z.infer<
  typeof QuantityAmendmentChangeSchema
>;

/** Тело применения правки количества. */
export const ApplyQuantityAmendmentSchema = z.object({
  changes: z
    .array(QuantityAmendmentChangeSchema)
    .min(1, 'Укажите хотя бы один размер'),
  reason: z.string().trim().min(1, 'Укажите причину правки').max(500),
});
export type ApplyQuantityAmendmentDto = z.infer<
  typeof ApplyQuantityAmendmentSchema
>;

/**
 * Строка состояния размера для drawer-а: текущий план, уже раскроено
 * (нижняя граница правки) и код размера.
 */
export interface QuantityAmendmentRowDto {
  sizeId: string;
  sizeCode: string;
  /** Текущий `OrderItem.qtyPlan`. */
  currentQtyPlan: number;
  /** Σ `Passport.qtyCut` (кроме CANCELLED) — минимум, ниже которого нельзя. */
  qtyCut: number;
}

/**
 * Ответ GET-состояния: что можно править и с какими ограничениями.
 * Клиент считает «после»-влияние локально из этих строк.
 */
export interface QuantityAmendmentStateDto {
  orderId: string;
  /** Заказ в статусе, где правка количества разрешена (`IN_PRODUCTION`). */
  editable: boolean;
  /** ≥2 расцветок — правка количества per-цвет пока не поддержана. */
  multiVariant: boolean;
  /**
   * По строкам потребности уже есть движения склада — авто-пересчёт
   * потребностей при правке будет пропущен (нужно обновить вручную).
   */
  needsHaveStock: boolean;
  rows: QuantityAmendmentRowDto[];
}

/** Результат применения правки количества. */
export interface QuantityAmendmentResultDto {
  orderId: string;
  applied: boolean;
  /** Потребности были пересчитаны автоматически. */
  needsRecalculated: boolean;
  /** Человекочитаемые предупреждения (напр. «потребности не пересчитаны»). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// ФАЗА 2 — размерность (добавить / убрать размер в производстве).
// ---------------------------------------------------------------------------

/** Добавляемый размер: новый плановый тираж. */
export const SizeAmendmentAddSchema = z.object({
  sizeId: z.string().min(1),
  qtyPlan: z.number().int().min(1).max(AMENDMENT_QTY_MAX),
});
export type SizeAmendmentAdd = z.infer<typeof SizeAmendmentAddSchema>;

/** Тело правки размерности: добавить/убрать размеры одним сабмитом. */
export const ApplySizeAmendmentSchema = z
  .object({
    add: z.array(SizeAmendmentAddSchema).default([]),
    /** sizeId размеров к удалению (только не начатых в работе). */
    remove: z.array(z.string().min(1)).default([]),
    reason: z.string().trim().min(1, 'Укажите причину правки').max(500),
  })
  .refine((d) => d.add.length + d.remove.length > 0, {
    message: 'Укажите хотя бы одно изменение размерности',
  });
export type ApplySizeAmendmentDto = z.infer<typeof ApplySizeAmendmentSchema>;

/** Размер, уже присутствующий в заказе. */
export interface SizeAmendmentCurrentRowDto {
  sizeId: string;
  sizeCode: string;
  qtyPlan: number;
  /** Σ `Passport.qtyCut` (кроме CANCELLED). */
  qtyCut: number;
  /**
   * Размер можно убрать: по нему ещё нет ни раскроя (паспортов), ни
   * настилов раскроя. Иначе удаление запрещено (раскрой необратим).
   */
  removable: boolean;
}

/** Размер каталога, доступный для добавления в заказ. */
export interface SizeAmendmentAvailableRowDto {
  sizeId: string;
  sizeCode: string;
  /**
   * У лекала заказа есть активный файл на этот размер. `false` —
   * раскрой не пройдёт готовность, пока файл не загрузят (предупреждение,
   * не запрет). `true` также когда у заказа нет лекала (нет ограничения).
   */
  inPattern: boolean;
}

/** Ответ GET-состояния правки размерности. */
export interface SizeAmendmentStateDto {
  orderId: string;
  editable: boolean;
  multiVariant: boolean;
  needsHaveStock: boolean;
  current: SizeAmendmentCurrentRowDto[];
  available: SizeAmendmentAvailableRowDto[];
}

/** Результат применения правки размерности. */
export interface SizeAmendmentResultDto {
  orderId: string;
  applied: boolean;
  needsRecalculated: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// ФАЗА 3 — добавить операцию в маршрут заказа в производстве.
// ---------------------------------------------------------------------------

/**
 * Тело добавления операции. `afterIndex` — вставить сразу ПОСЛЕ шага
 * заказа с этим index; `null`/отсутствует — в конец маршрута. Позиция
 * обязана быть «впереди фронта» (дальше всех паспортов), иначе backend
 * отдаст 409 `AMENDMENT_OPERATION_BEHIND_FRONTIER`.
 */
export const ApplyOperationAmendmentSchema = z.object({
  operationId: z.string().min(1),
  afterIndex: z.number().int().min(0).nullable().optional(),
  reason: z.string().trim().min(1, 'Укажите причину правки').max(500),
});
export type ApplyOperationAmendmentDto = z.infer<
  typeof ApplyOperationAmendmentSchema
>;

/** Шаг маршрута заказа (снимок) для выбора позиции вставки. */
export interface OperationAmendmentStepDto {
  index: number;
  operationId: string;
  operationName: string;
  /**
   * Шаг «впереди фронта» — все паспорта его ещё не прошли. Вставлять
   * новую операцию можно только ПОСЛЕ такого шага (чисто аддитивно, без
   * возврата уже сделанной работы).
   */
  ahead: boolean;
}

/** Операция каталога, доступная для добавления. */
export interface OperationAmendmentOptionDto {
  id: string;
  code: string;
  name: string;
}

/** Ответ GET-состояния добавления операции. */
export interface OperationAmendmentStateDto {
  orderId: string;
  editable: boolean;
  /**
   * Индекс дальше которого стоят все паспорта (`max currentRouteStepIndex`,
   * −1 если паспортов нет). Вставлять операцию можно после шага с
   * `index >= frontierIndex` либо в конец.
   */
  frontierIndex: number;
  steps: OperationAmendmentStepDto[];
  availableOperations: OperationAmendmentOptionDto[];
}

/** Результат добавления операции. */
export interface OperationAmendmentResultDto {
  orderId: string;
  applied: boolean;
  /** Индекс, на который встала новая операция. */
  insertedIndex: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Журнал правок в производстве (аудит ORDER_QTY_AMENDED / ORDER_SIZE_AMENDED
// / ORDER_OPERATION_ADDED). Read-only, для карточки заказа.
// ---------------------------------------------------------------------------

/** Одна запись журнала правок. `summary` уже человекочитаемый (собран на backend). */
export interface AmendmentHistoryEntryDto {
  id: string;
  /** ISO-время события. */
  occurredAt: string;
  /** Кто применил правку (`null` — актор не сохранён). */
  actorName: string | null;
  kind: 'quantity' | 'size' | 'operation';
  /** Причина, указанная менеджером. */
  reason: string | null;
  /** Готовая строка «что изменилось» (коды размеров/имя операции уже подставлены). */
  summary: string;
}
