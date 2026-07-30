import { Injectable } from '@nestjs/common';
import {
  OperationCategory,
  OrderStatus,
  PassportEventType,
  PassportStatus,
  Prisma,
  Role,
} from '@prisma/client';
import {
  PRODUCTION_DASHBOARD_ROLE_LABELS,
  type ProductionDashboardAlertDto,
  type ProductionDashboardDto,
  type ProductionDashboardKpiDto,
  type ProductionDashboardPipelineDto,
  type ProductionDashboardPipelineStageDto,
  type ProductionDashboardQuery,
  type ProductionDashboardRole,
  type ProductionDashboardRoleLoadDto,
  type ProductionDashboardStage,
  type ProductionDashboardTrendDayDto,
} from '@sewing/shared/dashboard';
import { SHIFT_MINUTES } from '@sewing/shared/costs';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  bucketOf,
  type ProjectionPassport,
} from '../shopfloor/shopfloor-projection.js';
import { CostsService } from '../costs/costs.service.js';
import { PassportDurationsService } from '../costs/passport-durations.service.js';
import { isSalaryEligible } from '../employees/compensation.js';

/**
 * Сервис управленческого дашборда «Дашборд начальника производства»
 * (`/api/dashboard/production`).
 *
 * НЕ вводит ни новых таблиц, ни новых событий: всё агрегируется на
 * существующих `Passport` / `PassportEvent` / `Order` / `OperationEntry`
 * / `SalaryEntry`, плюс переиспользуем готовые сервисы:
 *   - `CostsService.getProductionCost` — series для графика и period idle;
 *   - `PassportDurationsService.listForPeriod` — длительности стадий
 *     для расчёта role load;
 *   - shopfloor-projection (`bucketOf`) — то же правило раскладки
 *     паспортов по стадиям, что и на `/shopfloor` (см. ADR-0013).
 *
 * Контракт — `docs/api.md §11b`, экран — `docs/screens.md §18`,
 * доменные правила — `docs/domain.md §17`.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly costs: CostsService,
    private readonly durations: PassportDurationsService,
  ) {}

  async getProductionDashboard(
    query: ProductionDashboardQuery,
  ): Promise<ProductionDashboardDto> {
    const periodDays = query.days;
    const now = new Date();
    const today = startOfUtcDay(now);
    const dateFrom = new Date(today);
    dateFrom.setUTCDate(dateFrom.getUTCDate() - (periodDays - 1));
    const dateTo = endOfUtcDay(today);
    const todayKey = toDateKey(today);

    const dateFromIso = toDateKey(dateFrom);
    const dateToIso = toDateKey(today);

    // 1) Series — себестоимость / выпуск / простой по дням.
    //    Это же даёт нам summary за период (idleCostPeriod, totalCostPeriod).
    const cost = await this.costs.getProductionCost({
      dateFrom: dateFromIso,
      dateTo: dateToIso,
    });
    const todayCost = cost.days.find((d) => d.date === todayKey) ?? null;

    // 2) Pipeline — повторяем правила `/shopfloor` (scope = ALL_ACTIVE)
    //    через ту же `bucketOf`, чтобы число паспортов в каждой стадии
    //    билось 1:1 между двумя экранами.
    const pipeline = await this.computePipeline();

    // 3) WIP-счётчики (паспорта, заказы).
    const [wipPassportsCount, wipUnitsAgg, ordersInProductionCount] =
      await this.prisma.$transaction([
        this.prisma.passport.count({
          where: {
            status: { in: [PassportStatus.CREATED, PassportStatus.IN_PROGRESS] },
          },
        }),
        this.prisma.passport.aggregate({
          where: {
            status: { in: [PassportStatus.CREATED, PassportStatus.IN_PROGRESS] },
          },
          _sum: { qtyCut: true },
        }),
        this.prisma.order.count({
          where: { status: OrderStatus.IN_PRODUCTION },
        }),
      ]);

    // 4) Выпущено сегодня / за период — по PACKED-ивентам.
    //    Считаем `Σ Passport.qtyGood` через include, чтобы исключить
    //    «не упакованные» паспорта (PACKED event пишется только при
    //    добавлении в коробку, см. F7).
    const [packedTodayEvents, packedPeriodAgg] = await this.prisma.$transaction(
      [
        this.prisma.passportEvent.findMany({
          where: {
            type: PassportEventType.PACKED,
            createdAt: { gte: today, lte: dateTo },
          },
          select: { passport: { select: { qtyGood: true } } },
        }),
        this.prisma.passportEvent.findMany({
          where: {
            type: PassportEventType.PACKED,
            createdAt: { gte: dateFrom, lte: dateTo },
          },
          select: { passport: { select: { qtyGood: true } } },
        }),
      ],
    );
    const producedToday = packedTodayEvents.reduce(
      (s, e) => s + (e.passport.qtyGood ?? 0),
      0,
    );
    const producedPeriod = packedPeriodAgg.reduce(
      (s, e) => s + (e.passport.qtyGood ?? 0),
      0,
    );

    // 5) Role load за UTC-сегодня. Считается по тем же правилам, что
    //    и в CostsService для дня, но сгруппировано по `Employee.role`.
    const roleLoad = await this.computeRoleLoad(today, dateTo);

    // 6) KPI — всё, что нужно карточкам сверху. Утилизация цеха = по
    //    окладным ролям за сегодня (tracked / paid).
    const totalPaid = roleLoad.reduce((s, r) => s + r.paidMinutes, 0);
    const totalTracked = roleLoad.reduce((s, r) => s + r.trackedMinutes, 0);
    const utilizationToday =
      totalPaid > 0 ? Math.round((totalTracked / totalPaid) * 100) : 0;

    const kpi: ProductionDashboardKpiDto = {
      producedToday,
      producedPeriod,
      wipUnits: wipUnitsAgg._sum.qtyCut ?? 0,
      wipPassports: wipPassportsCount,
      ordersInProduction: ordersInProductionCount,
      avgCostPerUnitToday:
        todayCost && todayCost.producedUnits > 0
          ? round2(todayCost.totalCost / todayCost.producedUnits)
          : 0,
      idleCostToday: todayCost ? todayCost.idleCost : 0,
      utilizationToday,
      idleCostPeriod: cost.summary.idleCost,
      totalCostPeriod: cost.summary.totalCost,
    };

    // 7) Trend — лёгкий подмассив для UI (3 серии на одном графике).
    const trend: ProductionDashboardTrendDayDto[] = cost.days.map((d) => ({
      date: d.date,
      producedUnits: d.producedUnits,
      totalCost: d.totalCost,
      idleCost: d.idleCost,
    }));

    // 8) Alerts — собираем top-items проблемных зон.
    const alerts = await this.computeAlerts({
      pipeline,
      roleLoad,
      costDays: cost.days,
      dateFrom,
      dateTo,
    });

    return {
      generatedAt: now.toISOString(),
      today: todayKey,
      periodDays,
      dateFrom: dateFromIso,
      dateTo: dateToIso,
      kpi,
      pipeline,
      trend,
      roleLoad,
      alerts,
    };
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  private async computePipeline(): Promise<ProductionDashboardPipelineDto> {
    // Берём только живые паспорта активных заказов — то же окно, что у
    // `/shopfloor` ALL_ACTIVE. Архивные `DONE/CANCELLED` заказы в
    // pipeline не светим, чтобы метрика не «висела» вечно.
    const passports = await this.prisma.passport.findMany({
      where: {
        order: {
          status: { notIn: [OrderStatus.DONE, OrderStatus.CANCELLED] },
        },
      },
      select: {
        id: true,
        sizeId: true,
        qtyCut: true,
        qtyGood: true,
        qtyDefect: true,
        status: true,
        currentEmployeeId: true,
        currentOperation: { select: { category: true } },
        boxItems: {
          select: { box: { select: { closedAt: true } } },
        },
      },
    });

    // Свежие QC_PASSED / WTO_PASSED (для `QC_DONE` / `WTO_DONE`),
    // ровно как делает ShopfloorService — иначе `bucketOf` посчитает
    // эти стадии за обычные QC/WTO. Фильтр по тем же кандидатам.
    const qcCandidateIds: string[] = [];
    const wtoCandidateIds: string[] = [];
    for (const p of passports) {
      if (p.status !== PassportStatus.IN_PROGRESS) continue;
      const cat = p.currentOperation?.category;
      if (cat === OperationCategory.QC) qcCandidateIds.push(p.id);
      else if (cat === OperationCategory.IRONING) wtoCandidateIds.push(p.id);
    }
    const candidateIds = [...qcCandidateIds, ...wtoCandidateIds];
    const freshQcPassedSet = new Set<string>();
    const freshWtoPassedSet = new Set<string>();
    if (candidateIds.length > 0) {
      const eventMaxes = await this.prisma.passportEvent.groupBy({
        by: ['passportId', 'type'],
        where: {
          passportId: { in: candidateIds },
          type: {
            in: [
              PassportEventType.QC_PASSED,
              PassportEventType.WTO_PASSED,
              PassportEventType.OPERATION_SCAN,
            ],
          },
        },
        _max: { createdAt: true },
      });
      const lastQc = new Map<string, Date>();
      const lastWto = new Map<string, Date>();
      const lastScan = new Map<string, Date>();
      for (const row of eventMaxes) {
        const at = row._max.createdAt;
        if (!at) continue;
        if (row.type === PassportEventType.QC_PASSED) lastQc.set(row.passportId, at);
        else if (row.type === PassportEventType.WTO_PASSED)
          lastWto.set(row.passportId, at);
        else if (row.type === PassportEventType.OPERATION_SCAN)
          lastScan.set(row.passportId, at);
      }
      for (const id of qcCandidateIds) {
        const qcAt = lastQc.get(id);
        if (!qcAt) continue;
        const scanAt = lastScan.get(id);
        if (!scanAt || qcAt > scanAt) freshQcPassedSet.add(id);
      }
      for (const id of wtoCandidateIds) {
        const wtoAt = lastWto.get(id);
        if (!wtoAt) continue;
        const scanAt = lastScan.get(id);
        if (!scanAt || wtoAt > scanAt) freshWtoPassedSet.add(id);
      }
    }

    const stageQty = new Map<ProductionDashboardStage, number>();
    const stagePassports = new Map<ProductionDashboardStage, number>();
    let defectQty = 0;

    for (const p of passports) {
      if (p.status === PassportStatus.CANCELLED) continue;
      defectQty += p.qtyDefect;
      const proj: ProjectionPassport = {
        sizeId: p.sizeId,
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        qtyDefect: p.qtyDefect,
        status: p.status,
        currentOperationCategory: p.currentOperation?.category ?? null,
        currentEmployeeId: p.currentEmployeeId,
        hasOpenBox: p.boxItems.some((bi) => bi.box.closedAt === null),
        hasFreshQcPassed: freshQcPassedSet.has(p.id),
        hasFreshWtoPassed: freshWtoPassedSet.has(p.id),
      };
      const bucket = bucketOf(proj);
      if (!bucket) continue;
      const isPackedBucket = bucket === 'PACKING' || bucket === 'FINISHED';
      const qty = isPackedBucket ? p.qtyGood : p.qtyCut;
      stageQty.set(
        bucket as ProductionDashboardStage,
        (stageQty.get(bucket as ProductionDashboardStage) ?? 0) + qty,
      );
      stagePassports.set(
        bucket as ProductionDashboardStage,
        (stagePassports.get(bucket as ProductionDashboardStage) ?? 0) + 1,
      );
    }

    const STAGES_ORDER: ProductionDashboardStage[] = [
      'CUT',
      'SEWING',
      'QC',
      'QC_DONE',
      'WTO',
      'WTO_DONE',
      'PACKING',
      'FINISHED',
    ];
    const stages: ProductionDashboardPipelineStageDto[] = STAGES_ORDER.map(
      (s) => ({
        stage: s,
        qty: stageQty.get(s) ?? 0,
        passports: stagePassports.get(s) ?? 0,
      }),
    );

    // Bottleneck — стадия с самым большим хвостом среди живых
    // (FINISHED не считаем, это «выпуск», а не «затор»).
    let bottleneckStage: ProductionDashboardStage | null = null;
    let bottleneckQty = 0;
    for (const s of stages) {
      if (s.stage === 'FINISHED') continue;
      if (s.qty > bottleneckQty) {
        bottleneckQty = s.qty;
        bottleneckStage = s.stage;
      }
    }

    return { stages, defectQty, bottleneckStage, bottleneckQty };
  }

  // -------------------------------------------------------------------------
  // Role load (день «to»)
  // -------------------------------------------------------------------------

  private async computeRoleLoad(
    dayStart: Date,
    dayEnd: Date,
  ): Promise<ProductionDashboardRoleLoadDto[]> {
    // 1) Все стадии за день.
    const stages = await this.durations.listForPeriod(dayStart, dayEnd);

    // 2) Сотрудники с SalaryEntry за день (источник «человек был на смене»).
    const salaryEntries = await this.prisma.salaryEntry.findMany({
      where: { date: { gte: dayStart, lte: dayEnd } },
      select: { employeeId: true },
    });

    const employeeIds = new Set<string>();
    for (const s of stages) employeeIds.add(s.employeeId);
    for (const s of salaryEntries) employeeIds.add(s.employeeId);

    if (employeeIds.size === 0) {
      return PRODUCTION_DASHBOARD_ROLE_KEYS.map((role) => ({
        role,
        employees: 0,
        paidMinutes: 0,
        trackedMinutes: 0,
        idleMinutes: 0,
        idleCost: 0,
        utilization: 0,
      }));
    }

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: Array.from(employeeIds) } },
      select: {
        id: true,
        role: true,
        compensationType: true,
        salaryPerHour: true,
      },
    });
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    // 3) Подготовка агрегатов по ролям.
    const acc = new Map<
      ProductionDashboardRole,
      {
        salariedEmps: Set<string>;
        trackedByEmployee: Map<string, number>;
      }
    >();
    for (const role of PRODUCTION_DASHBOARD_ROLE_KEYS) {
      acc.set(role, { salariedEmps: new Set(), trackedByEmployee: new Map() });
    }

    for (const s of salaryEntries) {
      const emp = employeeById.get(s.employeeId);
      if (!emp) continue;
      const role = mapEmployeeRoleToDashboardRole(emp.role);
      if (!role) continue;
      // В salaried-мн-во кладём только окладных — у `PIECEWORK` ставки
      // нет, простой ему не считаем (см. CostsService.idleCost логика).
      if (!isSalaryEligible(emp.compensationType)) continue;
      acc.get(role)!.salariedEmps.add(emp.id);
    }

    for (const st of stages) {
      const emp = employeeById.get(st.employeeId);
      if (!emp) continue;
      const role = mapEmployeeRoleToDashboardRole(emp.role);
      if (!role) continue;
      const m = acc.get(role)!.trackedByEmployee;
      m.set(emp.id, (m.get(emp.id) ?? 0) + st.durationMinutes);
    }

    // 4) Складываем итог.
    const result: ProductionDashboardRoleLoadDto[] = [];
    for (const role of PRODUCTION_DASHBOARD_ROLE_KEYS) {
      const a = acc.get(role)!;
      const employeesCount = a.salariedEmps.size;
      const paidMinutes = employeesCount * SHIFT_MINUTES;
      let trackedMinutes = 0;
      let idleMinutes = 0;
      let idleCost = 0;
      // tracked суммируем по всем (включая «не окладных» — например,
      // если кто-то с MIXED в этот день зашёл на стадию, его минуты
      // важны для tracked цеха, но idle ему не считаем).
      for (const m of a.trackedByEmployee.values()) trackedMinutes += m;
      for (const empId of a.salariedEmps) {
        const emp = employeeById.get(empId)!;
        const minute = computeMinuteRate(emp.salaryPerHour);
        if (minute <= 0) continue;
        const tracked = a.trackedByEmployee.get(empId) ?? 0;
        const idle = Math.max(0, SHIFT_MINUTES - tracked);
        idleMinutes += idle;
        idleCost += idle * minute;
      }
      const utilization =
        paidMinutes > 0
          ? Math.min(100, Math.round((trackedMinutes / paidMinutes) * 100))
          : 0;
      result.push({
        role,
        employees: employeesCount,
        paidMinutes,
        trackedMinutes,
        idleMinutes,
        idleCost: round2(idleCost),
        utilization,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Alerts
  // -------------------------------------------------------------------------

  private async computeAlerts(args: {
    pipeline: ProductionDashboardPipelineDto;
    roleLoad: ProductionDashboardRoleLoadDto[];
    costDays: Array<{ date: string; idleCost: number }>;
    dateFrom: Date;
    dateTo: Date;
  }): Promise<ProductionDashboardAlertDto[]> {
    const out: ProductionDashboardAlertDto[] = [];

    // 1) Bottleneck — самая большая очередь в pipeline.
    if (args.pipeline.bottleneckStage && args.pipeline.bottleneckQty > 0) {
      const stageLabel = STAGE_LABELS[args.pipeline.bottleneckStage];
      out.push({
        type: 'PIPELINE_BOTTLENECK',
        severity: args.pipeline.bottleneckQty >= 50 ? 'WARN' : 'INFO',
        message: `Самая длинная очередь: ${stageLabel}`,
        value: args.pipeline.bottleneckQty,
        unit: 'шт',
        href: '/shopfloor',
      });
    }

    // 2) Top role idle — роль с самым большим idleCost за день.
    const sortedRolesByIdle = [...args.roleLoad].sort(
      (a, b) => b.idleCost - a.idleCost,
    );
    const topRole = sortedRolesByIdle[0];
    if (topRole && topRole.idleCost > 0) {
      out.push({
        type: 'ROLE_IDLE',
        severity:
          topRole.idleCost >= 1000
            ? 'WARN'
            : topRole.idleCost >= 100
              ? 'INFO'
              : 'INFO',
        message: `Простой по роли «${PRODUCTION_DASHBOARD_ROLE_LABELS[topRole.role]}»`,
        value: topRole.idleCost,
        unit: '₽',
      });
    }

    // 3) Сотрудник с максимальным неучтённым временем за день.
    const peakEmployeeIdle = await this.computePeakEmployeeIdle(
      args.dateTo,
    );
    if (peakEmployeeIdle && peakEmployeeIdle.idleMinutes > 0) {
      out.push({
        type: 'EMPLOYEE_IDLE',
        severity: peakEmployeeIdle.idleMinutes >= 240 ? 'WARN' : 'INFO',
        message: `${peakEmployeeIdle.fullName}: неучтённое время за день`,
        value: peakEmployeeIdle.idleMinutes,
        unit: 'мин',
      });
    }

    // 4) День с самым дорогим простоем за период.
    let peakIdleDay: { date: string; idleCost: number } | null = null;
    for (const d of args.costDays) {
      if (!peakIdleDay || d.idleCost > peakIdleDay.idleCost) peakIdleDay = d;
    }
    if (peakIdleDay && peakIdleDay.idleCost > 0) {
      out.push({
        type: 'PEAK_IDLE_DAY',
        severity: 'INFO',
        message: `Самый дорогой простой за период: ${formatDayLabel(peakIdleDay.date)}`,
        value: peakIdleDay.idleCost,
        unit: '₽',
        href: '/production-cost',
      });
    }

    // 5) Аномальные паспорта — где cap (`MAX_STAGE_MINUTES_PER_PASSPORT`)
    //    реально применился. Это тот же сигнал, что использует
    //    `PassportDurationsService` для защиты от «забыл закрыть».
    const cappedCount = await this.countCappedPassports(
      args.dateFrom,
      args.dateTo,
    );
    if (cappedCount > 0) {
      out.push({
        type: 'CAPPED_PASSPORTS',
        severity: cappedCount >= 5 ? 'WARN' : 'INFO',
        message: 'Аномальные паспорта по времени стадии (cap 60 мин)',
        value: cappedCount,
        unit: 'шт',
      });
    }

    return out;
  }

  private async computePeakEmployeeIdle(
    dayEnd: Date,
  ): Promise<{ employeeId: string; fullName: string; idleMinutes: number } | null> {
    const dayStart = startOfUtcDay(dayEnd);
    const stages = await this.durations.listForPeriod(dayStart, dayEnd);
    const salaryEntries = await this.prisma.salaryEntry.findMany({
      where: { date: { gte: dayStart, lte: dayEnd } },
      select: { employeeId: true },
    });
    if (salaryEntries.length === 0) return null;

    const trackedByEmployee = new Map<string, number>();
    for (const s of stages) {
      trackedByEmployee.set(
        s.employeeId,
        (trackedByEmployee.get(s.employeeId) ?? 0) + s.durationMinutes,
      );
    }

    const ids = Array.from(new Set(salaryEntries.map((s) => s.employeeId)));
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true, compensationType: true },
    });

    let best: { employeeId: string; fullName: string; idleMinutes: number } | null =
      null;
    for (const e of employees) {
      if (!isSalaryEligible(e.compensationType)) continue;
      const tracked = trackedByEmployee.get(e.id) ?? 0;
      const idle = Math.max(0, SHIFT_MINUTES - tracked);
      if (!best || idle > best.idleMinutes) {
        best = { employeeId: e.id, fullName: e.fullName, idleMinutes: idle };
      }
    }
    return best;
  }

  private async countCappedPassports(from: Date, to: Date): Promise<number> {
    const stages = await this.durations.listForPeriod(from, to);
    const cappedPassports = new Set<string>();
    for (const s of stages) {
      if (s.capped) cappedPassports.add(s.passportId);
    }
    return cappedPassports.size;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PRODUCTION_DASHBOARD_ROLE_KEYS: ProductionDashboardRole[] = [
  'QC',
  'IRONING',
  'PACKING',
];

const STAGE_LABELS: Record<ProductionDashboardStage, string> = {
  CUT: 'Крой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  QC_DONE: 'Проверено ОТК',
  WTO: 'ВТО',
  WTO_DONE: 'ВТО завершено',
  PACKING: 'Упаковка',
  FINISHED: 'Выпущено',
};

function mapEmployeeRoleToDashboardRole(
  // `Employee.role` — строка (`AppRole.code`), а не enum: роли
  // заводятся из админки. Неизвестный код просто не попадёт ни в одну
  // ветку switch и вернёт `null` — «в дашборде не участвует».
  role: string,
): ProductionDashboardRole | null {
  switch (role) {
    case Role.QC:
      return 'QC';
    case Role.IRONING:
      return 'IRONING';
    case Role.PACKING:
      return 'PACKING';
    default:
      return null;
  }
}

/**
 * ₽/минуту для разноса оклада на минуты простоя. Источник —
 * `Employee.salaryPerHour` (повременная оплата): минута = ставка/час
 * ÷ 60. Раньше считалось от legacy `salaryPerShift` / SHIFT_MINUTES;
 * при бэкфилле `salaryPerHour = salaryPerShift / 8` (SHIFT_MINUTES =
 * 480) результат для существующих сотрудников не меняется, а новые
 * окладники (без legacy `salaryPerShift`) больше не выпадают из разноса.
 */
function computeMinuteRate(
  ratePerHour: Prisma.Decimal | null | undefined,
): number {
  if (ratePerHour === null || ratePerHour === undefined) return 0;
  const num =
    typeof ratePerHour === 'number'
      ? ratePerHour
      : Number(ratePerHour.toFixed(2));
  if (num <= 0) return 0;
  return num / 60;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function endOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(iso: string): string {
  const [yyyy, mm, dd] = iso.split('-');
  if (!yyyy || !mm || !dd) return iso;
  return `${dd}.${mm}`;
}
