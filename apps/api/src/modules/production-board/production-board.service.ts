import { Injectable } from '@nestjs/common';
import {
  OperationCategory,
  PassportEventType,
  PassportStatus,
} from '@prisma/client';
import {
  PRODUCTION_BOARD_RELEASED,
  type ProductionBoardCohortDto,
  type ProductionBoardDrillDto,
  type ProductionBoardDrillEmployeeGroupDto,
  type ProductionBoardDrillQuery,
  type ProductionBoardDto,
  type ProductionBoardEmployeeDto,
  type ProductionBoardPassportRowDto,
  type ProductionBoardQuery,
  type ProductionBoardStageBucketDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * «Доска движения тиража» для кабинета мастера.
 *
 * Модель — когорта по дате выдачи кроя (`Passport.cutDate`, UTC-день).
 *
 * Колонки доски — НЕ статический список. Они вычисляются из
 * `OrderRouteStep` snapshot'ов заказов, чьи паспорта попали в окно
 * когорты: каждая уникальная операция маршрута (sewing + ОТК/ВТО/
 * упаковка, без кройки) → одна колонка, порядок — `Operation.sortOrder`.
 * Это тот же источник операций, что у «Экрана цеха»
 * (`ShopfloorService.buildSewingRoute`): сколько оверлоков реально в
 * маршруте — столько и колонок, без фантомных.
 *
 * Раскладка паспорта по колонке — через тот же резолвер текущей
 * операции, что использует display (`resolveColumnOp` ниже, зеркало
 * `resolveCurrentSewingOperationId` из `ShopfloorService`): паспорт,
 * выданный швее, но ещё не отсканированный на операцию (его
 * `currentOperation` всё ещё CUT_DIVISION, а реальная операция — в её
 * открытой `ShiftSession`), попадает в правильную колонку, а не
 * теряется.
 *
 * Штуки: «выдано» / «в работе» / ячейки операций — `qtyCut`
 * (физический объём кроя, как на «Экране цеха»); «выпущено» —
 * `qtyGood` (за вычетом брака, как KPI display). Брак — `qtyDefect`.
 *
 * Read-only: сервис только агрегирует, ничего не мутирует. Контракт —
 * `@sewing/shared` (`packages/shared/src/production-board.ts`).
 */
@Injectable()
export class ProductionBoardService {
  constructor(private readonly prisma: PrismaService) {}

  /** UTC-`YYYY-MM-DD` из Date. */
  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** [from, to] окно: последние `days` дней включая сегодня (UTC).
   * Применяется к ДАТЕ ВЫДАЧИ кроя (`ISSUED_TO_EMPLOYEE.createdAt`). */
  private window(days: number): { from: Date; to: Date } {
    const now = new Date();
    const to = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - (days - 1));
    from.setUTCHours(0, 0, 0, 0);
    return { from, to };
  }

  /**
   * Резолвер колонки паспорта — повторяет ОБЕ механики «Экрана цеха»
   * (`ShopfloorService.buildSewingRoute`), а не только активную:
   *
   *  1. АКТИВНО (▶, есть исполнитель). Зеркало
   *     `resolveCurrentSewingOperationId`: приоритет открытой
   *     sewing-смены над `currentOperation` — после `issueToEmployee`
   *     `Passport.currentOperationId` ещё указывает на CUT_DIVISION, а
   *     доменно правильная операция швеи лежит в её активной
   *     `ShiftSession.operationId`. Для ОТК/ВТО/упаковки sewing-смены
   *     нет → берём `currentOperation` (он уже корректен).
   *
   *  2. БУФЕР (✔, `currentEmployeeId = null`). Швея сдала операцию,
   *     паспорт ждёт следующего шага. Display в этом случае ставит ✔
   *     на шаг с `index === currentRouteStepIndex` — НЕ на устаревший
   *     `currentOperation`. Повторяем: позиция = операция РЕАЛЬНОГО
   *     шага маршрута заказа по `currentRouteStepIndex`. Без этого
   *     доска и display расходятся, как только `currentRouteStepIndex`
   *     уехал вперёд, а `currentOperation` остался на прошлой операции.
   *
   * `null` — паспорт не на одной из колонок доски (ещё в кройке,
   * маршрут заказа не зафиксирован, или статус ≠ IN_PROGRESS).
   */
  private resolveColumnOp(
    p: {
      status: PassportStatus;
      orderId: string | null;
      currentEmployeeId: string | null;
      currentRouteStepIndex: number | null;
      currentOperation: { id: string; code: string } | null;
    },
    sewingShiftByEmployee: Map<string, { id: string; code: string }>,
    opByOrderIndex: Map<string, Map<number, { id: string; code: string }>>,
  ): { id: string; code: string } | null {
    if (p.status !== PassportStatus.IN_PROGRESS) return null;
    if (p.currentEmployeeId !== null) {
      const shiftOp = sewingShiftByEmployee.get(p.currentEmployeeId);
      if (shiftOp) return shiftOp;
      return p.currentOperation;
    }
    // Буфер: «закончил операцию, ждёт следующего шага» — позиция по
    // реальному шагу маршрута (как ✔ done на «Экране цеха»).
    if (p.currentRouteStepIndex === null || !p.orderId) return null;
    return (
      opByOrderIndex.get(p.orderId)?.get(p.currentRouteStepIndex) ?? null
    );
  }

  async getBoard(query: ProductionBoardQuery): Promise<ProductionBoardDto> {
    const { from, to } = this.window(query.days);

    // Окно и когорта — по ДАТЕ ВЫДАЧИ кроя швеям (`ISSUED_TO_EMPLOYEE`),
    // НЕ по `Passport.cutDate`. Берём все события выдачи в окне; день
    // когорты паспорта = UTC-день его САМОГО РАННЕГО `ISSUED_TO_EMPLOYEE`
    // в окне (если перевыдавали в рамках периода — берём первую выдачу).
    const issueEvents = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.ISSUED_TO_EMPLOYEE,
        createdAt: { gte: from, lte: to },
      },
      select: { passportId: true, createdAt: true },
    });
    const issueDateByPassport = new Map<string, Date>();
    for (const e of issueEvents) {
      const cur = issueDateByPassport.get(e.passportId);
      if (!cur || e.createdAt < cur)
        issueDateByPassport.set(e.passportId, e.createdAt);
    }
    const passportIds = [...issueDateByPassport.keys()];

    const passports =
      passportIds.length > 0
        ? await this.prisma.passport.findMany({
            where: { id: { in: passportIds } },
            select: {
              id: true,
              qtyCut: true,
              qtyGood: true,
              qtyDefect: true,
              status: true,
              // Soft-route индекс — для «не дошло» по РЕАЛЬНОМУ
              // порядку `OrderRouteStep` его заказа.
              currentRouteStepIndex: true,
              currentEmployeeId: true,
              currentOperation: { select: { id: true, code: true } },
              currentEmployee: { select: { id: true, fullName: true } },
              orderId: true,
              order: { select: { number: true, customer: true } },
            },
          })
        : [];

    const orderIds = [
      ...new Set(passports.map((p) => p.orderId).filter((x): x is string => !!x)),
    ];

    // Открытые sewing-смены — fallback-источник операции для паспортов,
    // выданных швее, но ещё не отсканированных (см. `resolveColumnOp`).
    // Узкий фильтр (endedAt=null + category SEWING) держит выборку
    // маленькой. Тот же запрос, что в `ShopfloorService.getDisplaySummary`.
    const sewingShiftByEmployee = new Map<
      string,
      { id: string; code: string }
    >();
    {
      const shifts = await this.prisma.shiftSession.findMany({
        where: {
          endedAt: null,
          operation: { category: OperationCategory.SEWING },
        },
        select: {
          employeeId: true,
          operation: { select: { id: true, code: true } },
        },
      });
      for (const s of shifts) {
        sewingShiftByEmployee.set(s.employeeId, {
          id: s.operation.id,
          code: s.operation.code,
        });
      }
    }

    // Снимки маршрутов заказов когорты — ИСТОЧНИК КОЛОНОК (тот же, что
    // у «Экрана цеха»). Без кройки: доска ведёт партию от выдачи кроя
    // через пошив → ОТК → ВТО → упаковку. Уникальная операция → колонка,
    // порядок — `Operation.sortOrder`.
    const routeSteps =
      orderIds.length > 0
        ? await this.prisma.orderRouteStep.findMany({
            where: {
              orderId: { in: orderIds },
              operation: {
                category: { not: OperationCategory.CUTTING },
              },
            },
            select: {
              orderId: true,
              index: true,
              operation: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  sortOrder: true,
                },
              },
            },
          })
        : [];

    // Реестр колонок (дедуп по operationId) + два индекса по заказу:
    //   opIndexByOrder  — operationId → шаг (для «не дошло»);
    //   opByOrderIndex  — шаг → {id,code} (для ✔-буфера в resolveColumnOp).
    interface ColMeta {
      code: string;
      label: string;
      sortOrder: number;
    }
    const columns = new Map<string, ColMeta>();
    const opIndexByOrder = new Map<string, Map<string, number>>();
    const opByOrderIndex = new Map<
      string,
      Map<number, { id: string; code: string }>
    >();
    for (const st of routeSteps) {
      if (!columns.has(st.operation.id)) {
        columns.set(st.operation.id, {
          code: st.operation.code,
          label: st.operation.name,
          sortOrder: st.operation.sortOrder,
        });
      }
      let m = opIndexByOrder.get(st.orderId);
      if (!m) {
        m = new Map();
        opIndexByOrder.set(st.orderId, m);
      }
      m.set(st.operation.id, st.index);
      let bi = opByOrderIndex.get(st.orderId);
      if (!bi) {
        bi = new Map();
        opByOrderIndex.set(st.orderId, bi);
      }
      bi.set(st.index, { id: st.operation.id, code: st.operation.code });
    }
    const orderedCols = [...columns.entries()]
      .map(([id, meta]) => ({ id, ...meta }))
      .sort((a, b) =>
        a.sortOrder !== b.sortOrder
          ? a.sortOrder - b.sortOrder
          : a.code < b.code
            ? -1
            : 1,
      );

    // «Выдан» = паспорт в выборке (по определению есть
    // `ISSUED_TO_EMPLOYEE` в окне). «В работе» = паспорт реально
    // начат/выполнен на операции. ВАЖНО: нельзя завязываться только на
    // `OPERATION_SCAN` — реальный воркфлоу пишет `ISSUED_TO_EMPLOYEE`
    // → `OPERATION_FINISHED` без отдельного скана, и тогда ВСЁ
    // выданное ложно висело бы как «не взято». Поэтому «в работе» =
    // ≥1 из [OPERATION_SCAN, OPERATION_STARTED, OPERATION_FINISHED] —
    // согласуется с тем, что показывает «Экран цеха».
    const inOpsSet = new Set<string>();
    if (passports.length > 0) {
      const ev = await this.prisma.passportEvent.groupBy({
        by: ['passportId'],
        where: {
          passportId: { in: passports.map((p) => p.id) },
          type: {
            in: [
              PassportEventType.OPERATION_SCAN,
              PassportEventType.OPERATION_STARTED,
              PassportEventType.OPERATION_FINISHED,
            ],
          },
        },
        _count: { _all: true },
      });
      for (const row of ev) inOpsSet.add(row.passportId);
    }

    // Когорта = UTC-день выдачи кроя швеям (первый ISSUED_TO_EMPLOYEE).
    interface IssuedPos {
      orderId: string;
      // Позиция паспорта в маршруте: PACKED → +∞ (прошёл всё);
      // иначе `currentRouteStepIndex` (или -1, если ещё не известен).
      reached: number;
    }
    interface Acc {
      issueDate: string;
      orderIds: Set<string>;
      orderLabel: string;
      issuedPassports: number;
      issuedQty: number;
      inOpsPassports: number;
      inOpsQty: number;
      releasedPassports: number;
      releasedQty: number;
      // operationId -> employeeId -> aggregate
      buckets: Map<
        string,
        Map<
          string,
          {
            employeeId: string | null;
            employeeName: string;
            passports: number;
            qty: number;
            defects: number;
          }
        >
      >;
      issuedPositions: IssuedPos[];
    }

    const NO_EMP = '__none__';
    const cohorts = new Map<string, Acc>();
    const ensure = (key: string, p: (typeof passports)[number]): Acc => {
      let a = cohorts.get(key);
      if (!a) {
        a = {
          issueDate: key,
          orderIds: new Set(),
          orderLabel: '',
          issuedPassports: 0,
          issuedQty: 0,
          inOpsPassports: 0,
          inOpsQty: 0,
          releasedPassports: 0,
          releasedQty: 0,
          buckets: new Map(),
          issuedPositions: [],
        };
        cohorts.set(key, a);
      }
      if (p.orderId) a.orderIds.add(p.orderId);
      if (p.order && a.orderLabel === '') {
        a.orderLabel =
          `#${p.order.number}` +
          (p.order.customer ? ` · ${p.order.customer}` : '');
      }
      return a;
    };

    for (const p of passports) {
      const issuedAt = issueDateByPassport.get(p.id);
      if (!issuedAt) continue; // не выдан в окне — не на доске
      const key = this.dayKey(issuedAt);
      const a = ensure(key, p);
      const isInOps = inOpsSet.has(p.id);
      const isPacked = p.status === PassportStatus.PACKED;

      // Каждый паспорт выборки выдан (есть ISSUED_TO_EMPLOYEE в окне).
      a.issuedPassports += 1;
      a.issuedQty += p.qtyCut;
      a.issuedPositions.push({
        orderId: p.orderId ?? '',
        reached: isPacked
          ? Number.POSITIVE_INFINITY
          : p.currentRouteStepIndex ?? -1,
      });
      if (isInOps) {
        a.inOpsPassports += 1;
        a.inOpsQty += p.qtyCut;
      }
      if (isPacked) {
        a.releasedPassports += 1;
        a.releasedQty += p.qtyGood;
        continue; // в колонки-стадии PACKED не попадает
      }

      // Раскладка по колонке — тем же резолвером, что у display
      // (активная операция ▶ либо ✔-буфер по шагу маршрута).
      const op = this.resolveColumnOp(
        p,
        sewingShiftByEmployee,
        opByOrderIndex,
      );
      if (!op || !columns.has(op.id)) continue;

      let byEmp = a.buckets.get(op.id);
      if (!byEmp) {
        byEmp = new Map();
        a.buckets.set(op.id, byEmp);
      }
      const empKey = p.currentEmployeeId ?? NO_EMP;
      let agg = byEmp.get(empKey);
      if (!agg) {
        agg = {
          employeeId: p.currentEmployeeId,
          employeeName: p.currentEmployee?.fullName ?? 'Не назначен',
          passports: 0,
          qty: 0,
          defects: 0,
        };
        byEmp.set(empKey, agg);
      }
      agg.passports += 1;
      agg.qty += p.qtyCut;
      agg.defects += p.qtyDefect;
    }

    const cohortDtos: ProductionBoardCohortDto[] = [...cohorts.values()]
      .sort((x, y) => (x.issueDate < y.issueDate ? 1 : -1))
      .map((a) => {
        const stages: ProductionBoardStageBucketDto[] = orderedCols.map(
          (col) => {
            const byEmp = a.buckets.get(col.id);
            const employees: ProductionBoardEmployeeDto[] = byEmp
              ? [...byEmp.values()]
                  .map((e) => ({
                    employeeId: e.employeeId ?? '',
                    employeeName: e.employeeName,
                    passports: e.passports,
                    qty: e.qty,
                    defects: e.defects,
                  }))
                  .sort((m, n) => n.passports - m.passports)
              : [];
            const passportsAt = employees.reduce(
              (s, e) => s + e.passports,
              0,
            );
            const qtyAt = employees.reduce((s, e) => s + e.qty, 0);
            const defectsAt = employees.reduce((s, e) => s + e.defects, 0);
            // «Не дошло» — выданные паспорта, чья позиция в РЕАЛЬНОМ
            // маршруте их заказа < индекса этой операции. Если у
            // заказа паспорта этой операции в маршруте нет — паспорт
            // не учитываем (колонка к нему неприменима). PACKED имеют
            // reached=+∞ → в notReached не попадают.
            const notReached = a.issuedPositions.filter((ip) => {
              const oi = opIndexByOrder.get(ip.orderId)?.get(col.id);
              if (oi === undefined) return false;
              return ip.reached < oi;
            }).length;
            return {
              code: col.code,
              passports: passportsAt,
              qty: qtyAt,
              defects: defectsAt,
              employees,
              notReached,
            };
          },
        );

        const orderLabel =
          a.orderIds.size > 1
            ? `${a.orderIds.size} заказ(ов)`
            : a.orderLabel || '—';

        return {
          issueDate: a.issueDate,
          orderId: a.orderIds.size === 1 ? [...a.orderIds][0] : null,
          orderLabel,
          issuedPassports: a.issuedPassports,
          issuedQty: a.issuedQty,
          inOpsPassports: a.inOpsPassports,
          inOpsQty: a.inOpsQty,
          notPickedPassports: Math.max(
            0,
            a.issuedPassports - a.inOpsPassports,
          ),
          releasedPassports: a.releasedPassports,
          releasedQty: a.releasedQty,
          stages,
        };
      });

    return {
      from: this.dayKey(from),
      to: this.dayKey(to),
      stages: orderedCols.map((c) => ({ code: c.code, label: c.label })),
      cohorts: cohortDtos,
    };
  }

  /** Drill-down: список паспортов когорты на стадии (опц. по сотруднику). */
  async getDrill(
    query: ProductionBoardDrillQuery,
  ): Promise<ProductionBoardDrillDto> {
    const dayStart = new Date(`${query.issueDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${query.issueDate}T23:59:59.999Z`);
    const released = query.stage === PRODUCTION_BOARD_RELEASED;

    // Когорта дня = паспорта, ВЫДАННЫЕ швеям в этот UTC-день
    // (`ISSUED_TO_EMPLOYEE.createdAt`). Тот же ключ, что у доски.
    const issuedThatDay = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.ISSUED_TO_EMPLOYEE,
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      select: { passportId: true },
    });
    const dayPassportIds = [
      ...new Set(issuedThatDay.map((e) => e.passportId)),
    ];

    if (released) {
      // «Выпущено» — статус PACKED. Резолвер не нужен.
      const packed =
        dayPassportIds.length === 0
          ? []
          : await this.prisma.passport.findMany({
        where: {
          id: { in: dayPassportIds },
          status: PassportStatus.PACKED,
        },
        select: {
          id: true,
          number: true,
          qtyGood: true,
          qtyDefect: true,
          size: { select: { code: true } },
        },
        orderBy: { number: 'asc' },
      });
      const rows: ProductionBoardPassportRowDto[] = packed.map((p) => ({
        passportId: p.id,
        number: p.number,
        sizeCode: p.size?.code ?? '—',
        qty: p.qtyGood,
        defects: p.qtyDefect,
        employeeName: null,
      }));
      const group: ProductionBoardDrillEmployeeGroupDto = {
        employeeId: null,
        employeeName: 'Выпущено (PACKED)',
        passports: rows.length,
        qty: rows.reduce((s, r) => s + r.qty, 0),
        defects: rows.reduce((s, r) => s + r.defects, 0),
        rows,
      };
      return {
        issueDate: query.issueDate,
        stageLabel: 'Выпущено',
        totalPassports: rows.length,
        totalQty: group.qty,
        totalDefects: group.defects,
        groups: rows.length > 0 ? [group] : [],
      };
    }

    // Для стадии-операции фильтруем тем же резолвером, что и доска
    // (нельзя в SQL: «выдан швее, но не отсканирован» и ✔-буфер
    // определяются через открытую sewing-смену / шаг маршрута).
    // Берём живые паспорта когорты дня и отбираем те, чья
    // резолв-операция == `query.stage`.
    const candidates =
      dayPassportIds.length === 0
        ? []
        : await this.prisma.passport.findMany({
      where: {
        id: { in: dayPassportIds },
        status: PassportStatus.IN_PROGRESS,
      },
      select: {
        id: true,
        number: true,
        qtyCut: true,
        qtyDefect: true,
        status: true,
        orderId: true,
        currentRouteStepIndex: true,
        size: { select: { code: true } },
        currentEmployeeId: true,
        currentOperation: { select: { id: true, code: true } },
        currentEmployee: { select: { fullName: true } },
      },
      orderBy: { number: 'asc' },
    });

    // Шаг маршрута → операция, по заказам кандидатов (для ✔-буфера в
    // `resolveColumnOp`). Без кройки — как в `getBoard`.
    const drillOrderIds = [
      ...new Set(
        candidates.map((p) => p.orderId).filter((x): x is string => !!x),
      ),
    ];
    const opByOrderIndex = new Map<
      string,
      Map<number, { id: string; code: string }>
    >();
    if (drillOrderIds.length > 0) {
      const rs = await this.prisma.orderRouteStep.findMany({
        where: {
          orderId: { in: drillOrderIds },
          operation: { category: { not: OperationCategory.CUTTING } },
        },
        select: {
          orderId: true,
          index: true,
          operation: { select: { id: true, code: true } },
        },
      });
      for (const st of rs) {
        let bi = opByOrderIndex.get(st.orderId);
        if (!bi) {
          bi = new Map();
          opByOrderIndex.set(st.orderId, bi);
        }
        bi.set(st.index, { id: st.operation.id, code: st.operation.code });
      }
    }

    const sewingShiftByEmployee = new Map<
      string,
      { id: string; code: string }
    >();
    {
      const shifts = await this.prisma.shiftSession.findMany({
        where: {
          endedAt: null,
          operation: { category: OperationCategory.SEWING },
        },
        select: {
          employeeId: true,
          operation: { select: { id: true, code: true } },
        },
      });
      for (const s of shifts) {
        sewingShiftByEmployee.set(s.employeeId, {
          id: s.operation.id,
          code: s.operation.code,
        });
      }
    }

    // Метка операции (для заголовка панели) — имя из справочника по коду.
    const opRow = await this.prisma.operation.findUnique({
      where: { code: query.stage },
      select: { name: true },
    });
    const stageLabel = opRow?.name ?? query.stage;

    const NO_EMP = '__none__';
    const groups = new Map<string, ProductionBoardDrillEmployeeGroupDto>();
    for (const p of candidates) {
      const op = this.resolveColumnOp(
        p,
        sewingShiftByEmployee,
        opByOrderIndex,
      );
      if (!op || op.code !== query.stage) continue;
      if (query.employeeId && p.currentEmployeeId !== query.employeeId)
        continue;

      const row: ProductionBoardPassportRowDto = {
        passportId: p.id,
        number: p.number,
        sizeCode: p.size?.code ?? '—',
        qty: p.qtyCut,
        defects: p.qtyDefect,
        employeeName: p.currentEmployee?.fullName ?? null,
      };
      const gKey = p.currentEmployeeId ?? NO_EMP;
      let g = groups.get(gKey);
      if (!g) {
        g = {
          employeeId: p.currentEmployeeId,
          employeeName: p.currentEmployee?.fullName ?? 'Не назначен',
          passports: 0,
          qty: 0,
          defects: 0,
          rows: [],
        };
        groups.set(gKey, g);
      }
      g.rows.push(row);
      g.passports += 1;
      g.qty += p.qtyCut;
      g.defects += p.qtyDefect;
    }

    const groupList = [...groups.values()].sort(
      (a, b) => b.passports - a.passports,
    );
    return {
      issueDate: query.issueDate,
      stageLabel,
      totalPassports: groupList.reduce((s, g) => s + g.passports, 0),
      totalQty: groupList.reduce((s, g) => s + g.qty, 0),
      totalDefects: groupList.reduce((s, g) => s + g.defects, 0),
      groups: groupList,
    };
  }
}
