import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Сервис плана операций для заказа (см.
 * `docs/operation-time-norms-recon.md §11 «Алгоритм расчёта»`,
 * recon §14 «Этап 2 — Расчёт плана на заказе»).
 *
 * Считает по live `Order.routeTemplate.steps[]` и `Order.items[]`:
 *   - суммарную **плановую стоимость** операций в рублях
 *     (`Decimal(14,2)`);
 *   - суммарное **плановое время** выполнения заказа в секундах
 *     (целое);
 *   - человекочитаемые warnings («Нет ставки», «Нет нормы времени»,
 *     «Маршрут не выбран», и т.п.).
 *
 * Что НЕ делает (см. recon §15 «Что не трогать»):
 *   - не пишет `OperationEntry` / `SalaryEntry` (это payroll, факт);
 *   - не использует `Operation.fixedRate` через
 *     `OperationsService.resolveRate` — там exception-семантика для
 *     payroll, а здесь нужно «нет ставки → warning, не блокируем заказ»;
 *   - не трогает `OrderRouteStep` (snapshot маршрута появляется только
 *     в `OrdersService.start()`; план считается до этого);
 *   - не трогает `OrderCostEstimate` (LABOR-строка появится на этапе 3);
 *   - не трогает `WorkshopNeed` / `PurchaseOrder` / `PurchaseReceipt`.
 *
 * Контракт `calculateForOrder`:
 *   - **никогда не бросает** на «нет данных» — отдаёт `null`-totals и
 *     warnings; заказ всегда должен сохраняться, плановая оценка не
 *     блокирует CRUD;
 *   - SALARY_ONLY с заданной плановой ставкой
 *     (`Operation.salaryPlanRubPerShift`) ⇒
 *     `cost = timeSec × (salaryPlanRubPerShift /
 *                        salaryPlanShiftSeconds) × qty`,
 *     время — считается отдельно (см. ТЗ «Плановая стоимость
 *     окладных операций»);
 *   - SALARY_ONLY без плановой ставки ⇒ деньги по операции = 0,
 *     время считается, в `warnings` появляется
 *     «Не задана плановая окладная ставка операции «…»»;
 *   - `BY_SIZE` без матчинга по размеру ⇒ warning, эта пара
 *     `(операция × размер)` пропускается по соответствующей оси;
 *   - `step.isOptional === true` ⇒ шаг **полностью** пропускается
 *     (на MVP — ровно так, см. recon §11 «Контракты»).
 *
 * Стиль/паттерны:
 *   - вызывается ВНУТРИ транзакции `OrdersService.{create|update|
 *     startCalculation}` через переданный `tx`. Это гарантирует, что
 *     snapshot и сам заказ либо записаны вместе, либо не записаны вовсе;
 *   - округление `Decimal(14,2)` через `toDecimalPlaces(2, ROUND_HALF_UP)`
 *     — то же правило, что и у `OrderCostEstimateLine.lineTotalRub`.
 */
@Injectable()
export class OrderOperationPlanService {
  private readonly logger = new Logger(OrderOperationPlanService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Считает плановую стоимость и время операций по заказу.
   *
   * Возвращает три значения:
   *   - `totalCostRub` — `Prisma.Decimal` или `null`
   *     (`null` ⇔ «план не считался» — нет маршрута / нет items /
   *     все qtyPlan ≤ 0);
   *   - `totalTimeSec` — целое число секунд или `null` (по той же
   *     логике, что и `totalCostRub`);
   *   - `warnings` — массив человекочитаемых сообщений (может быть
   *     пустым).
   *
   * Параметр `tx` обязателен — расчёт всегда читает данные в той же
   * транзакции, что и пишет snapshot, чтобы исключить race с
   * параллельным `OrdersService.update`.
   */
  async calculateForOrder(
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    totalCostRub: Prisma.Decimal | null;
    totalTimeSec: number | null;
    warnings: string[];
  }> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        routeTemplateId: true,
        items: {
          select: {
            sizeId: true,
            qtyPlan: true,
            size: { select: { code: true } },
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
                rateOverride: true,
                operation: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    pricingMode: true,
                    fixedRate: true,
                    timeNormMode: true,
                    timeNormSec: true,
                    // Плановая окладная ставка (ТЗ «Плановая стоимость
                    // окладных операций»). Используется только для
                    // pricingMode = SALARY_ONLY: cost = timeSec ×
                    // (salaryPlanRubPerShift / salaryPlanShiftSeconds) ×
                    // qty. Payroll этих полей не читает.
                    salaryPlanRubPerShift: true,
                    salaryPlanShiftSeconds: true,
                    ratesBySize: {
                      select: { sizeId: true, rate: true },
                    },
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
      // Заказа не существует — расчёт бессмысленен; OrdersService
      // должен был обнаружить это раньше, но защищаемся: warnings
      // отдадим «план не рассчитан».
      return {
        totalCostRub: null,
        totalTimeSec: null,
        warnings: [
          'Заказ не найден — план операций не рассчитан',
        ],
      };
    }

    if (!order.routeTemplateId || !order.routeTemplate) {
      return {
        totalCostRub: null,
        totalTimeSec: null,
        warnings: ['Маршрут не выбран — план операций не рассчитан'],
      };
    }

    const itemsWithQty = order.items.filter((it) => it.qtyPlan > 0);
    if (itemsWithQty.length === 0) {
      return {
        totalCostRub: null,
        totalTimeSec: null,
        warnings: [
          'Не заполнен план по размерам — план операций не рассчитан',
        ],
      };
    }

    // Per-order переопределения расценок/норм (snapshot маршрута заказа).
    // Источник истины для заказа — снимок: правки внутри заказа (блок
    // «Операции» → «Редактировать маршрут заказа») попадают в план
    // себестоимости/времени, НЕ меняя справочник операции и шаблон
    // маршрута. Ключ — operationId (операция в маршруте не повторяется).
    const snapshotSteps = await tx.orderRouteStep.findMany({
      where: { orderId },
      select: {
        operationId: true,
        rateOverride: true,
        timeNormSecOverride: true,
        sizeOverrides: { select: { sizeId: true, rate: true, seconds: true } },
      },
    });
    const overridesByOp = new Map(
      snapshotSteps.map((s) => {
        const rateBySize = new Map<string, Prisma.Decimal>();
        const secondsBySize = new Map<string, number>();
        for (const o of s.sizeOverrides) {
          if (o.rate != null) rateBySize.set(o.sizeId, o.rate);
          if (o.seconds != null) secondsBySize.set(o.sizeId, o.seconds);
        }
        return [
          s.operationId,
          {
            rateOverride: s.rateOverride,
            timeNormSecOverride: s.timeNormSecOverride,
            rateBySize,
            secondsBySize,
          },
        ] as const;
      }),
    );

    const warningsSet = new Set<string>();
    let totalCost = new Prisma.Decimal(0);
    let totalTimeSec = 0;

    for (const step of order.routeTemplate.steps) {
      // На MVP опциональные шаги не входят в план (см. recon §11
      // «isOptional»). Если в будущем потребуется флаг
      // `includeOptional` — добавим параметр, не меняя контракт.
      if (step.isOptional === true) continue;

      const op = step.operation;
      if (!op) {
        warningsSet.add('Шаг маршрута без операции — пропущен');
        continue;
      }
      const opLabel = op.name || op.code;
      // Снимок per-order переопределений этой операции (если есть).
      const ov = overridesByOp.get(op.id);

      const ratesBySize = new Map<string, Prisma.Decimal>();
      for (const r of op.ratesBySize) ratesBySize.set(r.sizeId, r.rate);
      const timeNormsBySize = new Map<string, number>();
      for (const t of op.timeNormsBySize) {
        timeNormsBySize.set(t.sizeId, t.seconds);
      }

      // Плановая окладная ставка операции (см. ТЗ «Плановая стоимость
      // окладных операций»). Считаем «стоимость 1 секунды» один раз на
      // операцию (а не на каждое (item × step)) — fallback на 28800
      // (8 часов), если длительность смены не задана / 0. Читается
      // только для pricingMode = SALARY_ONLY; для FIXED/BY_SIZE этот
      // помощник не используется.
      const salaryCostPerSec: Prisma.Decimal | null =
        op.salaryPlanRubPerShift != null
          ? op.salaryPlanRubPerShift.div(
              op.salaryPlanShiftSeconds && op.salaryPlanShiftSeconds > 0
                ? op.salaryPlanShiftSeconds
                : 28800,
            )
          : null;

      for (const item of itemsWithQty) {
        const qty = item.qtyPlan;
        const sizeCode = item.size?.code ?? item.sizeId;

        // ----- Время (считаем первым; SALARY_ONLY-деньги зависят от него) -----
        let timeSec: number | null = null;
        if (op.timeNormMode === 'FIXED') {
          // Норма времени внутри заказа вытесняет дефолт операции.
          const fixedTime = ov?.timeNormSecOverride ?? op.timeNormSec;
          if (fixedTime != null) {
            timeSec = fixedTime;
          } else {
            warningsSet.add(
              `Нет нормы времени операции «${opLabel}»`,
            );
            timeSec = null;
          }
        } else {
          // BY_SIZE: поразмерное переопределение заказа, затем дефолт.
          const t = ov?.secondsBySize.get(item.sizeId) ??
            timeNormsBySize.get(item.sizeId);
          if (t != null) {
            timeSec = t;
          } else {
            warningsSet.add(
              `Нет нормы времени операции «${opLabel}» для размера ${sizeCode}`,
            );
            timeSec = null;
          }
        }

        if (timeSec != null) {
          totalTimeSec += timeSec * qty;
        }

        // ----- Деньги -----
        // Покрываем все три режима из enum `PricingMode`
        // (`'FIXED' | 'BY_SIZE' | 'SALARY_ONLY'`):
        //   - FIXED       → одна ставка `Operation.fixedRate` на любой размер;
        //   - BY_SIZE     → размерная матрица `OperationRateBySize`;
        //   - SALARY_ONLY → плановая стоимость по нормам времени:
        //     cost = timeSec × (salaryPlanRubPerShift /
        //                       salaryPlanShiftSeconds) × qty.
        //     Если плановая ставка не задана — cost = 0 + warning,
        //     заказ не блокируется (см. ТЗ §6).
        let rate: Prisma.Decimal | null = null;
        if (op.pricingMode === 'SALARY_ONLY') {
          if (salaryCostPerSec === null) {
            // Плановая ставка не задана — добавляем warning один раз
            // на операцию (Set схлопнет повторы) и не считаем деньги.
            warningsSet.add(
              `Не задана плановая окладная ставка операции «${opLabel}» — ` +
                `план себестоимости по ней посчитан как 0`,
            );
            rate = null;
          } else if (timeSec != null) {
            // cost = timeSec * costPerSecond * qty, считаем через
            // Prisma.Decimal, чтобы не терять точность.
            totalCost = totalCost.add(salaryCostPerSec.mul(timeSec).mul(qty));
            rate = null; // ниже не складываем повторно
          } else {
            // Без нормы времени для этой пары (item × op) деньги
            // считать нечем — warning о норме уже выдан выше.
            rate = null;
          }
        } else if (op.pricingMode === 'FIXED') {
          // Переопределение расценки внутри заказа (snapshot маршрута,
          // `OrderRouteStep.rateOverride`) вытесняет дефолт операции —
          // план себестоимости должен совпадать с фактическим
          // начислением (`resolveRate`). Если у операции нет строки
          // снимка (дивергенция), берём расценку шаблона.
          const effectiveRate =
            (ov ? ov.rateOverride : step.rateOverride) ?? op.fixedRate;
          if (effectiveRate != null) {
            rate = effectiveRate;
          } else {
            warningsSet.add(
              `Нет ставки операции «${opLabel}» — план по этой операции не учтён`,
            );
            rate = null;
          }
        } else if (op.pricingMode === 'BY_SIZE') {
          // Поразмерное переопределение заказа, затем дефолт операции.
          const r = ov?.rateBySize.get(item.sizeId) ?? ratesBySize.get(item.sizeId);
          if (r != null) {
            rate = r;
          } else {
            warningsSet.add(
              `Нет ставки операции «${opLabel}» для размера ${sizeCode}`,
            );
            rate = null;
          }
        }

        if (rate != null) {
          totalCost = totalCost.add(rate.mul(qty));
        }
      }
    }

    // Округление стоимости до Decimal(14,2). Используем тот же режим
    // округления, что и `OrderCostEstimateLine.lineTotalRub` —
    // ROUND_HALF_UP (Prisma.Decimal.ROUND_HALF_UP === 0).
    const totalCostRounded = totalCost.toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );

    return {
      totalCostRub: totalCostRounded,
      totalTimeSec,
      warnings: Array.from(warningsSet),
    };
  }

  /**
   * Считает план и пишет snapshot в `Order` в той же транзакции.
   *
   * Используется в `OrdersService.create` (после фиксации заказа),
   * `OrdersService.update` (только в DRAFT, при изменении состава /
   * маршрута / лекала) и `OrdersService.startCalculation` (финальный
   * snapshot перед расчётом себестоимости).
   *
   * После `OrdersService.start()` НЕ ВЫЗЫВАЕТСЯ — план фиксируется
   * как «как заказ ушёл в работу» и не пересчитывается даже при
   * правке справочников `Operation` / `RouteTemplate`.
   *
   * Если расчёт получился null/null (нет маршрута / нет items / etc),
   * мы всё равно обновляем snapshot:
   *   - `operationCostPlanRub = null`,
   *   - `operationTimePlanSec = null`,
   *   - `operationPlanCalculatedAt = new Date()` (фиксируем момент
   *     попытки),
   *   - `operationPlanWarnings = warnings` (минимум 1 строка с причиной).
   *
   * Это даёт UI карточки заказа понятное состояние «план не считался,
   * вот почему» вместо «загадочно пусто».
   */
  async recalculateAndWrite(
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    totalCostRub: Prisma.Decimal | null;
    totalTimeSec: number | null;
    warnings: string[];
  }> {
    const result = await this.calculateForOrder(orderId, tx);
    await tx.order.update({
      where: { id: orderId },
      data: {
        operationCostPlanRub: result.totalCostRub,
        operationTimePlanSec: result.totalTimeSec,
        operationPlanCalculatedAt: new Date(),
        operationPlanWarnings:
          result.warnings.length > 0
            ? (result.warnings as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
    this.logger.log(
      `event=order.operation_plan.recalculate orderId=${orderId} ` +
        `costRub=${result.totalCostRub?.toString() ?? 'null'} ` +
        `timeSec=${result.totalTimeSec ?? 'null'} ` +
        `warnings=${result.warnings.length}`,
    );
    return result;
  }

  /**
   * Этап 2 «План операций на заказе» — stale-detection (см. ТЗ
   * «Показывать, что план операций устарел»).
   *
   * План считается **устаревшим** (`isStale = true`), если хотя бы
   * один из источников плана был изменён ПОСЛЕ последнего snapshot-а:
   *   - `RouteTemplate.updatedAt` (изменили шаблон / переименовали);
   *   - `Operation.updatedAt` для операций маршрута (правка ставки /
   *     `pricingMode` / `timeNormMode` / `timeNormSec` / `fixedRate` /
   *     `salaryPlanRubPerShift` / `salaryPlanShiftSeconds`);
   *   - `OperationRateBySize.updatedAt` для операций маршрута
   *     (поразмерная ставка добавлена/изменена);
   *   - `OperationTimeNormBySize.updatedAt` для операций маршрута
   *     (поразмерная норма времени добавлена/изменена).
   *
   * Изменения шагов маршрута (`RouteTemplateStep`) учитываются через
   * `RouteTemplate.updatedAt` — `RoutesService.update` явно
   * touch-ит сам шаблон, даже если PATCH передал ровно `{steps}`
   * без `name/code/isActive` (см. явный `data.updatedAt = new Date()`
   * там же). Это сознательная упрощённая модель MVP: не нужно
   * отдельно тащить `RouteTemplateStep.updatedAt` (его и нет в
   * текущей схеме). Без этого touch-а stale-detection не сработал
   * бы на «голом» PATCH `{steps: [...]}` — см. integration-тест
   * `PATCH /api/routes/:id { steps } touch-ит RouteTemplate.updatedAt`.
   *
   * Контракт «нет данных»:
   *   - заказа нет → `isStale = false`, reason = «Заказ не найден»
   *     (защита, реальный flow до этого не доходит);
   *   - заказа без `routeTemplateId` → `isStale = false`, reason =
   *     «Маршрут не выбран» — план в принципе нечем считать;
   *   - заказа без `operationPlanCalculatedAt`, но с `routeTemplateId`
   *     и items → `isStale = true`, reason = «План операций ещё не
   *     рассчитан» (UI рисует кнопку «Рассчитать»);
   *   - снимок есть, ни один источник не свежее → `isStale = false`,
   *     reason = `null`.
   *
   * Это **read-only** helper: ни в БД, ни на заказ ничего не пишет.
   * Используется маппером `OrdersService.toDetailDto`. В список
   * заказов сознательно НЕ зовётся (см. ТЗ §2 «не делать дорогое
   * вычисление в списке заказов, если это тяжело»).
   */
  async getFreshnessForOrder(orderId: string): Promise<{
    isStale: boolean;
    sourceUpdatedAt: Date | null;
    reason: string | null;
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        routeTemplateId: true,
        operationPlanCalculatedAt: true,
        items: { select: { id: true, qtyPlan: true } },
        routeTemplate: {
          select: {
            id: true,
            updatedAt: true,
            steps: { select: { operationId: true } },
          },
        },
      },
    });
    if (!order) {
      return {
        isStale: false,
        sourceUpdatedAt: null,
        reason: 'Заказ не найден',
      };
    }

    if (!order.routeTemplateId || !order.routeTemplate) {
      return {
        isStale: false,
        sourceUpdatedAt: null,
        reason: 'Маршрут не выбран',
      };
    }

    const hasItemsWithQty = order.items.some((i) => i.qtyPlan > 0);
    if (!hasItemsWithQty) {
      // Без items план не считается, но это не «устарел» — это «нечего
      // считать». UI это и так увидит по `operationPlanWarnings`, нам
      // лишний badge не нужен.
      return {
        isStale: false,
        sourceUpdatedAt: null,
        reason: null,
      };
    }

    const operationIds = order.routeTemplate.steps.map((s) => s.operationId);

    // Если snapshot ещё ни разу не считался, но source-данные есть —
    // считаем стейл с понятной причиной. UI нарисует кнопку
    // «Рассчитать план операций».
    if (!order.operationPlanCalculatedAt) {
      // Берём max(updatedAt) источников, чтобы UI показал правдивую
      // дату последнего изменения (или `null`, если источников ещё
      // нет). Routes-шаблон updatedAt всегда есть.
      const sourceUpdatedAt = await this.collectMaxSourceUpdatedAt(
        order.routeTemplate.updatedAt,
        operationIds,
      );
      return {
        isStale: true,
        sourceUpdatedAt,
        reason: 'План операций ещё не рассчитан',
      };
    }

    const calculatedAt = order.operationPlanCalculatedAt;
    const sourceUpdatedAt = await this.collectMaxSourceUpdatedAt(
      order.routeTemplate.updatedAt,
      operationIds,
    );

    if (sourceUpdatedAt && sourceUpdatedAt.getTime() > calculatedAt.getTime()) {
      return {
        isStale: true,
        sourceUpdatedAt,
        reason:
          'После расчёта менялись операции, ставки или нормы времени',
      };
    }

    return {
      isStale: false,
      sourceUpdatedAt,
      reason: null,
    };
  }

  /**
   * Считает max(updatedAt) по всем источникам плана операций для
   * заданного `routeTemplate.updatedAt` + `operationIds`. Pure-helper
   * для `getFreshnessForOrder`; вынесен, чтобы и заказ-без-snapshot,
   * и заказ-со-snapshot читали одну и ту же формулу.
   *
   * `operationIds` может быть пустым (шаблон без шагов) — тогда мы
   * учитываем только `RouteTemplate.updatedAt`. Никаких throws на
   * пустой массив; Prisma `where: { in: [] }` корректно вернёт пусто.
   */
  private async collectMaxSourceUpdatedAt(
    routeTemplateUpdatedAt: Date,
    operationIds: string[],
  ): Promise<Date | null> {
    let max: Date = routeTemplateUpdatedAt;

    if (operationIds.length > 0) {
      const [opAgg, rateAgg, normAgg] = await this.prisma.$transaction([
        this.prisma.operation.aggregate({
          where: { id: { in: operationIds } },
          _max: { updatedAt: true },
        }),
        this.prisma.operationRateBySize.aggregate({
          where: { operationId: { in: operationIds } },
          _max: { updatedAt: true },
        }),
        this.prisma.operationTimeNormBySize.aggregate({
          where: { operationId: { in: operationIds } },
          _max: { updatedAt: true },
        }),
      ]);
      const candidates: (Date | null | undefined)[] = [
        opAgg._max.updatedAt,
        rateAgg._max.updatedAt,
        normAgg._max.updatedAt,
      ];
      for (const c of candidates) {
        if (c && c.getTime() > max.getTime()) max = c;
      }
    }

    return max;
  }
}
