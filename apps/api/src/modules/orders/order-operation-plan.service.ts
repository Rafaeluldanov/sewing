import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Операция в форме, достаточной для расчёта плана. Один и тот же `select`
 * используется и для шага шаблона, и для шага снимка `OrderRouteStep`.
 */
interface PlanOperation {
  id: string;
  code: string;
  name: string;
  pricingMode: string;
  fixedRate: Prisma.Decimal | null;
  timeNormMode: string;
  timeNormSec: number | null;
  salaryPlanRubPerShift: Prisma.Decimal | null;
  salaryPlanShiftSeconds: number | null;
  ratesBySize: { sizeId: string; rate: Prisma.Decimal }[];
  timeNormsBySize: { sizeId: string; seconds: number }[];
}

/**
 * Нормализованный шаг плана: операция + ЭФФЕКТИВНЫЕ per-order
 * переопределения (расценка/норма/режим/поразмерные + сторонние
 * услуги: метка, цена размещения и отданный объём). Источник структуры
 * — либо шаги шаблона (`calculateForOrder`), либо снимок `OrderRouteStep`
 * (`calculateFromSnapshot`); дальше оба идут в общий `computeTotals`.
 */
interface NormalizedPlanStep {
  isOptional: boolean;
  operation: PlanOperation | null;
  rateOverride: Prisma.Decimal | null;
  timeNormSecOverride: number | null;
  pricingModeOverride: string | null;
  rateBySize: Map<string, Prisma.Decimal>;
  secondsBySize: Map<string, number>;
  /**
   * СТОРОННИЕ УСЛУГИ (решение владельца 10.09.2026): шаг целиком или
   * частично выполняет подрядчик (`OrderRouteStep.outsourced`). Метка
   * живёт только на снимке заказа — в шаблоне маршрута её нет: подряд
   * решается по конкретному тиражу, а не по технологии.
   */
  outsourced: boolean;
  /**
   * Цена стороннего размещения за ОДНО изделие (₽). `null` — цена не
   * задана: размещение считается как 0 и поднимается warning (молчаливый
   * ноль читался бы как «подряд бесплатный»).
   */
  outsourcePriceRub: Prisma.Decimal | null;
  /**
   * Сколько ШТУК каждого размера отдано подрядчику
   * (`OrderRouteStepSizeOverride.outsourcedQty`, только заданные
   * значения). Пустая карта при `outsourced = true` ⇒ на стороне ВЕСЬ
   * тираж операции; иначе на стороне ровно эти штуки, остальное цех
   * считает своей расценкой.
   */
  outsourcedQtyBySize: Map<string, number>;
}

/** Строка плана по размеру. */
interface PlanItem {
  sizeId: string;
  qtyPlan: number;
  size: { code: string } | null;
}

/** Общий `select` операции для расчёта плана. */
const PLAN_OPERATION_SELECT = {
  id: true,
  code: true,
  name: true,
  pricingMode: true,
  fixedRate: true,
  timeNormMode: true,
  timeNormSec: true,
  salaryPlanRubPerShift: true,
  salaryPlanShiftSeconds: true,
  ratesBySize: { select: { sizeId: true, rate: true } },
  timeNormsBySize: { select: { sizeId: true, seconds: true } },
} satisfies Prisma.OperationSelect;

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
 * Сторонние услуги (решение владельца 10.09.2026 «если указали, что это
 * будет делаться на стороне, тогда мы не берём стоимость операций, а
 * считаем стоимость стороннего размещения»):
 *   - шаг снимка с `outsourced = true` делит плановый тираж на две
 *     части — отданную подрядчику (`OrderRouteStepSizeOverride.
 *     outsourcedQty` по размерам; ни одного заданного размера ⇒ на
 *     стороне весь тираж) и оставшуюся у цеха;
 *   - по отданной части своя расценка (любой из трёх `PricingMode`) НЕ
 *     считается — вместо неё в план идёт `outsourcePriceRub × штуки`;
 *   - `operationCostPlanRub` остаётся ПОЛНЫМ планом операций (своё +
 *     размещение), а `outsourceCostRub` — расшифровка «в том числе»,
 *     которая ложится в `Order.operationOutsourceCostPlanRub`. Иначе
 *     каждый потребитель (карточка заказа, «Сводно», ERP) складывал бы
 *     два числа по-своему;
 *   - warnings: цена размещения не задана ⇒ «Не задана цена стороннего
 *     размещения по операции «…»» (в план идёт 0). И наоборот: если
 *     своей части не осталось ни в одной строке плана, warnings про
 *     отсутствующую ставку операции подавляются — эта ставка плану уже
 *     не нужна, а `operationPlanWarnings` читают и цех, и ERP;
 *   - ⛔ **время и payroll метка не трогает**: `totalTimeSec` считается
 *     по ПОЛНОМУ `qtyPlan`, шаг из маршрута не исчезает, паспорта,
 *     доска, гейты ОТК/упаковки и сдельное начисление
 *     (`OperationsService.resolveRate`) её не читают — часть тиража по
 *     той же операции цех может делать сам, и «пропуск шага» сломал бы
 *     движение паспортов («в план-факте достаточно метки»).
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
   *   - `outsourceCostRub` — сколько из `totalCostRub` приходится на
   *     стороннее размещение (`null` там же, где `null` стоимость;
   *     `0` — подряда в заказе нет);
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
    outsourceCostRub: Prisma.Decimal | null;
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
        outsourceCostRub: null,
        warnings: [
          'Заказ не найден — план операций не рассчитан',
        ],
      };
    }

    if (!order.routeTemplateId || !order.routeTemplate) {
      return {
        totalCostRub: null,
        totalTimeSec: null,
        outsourceCostRub: null,
        warnings: ['Маршрут не выбран — план операций не рассчитан'],
      };
    }

    const itemsWithQty = order.items.filter((it) => it.qtyPlan > 0);
    if (itemsWithQty.length === 0) {
      return {
        totalCostRub: null,
        totalTimeSec: null,
        outsourceCostRub: null,
        warnings: [
          'Не заполнен план по размерам — план операций не рассчитан',
        ],
      };
    }

    // Per-order переопределения расценок/норм (snapshot маршрута заказа).
    // Источник истины для заказа — снимок: правки внутри заказа (блок
    // «Операции» → «Редактировать маршрут заказа») попадают в план
    // себестоимости/времени, НЕ меняя справочник операции и шаблон
    // маршрута.
    //
    // Ключ — operationId, и это осознанное упрощение ЭТОЙ ветки: структуру
    // она берёт из ШАБЛОНА, где операция стоит один раз. Правленый маршрут
    // (в т.ч. с повторами операции — чередующиеся ОТК/ВТО) считается
    // соседним `calculateFromSnapshot`, который идёт по строкам снимка и
    // учитывает каждое вхождение отдельно.
    const snapshotSteps = await tx.orderRouteStep.findMany({
      where: { orderId },
      select: {
        operationId: true,
        rateOverride: true,
        timeNormSecOverride: true,
        pricingModeOverride: true,
        // Сторонние услуги: метка, цена размещения и поразмерный объём,
        // отданный подрядчику. Живут только в снимке заказа — шаблон о
        // подряде не знает (подряд решается по тиражу, не по технологии).
        outsourced: true,
        outsourcePriceRub: true,
        sizeOverrides: {
          select: {
            sizeId: true,
            rate: true,
            seconds: true,
            outsourcedQty: true,
          },
        },
      },
    });
    const overridesByOp = new Map(
      snapshotSteps.map((s) => {
        const rateBySize = new Map<string, Prisma.Decimal>();
        const secondsBySize = new Map<string, number>();
        const outsourcedQtyBySize = new Map<string, number>();
        for (const o of s.sizeOverrides) {
          if (o.rate != null) rateBySize.set(o.sizeId, o.rate);
          if (o.seconds != null) secondsBySize.set(o.sizeId, o.seconds);
          // Ноль тоже кладём: «по этому размеру на сторону ничего не
          // отдаём» — это заданный объём, а не «размеры не расписаны»
          // (пустая карта означала бы «на стороне весь тираж»).
          if (o.outsourcedQty != null) {
            outsourcedQtyBySize.set(o.sizeId, o.outsourcedQty);
          }
        }
        return [
          s.operationId,
          {
            rateOverride: s.rateOverride,
            timeNormSecOverride: s.timeNormSecOverride,
            pricingModeOverride: s.pricingModeOverride,
            outsourced: s.outsourced === true,
            outsourcePriceRub: s.outsourcePriceRub,
            rateBySize,
            secondsBySize,
            outsourcedQtyBySize,
          },
        ] as const;
      }),
    );

    // Структура — из шаблона (как раньше), эффективные per-order правки —
    // из снимка по operationId. Нормализуем и считаем общим `computeTotals`.
    const normalizedSteps: NormalizedPlanStep[] =
      order.routeTemplate.steps.map((step) => {
        const ov = overridesByOp.get(step.operationId);
        return {
          isOptional: step.isOptional === true,
          operation: step.operation,
          // Если у операции есть строка снимка — берём её rateOverride
          // (может быть null → упадёт на op.fixedRate ниже); иначе —
          // расценку шаблона (дивергенция).
          rateOverride: ov ? ov.rateOverride : step.rateOverride,
          timeNormSecOverride: ov?.timeNormSecOverride ?? null,
          pricingModeOverride: ov?.pricingModeOverride ?? null,
          // Подряд — свойство ЗАКАЗА: без строки снимка (шаблонный шаг,
          // до материализации маршрута) операция считается своей.
          outsourced: ov?.outsourced ?? false,
          outsourcePriceRub: ov?.outsourcePriceRub ?? null,
          rateBySize: ov?.rateBySize ?? new Map<string, Prisma.Decimal>(),
          secondsBySize: ov?.secondsBySize ?? new Map<string, number>(),
          outsourcedQtyBySize:
            ov?.outsourcedQtyBySize ?? new Map<string, number>(),
        };
      });

    return this.computeTotals(normalizedSteps, itemsWithQty);
  }

  /**
   * Общий расчёт плановой стоимости/времени по нормализованным шагам.
   * Вызывается из `calculateForOrder` (структура из шаблона) и
   * `calculateFromSnapshot` (структура из снимка `OrderRouteStep`) — вся
   * денежно-временна́я логика по трём режимам `PricingMode` живёт здесь в
   * одном месте. Здесь же живёт и деление тиража между цехом и
   * подрядчиком (`outsourced`): правило одно на оба входа, иначе план
   * заказа менялся бы от того, правили маршрут холстом или нет.
   */
  private computeTotals(
    steps: NormalizedPlanStep[],
    itemsWithQty: PlanItem[],
  ): {
    totalCostRub: Prisma.Decimal | null;
    totalTimeSec: number | null;
    outsourceCostRub: Prisma.Decimal | null;
    warnings: string[];
  } {
    const warningsSet = new Set<string>();
    let totalCost = new Prisma.Decimal(0);
    // «В том числе размещение» — отдельный аккумулятор: сумма уже входит
    // в `totalCost`, но потребителям нужна расшифровка (см. шапку).
    let totalOutsource = new Prisma.Decimal(0);
    let totalTimeSec = 0;

    for (const step of steps) {
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

      // ----- Сторонние услуги: делим тираж шага на «своё» и «подряд» -----
      // Раскладку считаем ДО цикла по items: во-первых, размер может
      // встретиться в нескольких строках плана (разные изделия одного
      // заказа) и остаток по нему надо расходовать жадно, по порядку
      // строк; во-вторых, warnings про отсутствующую расценку надо
      // подавить, только если своей части не осталось НИ В ОДНОЙ строке
      // — внутри цикла это ещё неизвестно.
      const outQtyByItem: number[] = new Array(itemsWithQty.length).fill(0);
      if (step.outsourced) {
        // outMap: sizeId → остаток к раздаче. Пустая карта ⇒ размеры не
        // расписаны ⇒ на стороне ВЕСЬ объём операции (решение владельца:
        // метка без объёма означает «делаем на стороне целиком»).
        const outMap = new Map<string, number>();
        for (const [sizeId, qtyOut] of step.outsourcedQtyBySize) {
          outMap.set(sizeId, qtyOut > 0 ? qtyOut : 0);
        }
        const wholeStepOutsourced = outMap.size === 0;
        for (const [i, item] of itemsWithQty.entries()) {
          if (wholeStepOutsourced) {
            outQtyByItem[i] = item.qtyPlan;
            continue;
          }
          const left = outMap.get(item.sizeId);
          if (left == null || left <= 0) continue;
          // Не больше, чем есть в строке: остаток перетечёт в следующую
          // строку того же размера, а лишнее (объём больше тиража)
          // просто сгорит — платить за несуществующие изделия нельзя.
          const take = Math.min(left, item.qtyPlan);
          outQtyByItem[i] = take;
          outMap.set(item.sizeId, left - take);
        }
        // Объём расписан, но ни одна штука не легла на план: размеры в
        // подряде — не те, что в заказе (типично после смены размерного
        // ряда — строки переопределений остаются от прежнего плана).
        // Молча это выглядит как «метка стоит, а денег подрядчика нет»,
        // и план тихо возвращается к полной своей стоимости.
        const anyRequested = [...step.outsourcedQtyBySize.values()].some(
          (v) => v > 0,
        );
        const anyPlaced = outQtyByItem.some((v) => v > 0);
        if (!wholeStepOutsourced && anyRequested && !anyPlaced) {
          warningsSet.add(
            `Объём стороннего размещения по операции «${opLabel}» расписан по ` +
              `размерам, которых нет в плане заказа — на сторону ничего не отдано`,
          );
        }
      }
      // Своей части не осталось нигде ⇒ ставка операции нам не нужна, и
      // warnings про неё — шум: `operationPlanWarnings` читают и цех, и
      // ERP. Цена размещения при этом по-прежнему обязательна.
      const fullyOutsourced =
        step.outsourced &&
        itemsWithQty.every((item, i) => outQtyByItem[i] >= item.qtyPlan);

      for (const [itemIndex, item] of itemsWithQty.entries()) {
        const qty = item.qtyPlan;
        const sizeCode = item.size?.code ?? item.sizeId;
        // Отдано подрядчику / осталось цеху по ЭТОЙ строке плана.
        // Деньги считаются по `ownQty`, время — по полному `qty`.
        const outQty = outQtyByItem[itemIndex] ?? 0;
        const ownQty = qty - outQty;

        // ----- Время (считаем первым; SALARY_ONLY-деньги зависят от него) -----
        let timeSec: number | null = null;
        if (op.timeNormMode === 'FIXED') {
          // Норма времени внутри заказа вытесняет дефолт операции.
          const fixedTime = step.timeNormSecOverride ?? op.timeNormSec;
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
          const t = step.secondsBySize.get(item.sizeId) ??
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
        //                       salaryPlanShiftSeconds) × ownQty.
        //     Если плановая ставка не задана — cost = 0 + warning,
        //     заказ не блокируется (см. ТЗ §6).
        // Эффективный способ оплаты: переопределение заказа (оклад ⇄
        // сделка, `pricingModeOverride`) вытесняет дефолт операции — план
        // должен совпадать с фактическим начислением (`resolveRate`).
        // Во всех трёх режимах умножаем на `ownQty`: за отданные
        // подрядчику штуки цех своей ставки не платит.
        const effMode = step.pricingModeOverride ?? op.pricingMode;
        let rate: Prisma.Decimal | null = null;
        if (effMode === 'SALARY_ONLY') {
          if (salaryCostPerSec === null) {
            // Плановая ставка не задана — добавляем warning один раз
            // на операцию (Set схлопнет повторы) и не считаем деньги.
            if (!fullyOutsourced) {
              warningsSet.add(
                `Не задана плановая окладная ставка операции «${opLabel}» — ` +
                  `план себестоимости по ней посчитан как 0`,
              );
            }
            rate = null;
          } else if (timeSec != null) {
            // cost = timeSec * costPerSecond * ownQty, считаем через
            // Prisma.Decimal, чтобы не терять точность.
            totalCost = totalCost.add(
              salaryCostPerSec.mul(timeSec).mul(ownQty),
            );
            rate = null; // ниже не складываем повторно
          } else {
            // Без нормы времени для этой пары (item × op) деньги
            // считать нечем — warning о норме уже выдан выше.
            rate = null;
          }
        } else if (effMode === 'FIXED') {
          // Переопределение расценки внутри заказа (snapshot маршрута,
          // `OrderRouteStep.rateOverride`) вытесняет дефолт операции —
          // план себестоимости должен совпадать с фактическим
          // начислением (`resolveRate`).
          const effectiveRate = step.rateOverride ?? op.fixedRate;
          if (effectiveRate != null) {
            rate = effectiveRate;
          } else {
            if (!fullyOutsourced) {
              warningsSet.add(
                `Нет ставки операции «${opLabel}» — план по этой операции не учтён`,
              );
            }
            rate = null;
          }
        } else if (effMode === 'BY_SIZE') {
          // Поразмерное переопределение заказа, затем дефолт операции.
          const r =
            step.rateBySize.get(item.sizeId) ?? ratesBySize.get(item.sizeId);
          if (r != null) {
            rate = r;
          } else {
            if (!fullyOutsourced) {
              warningsSet.add(
                `Нет ставки операции «${opLabel}» для размера ${sizeCode}`,
              );
            }
            rate = null;
          }
        }

        if (rate != null) {
          totalCost = totalCost.add(rate.mul(ownQty));
        }

        // ----- Деньги: стороннее размещение -----
        // Вместо своей стоимости по отданным штукам в план идёт цена
        // подрядчика. Сумма ложится и в `totalCost` (план операций всегда
        // полный), и в `totalOutsource` (расшифровка «в том числе»).
        if (outQty > 0) {
          if (step.outsourcePriceRub != null) {
            const placement = step.outsourcePriceRub.mul(outQty);
            totalCost = totalCost.add(placement);
            totalOutsource = totalOutsource.add(placement);
          } else {
            // Цену не задали — молчаливый ноль читался бы как «подряд
            // бесплатный». Warning один на операцию (Set схлопнет повторы
            // по размерам и строкам плана).
            warningsSet.add(
              `Не задана цена стороннего размещения по операции «${opLabel}» — ` +
                `размещение посчитано как 0`,
            );
          }
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
    // Тот же режим округления, что и у полной суммы: расшифровка «в том
    // числе размещение» должна сходиться с планом по копейке.
    const totalOutsourceRounded = totalOutsource.toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );

    return {
      totalCostRub: totalCostRounded,
      totalTimeSec,
      outsourceCostRub: totalOutsourceRounded,
      warnings: Array.from(warningsSet),
    };
  }

  /**
   * Расчёт плана по СНИМКУ маршрута заказа (`OrderRouteStep`), а не по
   * шаблону. Нужен amendment-пути (правка заказа в производстве): операция,
   * добавленная только в снимок заказа, обязана попасть в план. Структуру
   * и per-order правки берём из снимка; `isOptional` восстанавливаем
   * кросс-ссылкой на шаблон (в снимке этого флага нет), чтобы для
   * НЕ-правленых заказов число совпало с `calculateForOrder`.
   *
   * Если снимка нет (легаси / ещё не материализован) — падаем на
   * `calculateForOrder` (шаблон), чтобы поведение осталось разумным.
   */
  async calculateFromSnapshot(
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    totalCostRub: Prisma.Decimal | null;
    totalTimeSec: number | null;
    outsourceCostRub: Prisma.Decimal | null;
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
      },
    });
    if (!order) {
      return {
        totalCostRub: null,
        totalTimeSec: null,
        outsourceCostRub: null,
        warnings: ['Заказ не найден — план операций не рассчитан'],
      };
    }

    const itemsWithQty = order.items.filter((it) => it.qtyPlan > 0);
    if (itemsWithQty.length === 0) {
      return {
        totalCostRub: null,
        totalTimeSec: null,
        outsourceCostRub: null,
        warnings: [
          'Не заполнен план по размерам — план операций не рассчитан',
        ],
      };
    }

    const snapshotSteps = await tx.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
      select: {
        operationId: true,
        rateOverride: true,
        timeNormSecOverride: true,
        pricingModeOverride: true,
        // Сторонние услуги — см. одноимённый select в `calculateForOrder`:
        // подряд правится по КАЖДОМУ вхождению операции в маршрут, и здесь
        // мы идём именно по строкам снимка.
        outsourced: true,
        outsourcePriceRub: true,
        sizeOverrides: {
          select: {
            sizeId: true,
            rate: true,
            seconds: true,
            outsourcedQty: true,
          },
        },
        operation: { select: PLAN_OPERATION_SELECT },
      },
    });
    if (snapshotSteps.length === 0) {
      // Снимка нет — считаем по шаблону (совместимость).
      return this.calculateForOrder(orderId, tx);
    }

    // `isOptional` в снимке не хранится — восстанавливаем множество
    // опциональных операций из шаблона, чтобы для не-правленых заказов
    // результат совпал с `calculateForOrder` (опциональные шаги в план
    // не входят). Добавленная в производстве операция шаблону неизвестна
    // → в это множество не попадёт → в план войдёт.
    const optionalOpIds = new Set<string>();
    if (order.routeTemplateId) {
      const tplSteps = await tx.routeTemplateStep.findMany({
        where: { templateId: order.routeTemplateId, isOptional: true },
        select: { operationId: true },
      });
      for (const s of tplSteps) optionalOpIds.add(s.operationId);
    }

    const normalizedSteps: NormalizedPlanStep[] = snapshotSteps.map((s) => {
      const rateBySize = new Map<string, Prisma.Decimal>();
      const secondsBySize = new Map<string, number>();
      const outsourcedQtyBySize = new Map<string, number>();
      for (const o of s.sizeOverrides) {
        if (o.rate != null) rateBySize.set(o.sizeId, o.rate);
        if (o.seconds != null) secondsBySize.set(o.sizeId, o.seconds);
        // Ноль — тоже расписанный объём (см. `calculateForOrder`).
        if (o.outsourcedQty != null) {
          outsourcedQtyBySize.set(o.sizeId, o.outsourcedQty);
        }
      }
      return {
        isOptional: optionalOpIds.has(s.operationId),
        operation: s.operation,
        rateOverride: s.rateOverride,
        timeNormSecOverride: s.timeNormSecOverride,
        pricingModeOverride: s.pricingModeOverride,
        outsourced: s.outsourced === true,
        outsourcePriceRub: s.outsourcePriceRub,
        rateBySize,
        secondsBySize,
        outsourcedQtyBySize,
      };
    });

    return this.computeTotals(normalizedSteps, itemsWithQty);
  }

  /**
   * Считает план ПО СНИМКУ и пишет его в `Order` (та же транзакция).
   * Amendment-путь (правка в производстве) зовёт именно это — чтобы
   * добавленная операция и новый тираж отразились в плановой
   * стоимости/времени, а не терялись при следующей правке.
   */
  async recalculateAndWriteFromSnapshot(
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    totalCostRub: Prisma.Decimal | null;
    totalTimeSec: number | null;
    outsourceCostRub: Prisma.Decimal | null;
    warnings: string[];
  }> {
    const result = await this.calculateFromSnapshot(orderId, tx);
    await tx.order.update({
      where: { id: orderId },
      data: {
        operationCostPlanRub: result.totalCostRub,
        // Расшифровка «в том числе размещение» пишется тем же update-ом,
        // что и полный план: разъехаться они не должны ни на копейку.
        operationOutsourceCostPlanRub: result.outsourceCostRub,
        operationTimePlanSec: result.totalTimeSec,
        operationPlanCalculatedAt: new Date(),
        operationPlanWarnings:
          result.warnings.length > 0
            ? (result.warnings as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
    this.logger.log(
      `event=order.operation_plan.recalculate_from_snapshot orderId=${orderId} ` +
        `costRub=${result.totalCostRub?.toString() ?? 'null'} ` +
        `outsourceRub=${result.outsourceCostRub?.toString() ?? 'null'} ` +
        `timeSec=${result.totalTimeSec ?? 'null'} ` +
        `warnings=${result.warnings.length}`,
    );
    return result;
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
   *   - `operationOutsourceCostPlanRub = null` (расшифровка «в том числе
   *     размещение» пуста ровно тогда же, когда пуст сам план),
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
    outsourceCostRub: Prisma.Decimal | null;
    warnings: string[];
  }> {
    // Маршрут заказа правили холстом — источник истины снимок, а не
    // шаблон. Считать по шаблону здесь значило бы показать менеджеру
    // стоимость маршрута, которого у заказа уже нет. Развилка стоит
    // ОДИН раз, в самом расчёте: `recalculateAndWrite` зовут семь мест
    // (create / update / startCalculation / ручной пересчёт / …), и
    // каждому нужен один и тот же ответ.
    const custom = await tx.order.findUnique({
      where: { id: orderId },
      select: { routeCustomizedAt: true },
    });
    if (custom?.routeCustomizedAt) {
      return this.recalculateAndWriteFromSnapshot(orderId, tx);
    }

    const result = await this.calculateForOrder(orderId, tx);
    await tx.order.update({
      where: { id: orderId },
      data: {
        operationCostPlanRub: result.totalCostRub,
        // «В том числе размещение» — расшифровка внутри полного плана
        // (см. `Order.operationOutsourceCostPlanRub`), не слагаемое.
        operationOutsourceCostPlanRub: result.outsourceCostRub,
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
        `outsourceRub=${result.outsourceCostRub?.toString() ?? 'null'} ` +
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
        routeCustomizedAt: true,
        operationPlanCalculatedAt: true,
        items: { select: { id: true, qtyPlan: true } },
        routeSteps: { select: { operationId: true } },
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

    // Маршрут правили холстом — шаблон больше не источник шагов (ре-синк
    // выключен, см. `syncOrderRouteStepsSnapshot`), поэтому его
    // `updatedAt` не должен помечать план устаревшим: иначе менеджер
    // получил бы вечный badge «план устарел», который не снимается
    // пересчётом. Шаги берём из снимка — ставки и нормы ИХ операций на
    // план по-прежнему влияют.
    const routeCustomized = order.routeCustomizedAt != null;
    const hasRoute = routeCustomized
      ? order.routeSteps.length > 0
      : Boolean(order.routeTemplateId && order.routeTemplate);
    if (!hasRoute) {
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

    const operationIds = routeCustomized
      ? order.routeSteps.map((s) => s.operationId)
      : (order.routeTemplate?.steps ?? []).map((s) => s.operationId);
    // `null` = шаблон из источников исключён (маршрут ручной).
    const templateUpdatedAt = routeCustomized
      ? null
      : order.routeTemplate?.updatedAt ?? null;

    // Если snapshot ещё ни разу не считался, но source-данные есть —
    // считаем стейл с понятной причиной. UI нарисует кнопку
    // «Рассчитать план операций».
    if (!order.operationPlanCalculatedAt) {
      // Берём max(updatedAt) источников, чтобы UI показал правдивую
      // дату последнего изменения (или `null`, если источников ещё
      // нет). Routes-шаблон updatedAt всегда есть.
      const sourceUpdatedAt = await this.collectMaxSourceUpdatedAt(
        templateUpdatedAt,
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
      templateUpdatedAt,
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
   *
   * `routeTemplateUpdatedAt = null` — шаблон исключён из источников:
   * маршрут заказа правили вручную, и правки шаблона до него больше не
   * доезжают (см. `Order.routeCustomizedAt`).
   */
  private async collectMaxSourceUpdatedAt(
    routeTemplateUpdatedAt: Date | null,
    operationIds: string[],
  ): Promise<Date | null> {
    let max: Date | null = routeTemplateUpdatedAt;

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
        if (c && (max === null || c.getTime() > max.getTime())) max = c;
      }
    }

    return max;
  }
}
