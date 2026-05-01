import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  OperationCategory as PrismaOperationCategory,
  Role as PrismaRole,
} from '@prisma/client';
import type {
  OrderProductionBalanceDto,
  OrderProductionBalanceLineDto,
  OrderProductionBalanceQuery,
  OrderProductionBalanceRecommendationDto,
  ProductionBalanceStrategy,
} from '@sewing/shared/order-production-balance';
import type { OperationCategory } from '@sewing/shared/operations';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Сервис балансировки производственной цепочки заказа
 * (см. карточку заказа `/admin/orders/[id]`, блок «Производственная
 * цепочка»; `apps/api/src/modules/orders/orders.controller.ts`,
 * `GET /api/orders/:id/production-balance`).
 *
 * Что делает:
 *   - читает live `Order.routeTemplate.steps[]` × `Operation.timeNorm*` ×
 *     `OrderItem.qtyPlan` и текущий **активный штат**
 *     `Employee.role` × `Employee.active`;
 *   - возвращает построчную балансировку и глобальную сводку
 *     (см. `OrderProductionBalanceDto`).
 *
 * Default-режим — **`LINE_BALANCE`** («Балансировка цепочки»):
 *   1. Для каждой обязательной операции маршрута считаем
 *      `workSec = Σ qtyPlan × timeSec(op,size)`.
 *   2. Для каждой категории операций (`CUTTING`/`SEWING`/`QC`/
 *      `IRONING`/`PACKING`) берём количество **активных** сотрудников
 *      соответствующей роли (`Employee.role` ↔ `Operation.category`).
 *   3. Распределяем доступных сотрудников по операциям внутри
 *      категории:
 *        - если `available >= ops.length` — даём каждой операции
 *          по 1 сотруднику и оставшихся раздаём greedy (туда, где
 *          плановая длительность максимальна);
 *        - если `available < ops.length` — раздаём людей по самым
 *          тяжёлым операциям (по 1) и оставляем остальные с 0
 *          сотрудников + warning «Сотрудников меньше, чем активных
 *          операций в категории …».
 *      Виртуальных сотрудников НЕ создаём (acceptance §2).
 *   4. Для каждой операции считаем
 *      `capacityPerShift = floor(assignedWorkers × shiftSeconds /
 *      avgSecPerUnit)`.
 *   5. `lineThroughputPerShift = min(capacityPerShift)` по операциям
 *      с `capacity > 0`.
 *   6. Простой / загрузка операций считаются относительно реального
 *      выпуска линии: `idle = max(0, 1 - line/capacity)`.
 *   7. Узкое место — операция с минимальным `capacityPerShift`.
 *   8. Симулируем «+1 сотрудник» на каждую операцию: считаем новый
 *      `lineThroughputPerShift` и выбираем операцию с максимальным
 *      приростом (`gainPerShift > 0`) — это и есть `recommendedAdditions[0]`.
 *
 * Справочный режим **`TARGET_SHIFT`** («Под одну смену»):
 *   - `suggestedWorkers = ceil(workSec / shiftSeconds)`;
 *   - дополнительно отдаём `requiredWorkersTotal` (Σ),
 *     `availableWorkersTotal` (active по mapping) и
 *     `missingWorkersForTargetShift = max(0, required - available)`.
 *
 * Прочие режимы (`TOTAL_WORKERS` / `TARGET_DURATION`) сохраняются
 * без изменений.
 *
 * Что НЕ делает (см. ТЗ §«Не делать»):
 *   - не пишет в БД (computed endpoint, без снапшотов);
 *   - не назначает конкретных сотрудников по именам, только
 *     количество людей на операцию/категорию;
 *   - не трогает payroll (`OperationEntry`/`SalaryEntry`/`PieceRate`),
 *     Passport, OrderCostEstimate, WorkshopNeed,
 *     PurchaseOrder/PurchaseReceipt;
 *   - НЕ добавляет LABOR-строку в себестоимость (это плановая
 *     рекомендация, не финансовый документ);
 *   - не использует `Employee.salaryPerShift`.
 */
@Injectable()
export class OrderProductionBalanceService {
  private readonly logger = new Logger(OrderProductionBalanceService.name);

  /** Длина смены по умолчанию: 8 часов = 28800 секунд. */
  static readonly DEFAULT_SHIFT_SECONDS = 8 * 60 * 60;

  /** Текст «дисклеймера» — добавляется к warnings, если расчёт состоялся. */
  static readonly NOTE_PARALLEL_ESTIMATE =
    'Расчёт является плановой оценкой и не учитывает ожидания между ' +
    'операциями, пачки, переналадку и простои.';

  /**
   * Маппинг категорий операций на роли сотрудников. Определяет,
   * каких сотрудников считать «доступными» по категории в
   * `LINE_BALANCE`. CUTTER_ASSISTANT, ADMIN, SHOP_MANAGER, DISPLAY,
   * SHOPFLOOR_MASTER в маппинге сознательно отсутствуют — они не
   * стоят на цеховых операциях.
   */
  static readonly CATEGORY_TO_ROLE: Record<OperationCategory, PrismaRole> = {
    CUTTING: 'CUTTER',
    SEWING: 'SEAMSTRESS',
    QC: 'QC',
    IRONING: 'IRONING',
    PACKING: 'PACKING',
  };

  constructor(private readonly prisma: PrismaService) {}

  async getForOrder(
    orderId: string,
    options: OrderProductionBalanceQuery = {},
  ): Promise<OrderProductionBalanceDto> {
    const shiftSeconds = normalizeShiftSeconds(options.shiftSeconds);
    const totalWorkersInput = normalizePositiveInt(options.totalWorkers);
    const targetDurationInput = normalizePositiveInt(options.targetDurationSec);
    const strategyInput = normalizeStrategy(options.strategy);
    const strategy = resolveStrategy(
      strategyInput,
      totalWorkersInput,
      targetDurationInput,
    );

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        routeTemplateId: true,
        items: {
          select: {
            sizeId: true,
            qtyPlan: true,
            size: { select: { code: true, sortOrder: true } },
          },
        },
        routeTemplate: {
          select: {
            id: true,
            steps: {
              orderBy: { index: 'asc' },
              select: {
                index: true,
                isOptional: true,
                operationId: true,
                operation: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    category: true,
                    timeNormMode: true,
                    timeNormSec: true,
                    timeNormsBySize: {
                      select: { sizeId: true, seconds: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const itemsWithQty = order.items.filter((it) => it.qtyPlan > 0);
    const totalQty = itemsWithQty.reduce((s, it) => s + it.qtyPlan, 0);

    if (!order.routeTemplateId || !order.routeTemplate) {
      return emptyBalance({
        orderId: order.id,
        totalQty,
        shiftSeconds,
        targetDurationSec: targetDurationInput,
        totalWorkers: totalWorkersInput,
        strategy,
        warnings: ['Маршрут не выбран — балансировка не рассчитана'],
      });
    }

    if (itemsWithQty.length === 0) {
      return emptyBalance({
        orderId: order.id,
        totalQty,
        shiftSeconds,
        targetDurationSec: targetDurationInput,
        totalWorkers: totalWorkersInput,
        strategy,
        warnings: [
          'Не заполнен план по размерам — балансировка не рассчитана',
        ],
      });
    }

    const globalWarnings: string[] = [];

    // Шаг 1. Считаем workSec для каждого ОБЯЗАТЕЛЬНОГО шага маршрута.
    const lines: BalanceLineDraft[] = [];
    for (const step of order.routeTemplate.steps) {
      if (step.isOptional === true) continue;
      const op = step.operation;
      if (!op) {
        globalWarnings.push('Шаг маршрута без операции — пропущен');
        continue;
      }
      const opLabel = op.name || op.code;
      const lineWarnings: string[] = [];

      const timeNormsBySize = new Map<string, number>();
      for (const t of op.timeNormsBySize) {
        timeNormsBySize.set(t.sizeId, t.seconds);
      }

      let workSec = 0;
      let totalQtyForOp = 0;
      for (const item of itemsWithQty) {
        const qty = item.qtyPlan;
        const sizeCode = item.size?.code ?? item.sizeId;
        let timeSec: number | null = null;
        if (op.timeNormMode === 'FIXED') {
          if (op.timeNormSec != null) {
            timeSec = op.timeNormSec;
          } else {
            lineWarnings.push(`Нет нормы времени операции «${opLabel}»`);
            timeSec = null;
          }
        } else {
          // BY_SIZE
          const t = timeNormsBySize.get(item.sizeId);
          if (t != null) {
            timeSec = t;
          } else {
            lineWarnings.push(
              `Нет нормы времени операции «${opLabel}» для размера ${sizeCode}`,
            );
            timeSec = null;
          }
        }
        totalQtyForOp += qty;
        if (timeSec != null) {
          workSec += qty * timeSec;
        }
      }
      lines.push({
        operationId: op.id,
        operationCode: op.code,
        operationName: op.name,
        operationCategory: prismaToSharedCategory(op.category),
        routeStepIndex: step.index,
        totalQty: totalQtyForOp,
        workSec,
        warnings: dedupe(lineWarnings),
      });
    }

    if (lines.length === 0) {
      return emptyBalance({
        orderId: order.id,
        totalQty,
        shiftSeconds,
        targetDurationSec: targetDurationInput,
        totalWorkers: totalWorkersInput,
        strategy,
        warnings: ['В маршруте нет обязательных операций'],
      });
    }

    // Шаг 2. Доступный штат по категориям. Берём active employees
    // по ролям, входящим в маппинг `CATEGORY_TO_ROLE`. Считаем штат
    // только для категорий, которые реально присутствуют в маршруте,
    // чтобы не делать лишний запрос/лишнюю работу для неиспользуемых
    // ролей. См. ТЗ §2 «использовать только active employees».
    const usedCategories = new Set<OperationCategory>();
    for (const line of lines) {
      usedCategories.add(line.operationCategory);
    }
    const availableByCategory = await this.loadAvailableByCategory(
      usedCategories,
    );

    let effectiveTargetDurationSec: number | null = null;
    let effectiveTotalWorkers: number | null = null;
    let lineThroughputPerShift: number | null = null;
    let plannedShifts: number | null = null;
    let availableWorkersTotal: number | null = null;
    let assignedWorkersTotal: number | null = null;
    let requiredWorkersTotal: number | null = null;
    let missingWorkersForTargetShift: number | null = null;
    let recommendedAdditions: OrderProductionBalanceRecommendationDto[] = [];

    const activeLines = lines.filter((l) => l.workSec > 0);

    if (strategy === 'LINE_BALANCE') {
      // ---- LINE_BALANCE: распределяем доступный штат ----
      assignByLineBalance(
        lines,
        availableByCategory,
        globalWarnings,
      );

      availableWorkersTotal = sumAvailable(availableByCategory);
      assignedWorkersTotal = lines.reduce(
        (s, l) => s + (l.assignedWorkers ?? 0),
        0,
      );

      // Рассчитываем capacity и линейный throughput.
      const capacities: number[] = [];
      for (const line of lines) {
        const cap = computeCapacity(line, shiftSeconds);
        line.capacityPerShift = cap;
        if (cap != null && cap > 0) capacities.push(cap);
      }
      lineThroughputPerShift = capacities.length > 0
        ? Math.min(...capacities)
        : null;

      plannedShifts =
        lineThroughputPerShift && lineThroughputPerShift > 0 && totalQty > 0
          ? totalQty / lineThroughputPerShift
          : null;

      // Симуляция «+1 сотрудник» — считаем рекомендацию.
      recommendedAdditions = computeRecommendations(
        lines,
        shiftSeconds,
        lineThroughputPerShift,
        availableByCategory,
      );

      if (lineThroughputPerShift == null || lineThroughputPerShift <= 0) {
        globalWarnings.push(
          'Невозможно оценить выпуск: нет доступных сотрудников или норм времени.',
        );
      }
    } else if (strategy === 'TOTAL_WORKERS') {
      effectiveTotalWorkers = totalWorkersInput!;
      assignByTotalWorkers(activeLines, effectiveTotalWorkers, globalWarnings);
      // Capacity / line throughput считаем по итоговой расстановке.
      for (const line of lines) {
        line.capacityPerShift = computeCapacity(line, shiftSeconds);
      }
      assignedWorkersTotal = lines.reduce(
        (s, l) => s + (l.suggestedWorkers ?? 0),
        0,
      );
      availableWorkersTotal = sumAvailable(availableByCategory);
    } else if (strategy === 'TARGET_DURATION') {
      effectiveTargetDurationSec = targetDurationInput!;
      assignByTargetDuration(activeLines, effectiveTargetDurationSec);
      for (const line of lines) {
        line.capacityPerShift = computeCapacity(line, shiftSeconds);
      }
      assignedWorkersTotal = lines.reduce(
        (s, l) => s + (l.suggestedWorkers ?? 0),
        0,
      );
      availableWorkersTotal = sumAvailable(availableByCategory);
    } else {
      // TARGET_SHIFT — справочный режим «уложиться в одну смену».
      effectiveTargetDurationSec = shiftSeconds;
      assignByTargetDuration(activeLines, effectiveTargetDurationSec);
      for (const line of lines) {
        line.capacityPerShift = computeCapacity(line, shiftSeconds);
      }
      requiredWorkersTotal = activeLines.reduce(
        (s, l) => s + (l.suggestedWorkers ?? 0),
        0,
      );
      availableWorkersTotal = sumAvailable(availableByCategory);
      assignedWorkersTotal = requiredWorkersTotal;
      missingWorkersForTargetShift = Math.max(
        0,
        requiredWorkersTotal - availableWorkersTotal,
      );
      if (missingWorkersForTargetShift > 0) {
        globalWarnings.push(
          `Чтобы выполнить заказ за одну смену, требуется ${requiredWorkersTotal} сотрудников. ` +
            `Доступно ${availableWorkersTotal}. Не хватает ${missingWorkersForTargetShift}.`,
        );
      }
    }

    // Все строки с workSec === 0 — workers = 0, plannedDurationSec = 0.
    for (const line of lines) {
      if (line.workSec === 0) {
        line.suggestedWorkers = 0;
        line.assignedWorkers = 0;
        line.plannedDurationSec = 0;
        line.capacityPerShift = null;
      }
    }

    // Шаг 3. Bottleneck.
    let bottleneck: BalanceLineDraft | null = null;
    let orderPlannedDurationSec: number | null = null;
    if (strategy === 'LINE_BALANCE') {
      bottleneck = pickBottleneckByCapacity(lines);
      if (
        plannedShifts != null &&
        plannedShifts > 0 &&
        Number.isFinite(plannedShifts)
      ) {
        orderPlannedDurationSec = Math.round(plannedShifts * shiftSeconds);
      }
    } else {
      orderPlannedDurationSec = computeOrderDuration(activeLines);
      bottleneck = pickBottleneckByDuration(
        activeLines,
        orderPlannedDurationSec,
      );
    }
    if (bottleneck) bottleneck.isBottleneck = true;

    // expectedOutputPerShift и lineThroughput для не-LINE-режимов.
    let expectedOutputPerShift: number | null;
    if (strategy === 'LINE_BALANCE') {
      expectedOutputPerShift = lineThroughputPerShift;
    } else {
      expectedOutputPerShift =
        orderPlannedDurationSec && orderPlannedDurationSec > 0 && totalQty > 0
          ? Math.floor((totalQty * shiftSeconds) / orderPlannedDurationSec)
          : null;
      lineThroughputPerShift = expectedOutputPerShift;
      if (
        expectedOutputPerShift != null &&
        expectedOutputPerShift > 0 &&
        totalQty > 0
      ) {
        plannedShifts = totalQty / expectedOutputPerShift;
      }
    }

    // Дисклеймер про параллельность — если расчёт реально состоялся.
    if (activeLines.length > 0) {
      globalWarnings.push(
        OrderProductionBalanceService.NOTE_PARALLEL_ESTIMATE,
      );
    }

    // Маппим внутренние `BalanceLineDraft` в DTO.
    const dtoLines: OrderProductionBalanceLineDto[] = lines.map((l) => {
      const avgSecPerUnit =
        l.totalQty > 0 ? Math.round(l.workSec / l.totalQty) : null;
      const capacity = l.capacityPerShift ?? null;
      const utilizationPercent =
        capacity != null && capacity > 0 && lineThroughputPerShift != null
          ? Math.round((100 * Math.min(lineThroughputPerShift, capacity)) /
              capacity)
          : null;
      const idlePercent =
        capacity != null && capacity > 0 && lineThroughputPerShift != null
          ? Math.max(
              0,
              Math.min(1, 1 - lineThroughputPerShift / capacity),
            )
          : null;
      const recommendedToAdd =
        strategy === 'LINE_BALANCE' &&
        recommendedAdditions.length > 0 &&
        recommendedAdditions[0].operationId === l.operationId;
      const addOneWorkerGain = l.addOneWorkerGain ?? null;
      return {
        operationId: l.operationId,
        operationCode: l.operationCode,
        operationName: l.operationName,
        operationCategory: l.operationCategory,
        routeStepIndex: l.routeStepIndex,
        totalQty: l.totalQty,
        workSec: l.workSec,
        avgSecPerUnit,
        suggestedWorkers: l.suggestedWorkers ?? 0,
        assignedWorkers: l.assignedWorkers ?? l.suggestedWorkers ?? 0,
        plannedDurationSec: l.plannedDurationSec ?? 0,
        capacityPerShift: capacity,
        throughputPerShift: capacity,
        utilizationPercent,
        idlePercent,
        isBottleneck: l.isBottleneck === true,
        recommendedToAddWorker: recommendedToAdd,
        addOneWorkerGain,
        warnings: l.warnings,
      };
    });

    this.logger.log(
      `event=order.production_balance.compute orderId=${orderId} ` +
        `strategy=${strategy} shiftSec=${shiftSeconds} ` +
        `lines=${dtoLines.length} active=${activeLines.length} ` +
        `available=${availableWorkersTotal ?? 'null'} ` +
        `assigned=${assignedWorkersTotal ?? 'null'} ` +
        `bottleneck=${bottleneck?.operationName ?? 'null'} ` +
        `lineThroughput=${lineThroughputPerShift ?? 'null'}`,
    );

    return {
      orderId: order.id,
      totalQty,
      shiftSeconds,
      targetDurationSec: effectiveTargetDurationSec,
      totalWorkers: effectiveTotalWorkers,
      strategy,
      lineThroughputPerShift,
      plannedShifts:
        plannedShifts != null && Number.isFinite(plannedShifts)
          ? Math.round(plannedShifts * 100) / 100
          : null,
      availableWorkersTotal,
      assignedWorkersTotal,
      requiredWorkersTotal,
      missingWorkersForTargetShift,
      orderPlannedDurationSec,
      expectedOutputPerShift,
      bottleneckOperationName: bottleneck?.operationName ?? null,
      recommendedAdditions,
      warnings: dedupe(globalWarnings),
      lines: dtoLines,
    };
  }

  /**
   * Загружает количество **активных** сотрудников по ролям, нужным
   * для `LINE_BALANCE`. Используем `groupBy` без переборки сотрудников
   * по ID — нам нужны только числа.
   */
  private async loadAvailableByCategory(
    categories: ReadonlySet<OperationCategory>,
  ): Promise<Map<OperationCategory, number>> {
    const result = new Map<OperationCategory, number>();
    if (categories.size === 0) return result;
    const roles = new Set<PrismaRole>();
    const categoryByRole = new Map<PrismaRole, OperationCategory>();
    for (const cat of categories) {
      const role = OrderProductionBalanceService.CATEGORY_TO_ROLE[cat];
      if (!role) continue;
      roles.add(role);
      categoryByRole.set(role, cat);
      result.set(cat, 0);
    }
    if (roles.size === 0) return result;
    const grouped = await this.prisma.employee.groupBy({
      by: ['role'],
      where: { active: true, role: { in: Array.from(roles) } },
      _count: { _all: true },
    });
    for (const g of grouped) {
      const cat = categoryByRole.get(g.role as PrismaRole);
      if (!cat) continue;
      result.set(cat, g._count._all);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Внутреннее представление строки до маппинга в DTO.
 */
interface BalanceLineDraft {
  operationId: string;
  operationCode: string;
  operationName: string;
  operationCategory: OperationCategory;
  routeStepIndex: number;
  totalQty: number;
  workSec: number;
  warnings: string[];
  suggestedWorkers?: number;
  assignedWorkers?: number;
  plannedDurationSec?: number;
  capacityPerShift?: number | null;
  isBottleneck?: boolean;
  addOneWorkerGain?: number | null;
}

function normalizeStrategy(
  input: string | undefined,
): ProductionBalanceStrategy | null {
  if (input == null) return null;
  if (
    input === 'LINE_BALANCE' ||
    input === 'TARGET_SHIFT' ||
    input === 'TOTAL_WORKERS' ||
    input === 'TARGET_DURATION'
  ) {
    return input;
  }
  return null;
}

function resolveStrategy(
  explicit: ProductionBalanceStrategy | null,
  totalWorkers: number | null,
  targetDurationSec: number | null,
): ProductionBalanceStrategy {
  // totalWorkers / targetDurationSec, если заданы явно, ВКЛЮЧАЮТ
  // соответствующий режим — это историческое поведение и тесты на
  // него рассчитывают.
  if (totalWorkers != null) return 'TOTAL_WORKERS';
  if (targetDurationSec != null) return 'TARGET_DURATION';
  if (explicit != null) return explicit;
  return 'LINE_BALANCE';
}

function assignByTargetDuration(
  lines: BalanceLineDraft[],
  targetDurationSec: number,
): void {
  for (const line of lines) {
    if (line.workSec <= 0) continue;
    const workers = Math.max(1, Math.ceil(line.workSec / targetDurationSec));
    line.suggestedWorkers = workers;
    line.assignedWorkers = workers;
    line.plannedDurationSec = Math.round(line.workSec / workers);
  }
}

function assignByTotalWorkers(
  lines: BalanceLineDraft[],
  totalWorkers: number,
  globalWarnings: string[],
): void {
  if (lines.length === 0) return;
  let remaining = totalWorkers;
  if (totalWorkers >= lines.length) {
    for (const line of lines) {
      line.suggestedWorkers = 1;
      line.assignedWorkers = 1;
      line.plannedDurationSec = Math.round(line.workSec / 1);
    }
    remaining = totalWorkers - lines.length;
  } else {
    globalWarnings.push(
      'Сотрудников меньше, чем активных операций. ' +
        'Некоторые операции останутся без параллельного поста.',
    );
    for (const line of lines) {
      line.suggestedWorkers = 0;
      line.assignedWorkers = 0;
      line.plannedDurationSec = 0;
    }
    const sortedByWork = [...lines].sort((a, b) => b.workSec - a.workSec);
    for (let i = 0; i < totalWorkers && i < sortedByWork.length; i += 1) {
      const line = sortedByWork[i];
      line.suggestedWorkers = 1;
      line.assignedWorkers = 1;
      line.plannedDurationSec = Math.round(line.workSec / 1);
    }
    remaining = 0;
  }
  while (remaining > 0) {
    const candidate = pickGreedyCandidate(lines);
    if (!candidate) break;
    candidate.suggestedWorkers = (candidate.suggestedWorkers ?? 0) + 1;
    candidate.assignedWorkers = candidate.suggestedWorkers;
    candidate.plannedDurationSec = Math.round(
      candidate.workSec / candidate.suggestedWorkers,
    );
    remaining -= 1;
  }
}

function pickGreedyCandidate(
  lines: BalanceLineDraft[],
): BalanceLineDraft | null {
  let best: BalanceLineDraft | null = null;
  for (const line of lines) {
    if (line.workSec <= 0) continue;
    if (!line.suggestedWorkers || line.suggestedWorkers === 0) continue;
    if (
      best === null ||
      (line.plannedDurationSec ?? 0) > (best.plannedDurationSec ?? 0) ||
      ((line.plannedDurationSec ?? 0) === (best.plannedDurationSec ?? 0) &&
        line.routeStepIndex < best.routeStepIndex)
    ) {
      best = line;
    }
  }
  return best;
}

/**
 * Распределение текущих сотрудников по операциям категории
 * (см. ТЗ §4 «Распределение текущих сотрудников»).
 */
function assignByLineBalance(
  lines: BalanceLineDraft[],
  available: Map<OperationCategory, number>,
  globalWarnings: string[],
): void {
  // Группируем активные строки (workSec > 0) по категории.
  const byCategory = new Map<OperationCategory, BalanceLineDraft[]>();
  for (const line of lines) {
    line.suggestedWorkers = 0;
    line.assignedWorkers = 0;
    line.plannedDurationSec = 0;
    if (line.workSec <= 0) continue;
    const arr = byCategory.get(line.operationCategory) ?? [];
    arr.push(line);
    byCategory.set(line.operationCategory, arr);
  }
  for (const [category, ops] of byCategory) {
    const availableWorkers = available.get(category) ?? 0;
    if (availableWorkers <= 0) {
      globalWarnings.push(
        `Нет активных сотрудников по категории ${categoryLabel(category)}: ` +
          `операции этой категории не получат назначений.`,
      );
      continue;
    }
    if (availableWorkers >= ops.length) {
      // По 1 на каждую активную операцию + greedy остаток.
      for (const op of ops) {
        op.assignedWorkers = 1;
        op.suggestedWorkers = 1;
        op.plannedDurationSec = Math.round(op.workSec / 1);
      }
      let remaining = availableWorkers - ops.length;
      while (remaining > 0) {
        const candidate = pickGreedyCandidate(ops);
        if (!candidate) break;
        candidate.assignedWorkers = (candidate.assignedWorkers ?? 0) + 1;
        candidate.suggestedWorkers = candidate.assignedWorkers;
        candidate.plannedDurationSec = Math.round(
          candidate.workSec / candidate.assignedWorkers,
        );
        remaining -= 1;
      }
    } else {
      // Сотрудников меньше, чем активных операций категории.
      // Раздаём людей по самым тяжёлым операциям; остальные остаются
      // с 0. См. ТЗ §4.
      globalWarnings.push(
        `Сотрудников меньше, чем активных операций в категории ` +
          `${categoryLabel(category)}. Часть операций будет выполняться ` +
          `последовательно.`,
      );
      const sorted = [...ops].sort((a, b) => b.workSec - a.workSec);
      for (let i = 0; i < availableWorkers && i < sorted.length; i += 1) {
        const op = sorted[i];
        op.assignedWorkers = 1;
        op.suggestedWorkers = 1;
        op.plannedDurationSec = Math.round(op.workSec / 1);
      }
    }
  }
}

function computeCapacity(
  line: BalanceLineDraft,
  shiftSeconds: number,
): number | null {
  const workers = line.assignedWorkers ?? line.suggestedWorkers ?? 0;
  if (workers <= 0) return null;
  if (line.totalQty <= 0 || line.workSec <= 0) return null;
  const avgSec = line.workSec / line.totalQty;
  if (avgSec <= 0) return null;
  return Math.floor((workers * shiftSeconds) / avgSec);
}

/**
 * Симулирует «+1 сотрудник» на каждую активную операцию и возвращает
 * top-1 рекомендацию (см. ТЗ §7). Top-3 вернуть тривиально, но на
 * MVP UI показывает только лучшую.
 */
function computeRecommendations(
  lines: BalanceLineDraft[],
  shiftSeconds: number,
  currentLineThroughput: number | null,
  available: Map<OperationCategory, number>,
): OrderProductionBalanceRecommendationDto[] {
  const baseline = currentLineThroughput ?? 0;
  // Базовые capacities (после распределения штата).
  const baseCaps = new Map<string, number | null>();
  for (const line of lines) {
    baseCaps.set(line.operationId, line.capacityPerShift ?? null);
  }

  let best: {
    line: BalanceLineDraft;
    newThroughput: number;
    gain: number;
  } | null = null;

  for (const line of lines) {
    if (line.workSec <= 0) continue;
    if (line.totalQty <= 0) continue;
    const workers = (line.assignedWorkers ?? 0) + 1;
    const avgSec = line.workSec / line.totalQty;
    const newCap = Math.floor((workers * shiftSeconds) / avgSec);
    if (newCap <= 0) continue;
    // Считаем новый lineThroughput с заменённой capacity для этой
    // операции; остальные capacities — из baseCaps.
    let newThroughput: number | null = null;
    for (const other of lines) {
      const cap =
        other.operationId === line.operationId
          ? newCap
          : baseCaps.get(other.operationId) ?? null;
      if (cap == null || cap <= 0) continue;
      newThroughput = newThroughput == null ? cap : Math.min(newThroughput, cap);
    }
    if (newThroughput == null) continue;
    const gain = newThroughput - baseline;
    line.addOneWorkerGain = gain;
    if (gain <= 0) continue;
    if (best === null || gain > best.gain) {
      best = { line, newThroughput, gain };
    }
  }

  if (!best) return [];
  void available; // зарезервировано: можно ограничивать рекомендацию
  // суммой максимально нанятых сотрудников по категории; на MVP не
  // ограничиваем (рекомендация плановая, не операционная).
  return [
    {
      operationId: best.line.operationId,
      operationName: best.line.operationName,
      operationCategory: best.line.operationCategory,
      addWorkers: 1,
      currentOutputPerShift: baseline > 0 ? baseline : null,
      expectedOutputPerShift: best.newThroughput,
      gainPerShift: best.gain,
      reason:
        `Добавление 1 сотрудника на операцию «${best.line.operationName}» ` +
        `увеличит выпуск линии с ${baseline} до ${best.newThroughput} шт/смену ` +
        `(+${best.gain} шт).`,
    },
  ];
}

function computeOrderDuration(lines: BalanceLineDraft[]): number | null {
  let max = 0;
  let any = false;
  for (const line of lines) {
    const d = line.plannedDurationSec ?? 0;
    if ((line.suggestedWorkers ?? 0) > 0 && d > 0) {
      any = true;
      if (d > max) max = d;
    }
  }
  return any ? max : null;
}

function pickBottleneckByDuration(
  lines: BalanceLineDraft[],
  orderPlannedDurationSec: number | null,
): BalanceLineDraft | null {
  if (!orderPlannedDurationSec) return null;
  let best: BalanceLineDraft | null = null;
  for (const line of lines) {
    if ((line.suggestedWorkers ?? 0) <= 0) continue;
    if ((line.plannedDurationSec ?? 0) !== orderPlannedDurationSec) continue;
    if (best === null || line.routeStepIndex < best.routeStepIndex) {
      best = line;
    }
  }
  return best;
}

function pickBottleneckByCapacity(
  lines: BalanceLineDraft[],
): BalanceLineDraft | null {
  let best: BalanceLineDraft | null = null;
  let bestCap = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const cap = line.capacityPerShift;
    if (cap == null || cap <= 0) continue;
    if (cap < bestCap) {
      best = line;
      bestCap = cap;
    } else if (cap === bestCap && best && line.routeStepIndex < best.routeStepIndex) {
      best = line;
    }
  }
  return best;
}

function sumAvailable(map: Map<OperationCategory, number>): number {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

function emptyBalance(args: {
  orderId: string;
  totalQty: number;
  shiftSeconds: number;
  targetDurationSec: number | null;
  totalWorkers: number | null;
  strategy: ProductionBalanceStrategy;
  warnings: string[];
}): OrderProductionBalanceDto {
  return {
    orderId: args.orderId,
    totalQty: args.totalQty,
    shiftSeconds: args.shiftSeconds,
    targetDurationSec: args.targetDurationSec,
    totalWorkers: args.totalWorkers,
    strategy: args.strategy,
    lineThroughputPerShift: null,
    plannedShifts: null,
    availableWorkersTotal: null,
    assignedWorkersTotal: null,
    requiredWorkersTotal: null,
    missingWorkersForTargetShift: null,
    orderPlannedDurationSec: null,
    expectedOutputPerShift: null,
    bottleneckOperationName: null,
    recommendedAdditions: [],
    warnings: args.warnings,
    lines: [],
  };
}

function normalizeShiftSeconds(input: number | undefined): number {
  if (input == null) return OrderProductionBalanceService.DEFAULT_SHIFT_SECONDS;
  if (!Number.isFinite(input) || input <= 0) {
    return OrderProductionBalanceService.DEFAULT_SHIFT_SECONDS;
  }
  return Math.floor(input);
}

function normalizePositiveInt(input: number | undefined): number | null {
  if (input == null) return null;
  if (!Number.isFinite(input) || input <= 0) return null;
  return Math.floor(input);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

const CATEGORY_LABEL: Record<OperationCategory, string> = {
  CUTTING: 'Раскрой',
  SEWING: 'Шитьё',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

function categoryLabel(category: OperationCategory): string {
  return CATEGORY_LABEL[category] ?? category;
}

/**
 * Сужение `Prisma.OperationCategory` enum к shared-литералу. Оба
 * значения совпадают по строковому представлению (`CUTTING`/`SEWING`/
 * `QC`/`IRONING`/`PACKING`), помогаем TS видеть это явно.
 */
function prismaToSharedCategory(
  category: PrismaOperationCategory,
): OperationCategory {
  return category as OperationCategory;
}
