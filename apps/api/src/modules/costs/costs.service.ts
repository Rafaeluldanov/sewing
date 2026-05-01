import { Injectable } from '@nestjs/common';
import {
  CompensationType,
  EntryStatus,
  PassportEventType,
  Prisma,
} from '@prisma/client';
import {
  SHIFT_MINUTES,
  type ProductionCostDayDto,
  type ProductionCostQuery,
  type ProductionCostResponseDto,
  type ProductionCostSummaryDto,
} from '@sewing/shared/costs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PassportDurationsService } from './passport-durations.service.js';

/**
 * Сервис «Себестоимость выпуска» (см. `docs/domain.md §17`).
 *
 * Алгоритм:
 *
 *   1. Период приходит в `[from..to]` (включительно по дню), без
 *      указания — последние 14 дней по UTC. Все выборки идут по UTC.
 *
 *   2. По каждому паспорту, упакованному в этот период (есть
 *      `PACKED` event внутри окна), считаем «себестоимость изделия»:
 *        piecework = Σ `OperationEntry.amount` (status=APPROVED) по
 *                    этому паспорту;
 *        salary    = Σ по стадиям QC/WTO/PACKING:
 *                       durationMinutes × employee.minuteRate.
 *      Cap длительности — в `PassportDurationsService`.
 *
 *   3. День агрегата = дата `PACKED` event паспорта (UTC).
 *
 *   4. Простой считаем отдельно: для каждого окладного сотрудника с
 *      открытой/закрытой сменой в этот день
 *        paid     = SHIFT_MINUTES;
 *        tracked  = Σ durationMinutes стадий, завершённых в этот день;
 *        idleMin  = max(0, paid − tracked);
 *        idleCost = idleMin × minuteRate.
 *      Простой НЕ распределяется на изделия и не входит в `totalCost`
 *      изделия (см. ТЗ §11) — это отдельная строка экранов.
 */
@Injectable()
export class CostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly durations: PassportDurationsService,
  ) {}

  async getProductionCost(
    query: ProductionCostQuery,
  ): Promise<ProductionCostResponseDto> {
    const { from, to, dateFromIso, dateToIso } = resolvePeriod(query);

    // 1) Длительности всех стадий за период.
    const stages = await this.durations.listForPeriod(from, to);

    // 2) Подгружаем employee.salaryPerShift для всех участников стадий
    //    + всех сотрудников с окладным начислением (источник «у этого
    //    человека был оклад в этот день»).
    const employeeIdsFromStages = new Set(stages.map((s) => s.employeeId));
    const salaryEntries = await this.prisma.salaryEntry.findMany({
      where: {
        date: { gte: from, lte: to },
      },
      select: {
        employeeId: true,
        date: true,
      },
    });
    for (const s of salaryEntries) employeeIdsFromStages.add(s.employeeId);

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: Array.from(employeeIdsFromStages) } },
      select: {
        id: true,
        compensationType: true,
        salaryPerShift: true,
      },
    });
    const employeeRate = new Map<string, number>();
    for (const e of employees) {
      const minute = computeMinuteRate(e.salaryPerShift);
      if (
        minute > 0 &&
        (e.compensationType === CompensationType.SALARY ||
          e.compensationType === CompensationType.MIXED)
      ) {
        employeeRate.set(e.id, minute);
      } else {
        // PIECEWORK или нет ставки — ноль (для расчёта простоя оклад
        // не применяется, для распределения окладной части — тоже).
        employeeRate.set(e.id, 0);
      }
    }

    // 3) Паспорта, упакованные в этом окне. Берём через PACKED event,
    //    чтобы дата выпуска совпадала с реальной упаковкой, а не с
    //    `Passport.updatedAt`.
    const packedEvents = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.PACKED,
        createdAt: { gte: from, lte: to },
      },
      select: {
        passportId: true,
        createdAt: true,
        passport: { select: { qtyGood: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // 4) Суммы piecework по паспорту. Берём только APPROVED — этого
    //    достаточно: к моменту PACKED по правилам ADR-0005 они уже
    //    апрувятся при закрытии коробки.
    const passportIds = Array.from(
      new Set(packedEvents.map((e) => e.passportId)),
    );
    const pieceworkRows = passportIds.length
      ? await this.prisma.operationEntry.groupBy({
          by: ['passportId'],
          where: {
            passportId: { in: passportIds },
            status: EntryStatus.APPROVED,
          },
          _sum: { amount: true },
        })
      : [];
    const pieceworkByPassport = new Map<string, number>();
    for (const r of pieceworkRows) {
      pieceworkByPassport.set(r.passportId, decimalToNumber(r._sum.amount));
    }

    // 5) Стадии по паспортам — для распределения salary доли по
    //    выпущенным изделиям.
    const stagesByPassport = new Map<
      string,
      Array<{ employeeId: string; durationMinutes: number }>
    >();
    for (const s of stages) {
      const arr = stagesByPassport.get(s.passportId) ?? [];
      arr.push({ employeeId: s.employeeId, durationMinutes: s.durationMinutes });
      stagesByPassport.set(s.passportId, arr);
    }

    // 6) Группируем по дню упаковки.
    const dayMap = new Map<string, MutableDay>();
    for (const ev of packedEvents) {
      const dayKey = toDateKey(ev.createdAt);
      const day = ensureDay(dayMap, dayKey);
      const qty = ev.passport.qtyGood ?? 0;
      day.producedUnits += qty;
      const piece = pieceworkByPassport.get(ev.passportId) ?? 0;
      day.pieceworkCost += piece;
      const passportStages = stagesByPassport.get(ev.passportId) ?? [];
      let salaryShare = 0;
      for (const st of passportStages) {
        const rate = employeeRate.get(st.employeeId) ?? 0;
        salaryShare += rate * st.durationMinutes;
      }
      day.salaryCost += salaryShare;
    }

    // 7) Учтённые минуты (по дню окончания стадии).
    for (const s of stages) {
      const dayKey = toDateKey(s.completedAt);
      const day = ensureDay(dayMap, dayKey);
      day.trackedMinutes += s.durationMinutes;
      day.trackedByEmployee.set(
        s.employeeId,
        (day.trackedByEmployee.get(s.employeeId) ?? 0) + s.durationMinutes,
      );
    }

    // 8) Простой по окладным сотрудникам, у которых в этот день
    //    есть SalaryEntry (это и есть наш источник «человек был на
    //    смене», см. ADR-0021 — `SalaryEntry` создаётся ровно в этом
    //    случае).
    for (const sal of salaryEntries) {
      const dayKey = toDateKey(sal.date);
      const day = ensureDay(dayMap, dayKey);
      day.salariedEmployees.add(sal.employeeId);
    }
    for (const day of dayMap.values()) {
      let idleMinutes = 0;
      let idleCost = 0;
      for (const empId of day.salariedEmployees) {
        const rate = employeeRate.get(empId) ?? 0;
        if (rate <= 0) continue;
        const tracked = day.trackedByEmployee.get(empId) ?? 0;
        const idle = Math.max(0, SHIFT_MINUTES - tracked);
        idleMinutes += idle;
        idleCost += idle * rate;
      }
      day.idleMinutes = idleMinutes;
      day.idleCost = idleCost;
    }

    // 9) Заполняем дни без событий — экран должен показывать «0»,
    //    а не пропуск, чтобы линия графика не рвалась.
    forEachDayInRange(from, to, (key) => {
      ensureDay(dayMap, key);
    });

    const days: ProductionCostDayDto[] = Array.from(dayMap.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => toDayDto(d));

    const summary = computeSummary(days);

    return {
      dateFrom: dateFromIso,
      dateTo: dateToIso,
      days,
      summary,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface MutableDay {
  date: string;
  producedUnits: number;
  pieceworkCost: number;
  salaryCost: number;
  trackedMinutes: number;
  idleMinutes: number;
  idleCost: number;
  /** Сколько минут tracked у каждого сотрудника в этот день. */
  trackedByEmployee: Map<string, number>;
  /** Сотрудники с окладной записью за этот день. */
  salariedEmployees: Set<string>;
}

function ensureDay(map: Map<string, MutableDay>, key: string): MutableDay {
  let d = map.get(key);
  if (!d) {
    d = {
      date: key,
      producedUnits: 0,
      pieceworkCost: 0,
      salaryCost: 0,
      trackedMinutes: 0,
      idleMinutes: 0,
      idleCost: 0,
      trackedByEmployee: new Map(),
      salariedEmployees: new Set(),
    };
    map.set(key, d);
  }
  return d;
}

function toDayDto(d: MutableDay): ProductionCostDayDto {
  const piece = round2(d.pieceworkCost);
  const sal = round2(d.salaryCost);
  return {
    date: d.date,
    producedUnits: d.producedUnits,
    pieceworkCost: piece,
    salaryCost: sal,
    totalCost: round2(piece + sal),
    trackedMinutes: d.trackedMinutes,
    idleMinutes: d.idleMinutes,
    idleCost: round2(d.idleCost),
  };
}

function computeSummary(
  days: ProductionCostDayDto[],
): ProductionCostSummaryDto {
  let producedUnits = 0;
  let pieceworkCost = 0;
  let salaryCost = 0;
  let idleCost = 0;
  let trackedMinutes = 0;
  let idleMinutes = 0;
  for (const d of days) {
    producedUnits += d.producedUnits;
    pieceworkCost += d.pieceworkCost;
    salaryCost += d.salaryCost;
    idleCost += d.idleCost;
    trackedMinutes += d.trackedMinutes;
    idleMinutes += d.idleMinutes;
  }
  const totalCost = round2(pieceworkCost + salaryCost);
  const avgCostPerUnit =
    producedUnits > 0 ? round2(totalCost / producedUnits) : 0;
  return {
    producedUnits,
    pieceworkCost: round2(pieceworkCost),
    salaryCost: round2(salaryCost),
    idleCost: round2(idleCost),
    trackedMinutes,
    idleMinutes,
    totalCost,
    avgCostPerUnit,
  };
}

function computeMinuteRate(rate: Prisma.Decimal | null | undefined): number {
  if (rate === null || rate === undefined) return 0;
  const num = decimalToNumber(rate);
  if (num <= 0) return 0;
  return num / SHIFT_MINUTES;
}

function decimalToNumber(
  amount: Prisma.Decimal | number | null | undefined,
): number {
  if (amount === null || amount === undefined) return 0;
  if (typeof amount === 'number') return amount;
  return Number(amount.toFixed(2));
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
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

function resolvePeriod(query: ProductionCostQuery): {
  from: Date;
  to: Date;
  dateFromIso: string;
  dateToIso: string;
} {
  const now = new Date();
  const defaultTo = startOfUtcDay(now);
  const defaultFrom = new Date(defaultTo);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 13);
  const fromDay = query.dateFrom
    ? startOfUtcDay(new Date(`${query.dateFrom}T00:00:00Z`))
    : defaultFrom;
  const toDay = query.dateTo
    ? startOfUtcDay(new Date(`${query.dateTo}T00:00:00Z`))
    : defaultTo;
  // Если перепутали направление — нормализуем.
  const [lo, hi] =
    fromDay.getTime() <= toDay.getTime() ? [fromDay, toDay] : [toDay, fromDay];
  return {
    from: lo,
    to: endOfUtcDay(hi),
    dateFromIso: toDateKey(lo),
    dateToIso: toDateKey(hi),
  };
}

function forEachDayInRange(
  from: Date,
  to: Date,
  fn: (key: string) => void,
): void {
  const start = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  for (
    let cur = new Date(start);
    cur.getTime() <= end.getTime();
    cur.setUTCDate(cur.getUTCDate() + 1)
  ) {
    fn(toDateKey(cur));
  }
}
