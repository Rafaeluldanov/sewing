/**
 * DTO для «балансировки производственной цепочки» по операциям заказа
 * (см. карточку заказа `/admin/orders/[id]`, блок «Производственная
 * цепочка»; `apps/api/src/modules/orders/order-production-balance.service.ts`,
 * `GET /api/orders/:id/production-balance`).
 *
 * Это **плановая рекомендация**, а не факт работы сотрудников:
 *   - не пишем в БД (computed endpoint);
 *   - не назначаем конкретных сотрудников по именам, только
 *     количество людей на операцию / по категориям;
 *   - payroll / `OperationEntry` / `SalaryEntry` / Passport /
 *     `OrderCostEstimate` / `WorkshopNeed` / `PurchaseOrder` /
 *     `PurchaseReceipt` сервис не трогает.
 *
 * Алгоритм коротко:
 *   - workSec(op) = Σ (qtyPlan × timeSec(op,size));
 *   - default-режим `LINE_BALANCE` смотрит на текущий доступный штат
 *     (active `Employee.role` ↔ `Operation.category`), распределяет
 *     людей по операциям категории и считает выпуск, простой и
 *     рекомендацию «куда добавить +1»;
 *   - режим `TARGET_SHIFT` остаётся справочным («что нужно, чтобы
 *     уложиться в одну смену»).
 *
 * Подробнее: см. JSDoc сервиса `OrderProductionBalanceService.getForOrder`.
 */
import type { OperationCategory } from './operations';

/**
 * Доступные стратегии расчёта рекомендации (см.
 * `OrderProductionBalanceService.getForOrder`).
 *
 * - `LINE_BALANCE`    — **default**. Балансировка цепочки по
 *   текущему доступному штату: считаем выпуск за смену, простой,
 *   узкое место и рекомендацию «куда добавить +1 сотрудника».
 *   Никаких виртуальных сотрудников по умолчанию не создаём.
 * - `TARGET_SHIFT`    — справочный режим «уложиться в одну
 *   8-часовую смену». Считает, сколько сотрудников нужно
 *   (`ceil(workSec / shiftSeconds)`) и сравнивает с доступными.
 * - `TOTAL_WORKERS`   — задано общее число людей на цепочку, сервис
 *   распределяет их greedy по самым тяжёлым операциям.
 * - `TARGET_DURATION` — задано «уложиться в N секунд»; сервис считает
 *   `ceil(workSec / N)` людей на каждую операцию.
 */
export const PRODUCTION_BALANCE_STRATEGIES = [
  'LINE_BALANCE',
  'TARGET_SHIFT',
  'TOTAL_WORKERS',
  'TARGET_DURATION',
] as const;
export type ProductionBalanceStrategy =
  (typeof PRODUCTION_BALANCE_STRATEGIES)[number];

/** Лейблы стратегий для UI (см. `ProductionBalanceCard`). */
export const PRODUCTION_BALANCE_STRATEGY_LABELS: Record<
  ProductionBalanceStrategy,
  string
> = {
  LINE_BALANCE: 'Балансировка цепочки',
  TARGET_SHIFT: 'Под одну смену',
  TOTAL_WORKERS: 'Задано сотрудников',
  TARGET_DURATION: 'Под заданное время',
};

/** Стратегия по умолчанию, если query-параметры не заданы. */
export const DEFAULT_PRODUCTION_BALANCE_STRATEGY: ProductionBalanceStrategy =
  'LINE_BALANCE';

/**
 * Строка балансировки по одной операции маршрута заказа.
 *
 * `workSec` — суммарное «человеко-секундное» время работы по операции
 * (Σ qtyPlan × timeSec(op,size)). Если у операции нет нормы времени
 * для какого-то размера, в строке появится warning, и эта пара
 * (op×size) считается как `0` секунд.
 *
 * Сотрудники:
 * - В `LINE_BALANCE` `assignedWorkers` приходит из распределения
 *   доступного штата по категориям; `suggestedWorkers` совпадает с
 *   `assignedWorkers` (для обратной совместимости с UI/тестами).
 * - В `TARGET_SHIFT`/`TOTAL_WORKERS`/`TARGET_DURATION`
 *   `suggestedWorkers` — расчётная рекомендация, а
 *   `assignedWorkers` равен `suggestedWorkers` (виртуальных
 *   сотрудников «как доступных» не создаём, поле информационное).
 *
 * `isBottleneck = true` ровно у одной строки. В `LINE_BALANCE` — это
 * операция с минимальным `capacityPerShift`. В прочих стратегиях —
 * операция с максимальной `plannedDurationSec`.
 */
export interface OrderProductionBalanceLineDto {
  operationId: string;
  operationCode: string;
  operationName: string;
  /**
   * Категория операции (`CUTTING` / `SEWING` / `QC` / `IRONING` /
   * `PACKING`). В `LINE_BALANCE` определяет роль сотрудников
   * (`Operation.category` ↔ `Employee.role`).
   */
  operationCategory: OperationCategory;
  /** Индекс шага в `RouteTemplate.steps[]` (0-based). */
  routeStepIndex: number;
  /** Σ `OrderItem.qtyPlan` по обязательным размерам этой операции. */
  totalQty: number;
  /** Σ `qtyPlan × timeSec(op,size)` (целое количество секунд). */
  workSec: number;
  /** Среднее время на единицу: `workSec / totalQty`. `null`, если
   * `totalQty <= 0` (защита от деления на 0). */
  avgSecPerUnit: number | null;
  /**
   * Сколько сотрудников рекомендовано/назначено на операцию.
   * В `LINE_BALANCE` равно `assignedWorkers`. В прочих стратегиях —
   * расчётное число (см. JSDoc выше).
   */
  suggestedWorkers: number;
  /**
   * В `LINE_BALANCE` — сколько сотрудников РЕАЛЬНО назначено на
   * операцию из доступного штата по категории. В прочих стратегиях
   * совпадает с `suggestedWorkers`.
   */
  assignedWorkers: number;
  /**
   * Плановая длительность операции при выбранной расстановке:
   * `workSec / max(workers, 1)`. `0`, если `workSec = 0` (нет нормы
   * времени).
   */
  plannedDurationSec: number;
  /**
   * Сколько штук эта операция МОЖЕТ выдать за смену при выбранной
   * расстановке: `floor(assignedWorkers × shiftSeconds /
   * avgSecPerUnit)`. `null`, если назначено 0 сотрудников или нет
   * нормы времени.
   */
  capacityPerShift: number | null;
  /**
   * Алиас для `capacityPerShift` (обратная совместимость со старым
   * UI/тестами; раньше поле называлось `throughputPerShift`).
   */
  throughputPerShift: number | null;
  /**
   * Утилизация операции относительно реального выпуска линии:
   * `100 × lineThroughputPerShift / capacityPerShift`. У узкого места
   * = 100. У операций без расчётной capacity — `null`.
   */
  utilizationPercent: number | null;
  /**
   * Простой операции относительно реального выпуска линии:
   * `1 - lineThroughputPerShift / capacityPerShift` (0..1).
   * У узкого места = 0. `null`, если capacity не определена.
   */
  idlePercent: number | null;
  /** Строка-узкое место заказа (минимальный `capacityPerShift`). */
  isBottleneck: boolean;
  /**
   * `true`, если симуляция «+1 сотрудника на эту операцию» даёт
   * прирост выпуска линии. Используется для бейджа «Добавить +1»
   * в таблице.
   */
  recommendedToAddWorker: boolean;
  /**
   * Прирост выпуска линии при добавлении +1 сотрудника к этой
   * операции (шт/смену). `null`, если симуляция невозможна (нет
   * нормы времени или линия неактивна).
   */
  addOneWorkerGain: number | null;
  /** Локализованные warnings про эту операцию (нет нормы времени по
   * размеру, и т.п.). */
  warnings: string[];
}

/**
 * Рекомендация «добавить N сотрудников на операцию X».
 *
 * Формируется в `LINE_BALANCE`-режиме по результату симуляции
 * «+1 сотрудника» по каждой операции. На MVP отдаём top-1, но DTO
 * массив — UI может показать top-3 без изменения backend.
 */
export interface OrderProductionBalanceRecommendationDto {
  operationId: string;
  operationName: string;
  operationCategory: OperationCategory;
  /** Сколько сотрудников рекомендуется добавить (на MVP всегда 1). */
  addWorkers: number;
  /** Текущий выпуск линии (шт/смену) до добавления. */
  currentOutputPerShift: number | null;
  /** Ожидаемый выпуск линии (шт/смену) после добавления. */
  expectedOutputPerShift: number | null;
  /** Прирост: `expected - current`. */
  gainPerShift: number | null;
  /** Человекочитаемая причина рекомендации. */
  reason: string;
}

/**
 * Результат `GET /api/orders/:id/production-balance`. Снимок не
 * сохраняется в БД, считается на лету из live-данных
 * (`Order.routeTemplate.steps[]` × `Operation.timeNorm*` × `OrderItem.qtyPlan`,
 * `Employee.role` × `Employee.active`).
 */
export interface OrderProductionBalanceDto {
  orderId: string;
  /** Σ `OrderItem.qtyPlan` (одинаковый для всей цепочки). */
  totalQty: number;
  /** Длина смены (секунды). По умолчанию 8 часов = 28800. */
  shiftSeconds: number;
  /** Целевая длительность операции в режимах TARGET_SHIFT / TARGET_DURATION.
   * `null`, если стратегия = TOTAL_WORKERS / LINE_BALANCE. */
  targetDurationSec: number | null;
  /** Сколько людей доступно на цепочку (стратегия TOTAL_WORKERS).
   * `null` для остальных стратегий. */
  totalWorkers: number | null;
  /** Какую стратегию выбрал backend (см. `PRODUCTION_BALANCE_STRATEGIES`). */
  strategy: ProductionBalanceStrategy;
  /**
   * `LINE_BALANCE`: реальный выпуск цепочки за смену = min(capacity)
   * по операциям с активной расстановкой. `null`, если линия
   * неактивна (нет норм / нет сотрудников).
   * В прочих стратегиях — то же, что `expectedOutputPerShift`.
   */
  lineThroughputPerShift: number | null;
  /**
   * `LINE_BALANCE`: оценка количества смен на выпуск всего заказа =
   * `totalQty / lineThroughputPerShift`. `null`, если выпуск 0.
   */
  plannedShifts: number | null;
  /**
   * Доступно сотрудников по всем категориям (active + role в
   * mapping категорий). `null`, если backend не считал штат
   * (например, заказ без маршрута).
   */
  availableWorkersTotal: number | null;
  /**
   * Сколько сотрудников реально размещено на цепочке. В
   * `LINE_BALANCE` — Σ `assignedWorkers` по строкам, не превышает
   * `availableWorkersTotal`. В прочих стратегиях — Σ
   * `suggestedWorkers`.
   */
  assignedWorkersTotal: number | null;
  /**
   * `TARGET_SHIFT`: сколько сотрудников нужно, чтобы выполнить заказ
   * за одну смену (Σ `ceil(workSec / shiftSeconds)`). `null` для
   * других стратегий.
   */
  requiredWorkersTotal?: number | null;
  /**
   * `TARGET_SHIFT`: разница между требуемым и доступным штатом.
   * Положительное число = «не хватает K сотрудников». `null` для
   * других стратегий.
   */
  missingWorkersForTargetShift?: number | null;
  /**
   * Плановая длительность всего заказа = `max(line.plannedDurationSec)`
   * по операциям с `workers > 0`. `null`, если ни одной активной
   * операции (нет норм / нет items / нет маршрута).
   * В `LINE_BALANCE` = `plannedShifts × shiftSeconds`.
   */
  orderPlannedDurationSec: number | null;
  /**
   * Сколько штук может выпустить цепочка за смену.
   * В `LINE_BALANCE` = `lineThroughputPerShift`.
   * В прочих режимах — `floor(totalQty × shiftSeconds /
   * orderPlannedDurationSec)`.
   * `null`, если расчёт невозможен.
   */
  expectedOutputPerShift: number | null;
  /** Имя узкого места (для UI-сводки). `null`, если активных операций нет. */
  bottleneckOperationName: string | null;
  /**
   * Топ-рекомендации «куда добавить сотрудника» (на MVP длина 0..1).
   * Заполняется только в `LINE_BALANCE`. В прочих стратегиях — пусто.
   */
  recommendedAdditions: OrderProductionBalanceRecommendationDto[];
  /** Глобальные warnings (маршрут не выбран, нет норм, нехватка
   * сотрудников по категории и т.п.). */
  warnings: string[];
  /** Построчная разбивка по операциям маршрута (только
   * НЕ-`isOptional`). Сортировка по `routeStepIndex` ASC. */
  lines: OrderProductionBalanceLineDto[];
}

/**
 * Query-параметры эндпоинта (см.
 * `OrdersController.getProductionBalance`). Все поля опциональны;
 * семантика обрабатывается сервисом:
 *   - если ничего не задано → `LINE_BALANCE` (default);
 *   - если `strategy` задана явно — используем её;
 *   - если задан `totalWorkers` → стратегия `TOTAL_WORKERS`
 *     (имеет приоритет над `strategy=LINE_BALANCE`);
 *   - если задан `targetDurationSec` → стратегия `TARGET_DURATION`.
 */
export interface OrderProductionBalanceQuery {
  strategy?: ProductionBalanceStrategy;
  shiftSeconds?: number;
  totalWorkers?: number;
  targetDurationSec?: number;
}
