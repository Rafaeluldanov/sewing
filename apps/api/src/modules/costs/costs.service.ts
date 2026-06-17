import { Injectable } from '@nestjs/common';
import { EntryStatus, PassportEventType, Prisma } from '@prisma/client';
import {
  SHIFT_MINUTES,
  type ProductionCostDayDto,
  type ProductionCostQuery,
  type ProductionCostResponseDto,
  type ProductionCostSummaryDto,
} from '@sewing/shared/costs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { isSalaryEligible } from '../employees/compensation.js';
import { PassportRealCostService } from './passport-real-cost.service.js';

/**
 * `MaterialIssue.status` для проведённого документа фактического
 * расхода материалов. Сознательно не импортируем из
 * `modules/material-issues/material-issues.service.ts`, чтобы не
 * затаскивать в costs-модуль зависимость от соседнего модуля и
 * не создавать риск циклического импорта (`MaterialIssuesModule`
 * сам уже зависит от `AuditModule`).
 *
 * Список валидируется shared-Zod (`MATERIAL_ISSUE_STATUSES`), а в
 * БД статус хранится строкой — расширение списка не требует
 * миграции (см. `prisma/schema.prisma::MaterialIssue.status`,
 * `packages/shared/src/material-issues.ts`).
 */
const MATERIAL_ISSUE_STATUS_POSTED = 'POSTED';

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
 *                       durationMinutes × employee.minuteRate;
 *        material  = Σ `MaterialIssue.totalCost` − Σ
 *                    `MaterialIssueReturn.totalCost` по POSTED-документам
 *                    с `passportId === passport.id` (фактический
 *                    расход материалов нетто, см.
 *                    `apps/api/src/modules/material-issues/*`,
 *                    `docs/api.md §«Material issues»`,
 *                    `prisma/schema.prisma::MaterialIssueReturn`).
 *                    DRAFT / CANCELLED не учитываем; order-level
 *                    документы без `passportId` сознательно НЕ
 *                    включаем — без привязки к паспорту нельзя
 *                    корректно разнести расход по дню выпуска
 *                    (см. ТЗ итерации). Возвраты `MaterialIssueReturn`
 *                    (POSTED) вычитаются: вернувшийся на склад
 *                    материал не должен оставаться в себестоимости
 *                    дня упаковки.
 *      Cap длительности — в `PassportDurationsService`.
 *
 *   3. День агрегата = дата `PACKED` event паспорта (UTC). И
 *      piecework, и salary, и material попадают в один и тот же
 *      день (день упаковки этого паспорта).
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
    private readonly passportRealCost: PassportRealCostService,
  ) {}

  async getProductionCost(
    query: ProductionCostQuery,
  ): Promise<ProductionCostResponseDto> {
    const { from, to, dateFromIso, dateToIso } = resolvePeriod(query);

    // 1) Разнос оклада по паспортам + учтённые минуты по сотруднику×дню.
    //    Источник — реальные интервалы `ISSUED_TO_EMPLOYEE →
    //    OPERATION_FINISHED` с делением нахлёстов (см.
    //    `PassportRealCostService.apportionedSalaryForPeriod`), а не
    //    `OPERATION_SCAN` (которого в реальном флоу нет). Это покрывает
    //    все окладные операции: ОТК/ВТО/упаковку/деление кроя/настил.
    const salary = await this.passportRealCost.apportionedSalaryForPeriod(
      from,
      to,
    );

    // 2) Подгружаем `employee.salaryPerShift` для расчёта простоя:
    //    сотрудники с окладным начислением (`SalaryEntry`) за этот день.
    const employeeIdsFromStages = new Set<string>();
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
      if (minute > 0 && isSalaryEligible(e.compensationType)) {
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

    // 5a) Фактический расход материалов по паспортам периода (нетто).
    //     Берём только POSTED-документы с `passportId` из выборки —
    //     DRAFT / CANCELLED и order-level документы (без `passportId`)
    //     в production cost по периоду НЕ попадают (см. шапку файла
    //     и ТЗ итерации).
    //
    //     Нетто-расход = `Σ MaterialIssue.totalCost − Σ MaterialIssueReturn.totalCost`
    //     для тех же `passportId`. Возвраты (`MaterialIssueReturn`,
    //     status `POSTED`, см.
    //     `prisma/schema.prisma::MaterialIssueReturn`,
    //     `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`)
    //     уменьшают material cost дня упаковки паспорта — иначе
    //     возврат материала остался бы виден в себестоимости.
    //
    //     Возврат гарантированно несёт `passportId` исходного
    //     `MaterialIssue` (сервис копирует поле при создании
    //     `MaterialIssueReturn`), поэтому фильтр по `passportId in
    //     passportIds` отбирает ровно те же возвраты, что и
    //     соответствующие исходные расходы. `totalCost` берём с
    //     backend (`MaterialIssueReturn.totalCost`) — server-side
    //     агрегат, пересчитывать не нужно.
    //
    // Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
    // `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
    // `docs/current-state.md §«Давальческое сырьё клиента»`).
    // Если у заказа паспорта политика `EXCLUDE`, materialCost этого
    // паспорта = 0. piecework / salary остаются как раньше — это
    // компания заплатила своим людям. MaterialIssue / MaterialIssueReturn
    // в БД при этом не меняются — это исключительно cost-aggregation.
    const excludedPassportIds = new Set<string>();
    if (passportIds.length > 0) {
      const passportsWithPolicy = await this.prisma.passport.findMany({
        where: { id: { in: passportIds } },
        select: {
          id: true,
          order: { select: { materialsAndHardwareCostPolicy: true } },
        },
      });
      for (const p of passportsWithPolicy) {
        if (p.order?.materialsAndHardwareCostPolicy === 'EXCLUDE') {
          excludedPassportIds.add(p.id);
        }
      }
    }
    const materialCostByPassport = new Map<string, number>();
    if (passportIds.length > 0) {
      const [issues, returns] = await Promise.all([
        this.prisma.materialIssue.findMany({
          where: {
            status: MATERIAL_ISSUE_STATUS_POSTED,
            passportId: { in: passportIds },
          },
          select: { passportId: true, totalCost: true },
        }),
        this.prisma.materialIssueReturn.findMany({
          where: {
            status: MATERIAL_ISSUE_STATUS_POSTED,
            passportId: { in: passportIds },
          },
          select: { passportId: true, totalCost: true },
        }),
      ]);
      for (const issue of issues) {
        if (!issue.passportId) continue;
        if (excludedPassportIds.has(issue.passportId)) continue;
        const prev = materialCostByPassport.get(issue.passportId) ?? 0;
        materialCostByPassport.set(
          issue.passportId,
          prev + decimalToNumber(issue.totalCost),
        );
      }
      for (const ret of returns) {
        if (!ret.passportId) continue;
        if (excludedPassportIds.has(ret.passportId)) continue;
        const prev = materialCostByPassport.get(ret.passportId) ?? 0;
        materialCostByPassport.set(
          ret.passportId,
          prev - decimalToNumber(ret.totalCost),
        );
      }
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
      day.salaryCost += salary.rubByPassport.get(ev.passportId) ?? 0;
      day.materialCost += materialCostByPassport.get(ev.passportId) ?? 0;
    }

    // 7) Учтённые (разнесённые) минуты по сотруднику×дню — для простоя.
    for (const [key, minutes] of salary.trackedMinutesByEmpDay) {
      const sep = key.lastIndexOf('|');
      const employeeId = key.slice(0, sep);
      const dayKey = key.slice(sep + 1);
      const day = ensureDay(dayMap, dayKey);
      day.trackedMinutes += minutes;
      day.trackedByEmployee.set(
        employeeId,
        (day.trackedByEmployee.get(employeeId) ?? 0) + minutes,
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
  /**
   * Σ `MaterialIssue.totalCost` (POSTED) по паспортам, упакованным
   * в этот день. См. шапку `CostsService` и шаг 5a.
   */
  materialCost: number;
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
      materialCost: 0,
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
  const mat = round2(d.materialCost);
  return {
    date: d.date,
    producedUnits: d.producedUnits,
    pieceworkCost: piece,
    salaryCost: sal,
    materialCost: mat,
    totalCost: round2(piece + sal + mat),
    // Разнесённые минуты дробные — для экрана округляем до целых.
    trackedMinutes: Math.round(d.trackedMinutes),
    idleMinutes: Math.round(d.idleMinutes),
    idleCost: round2(d.idleCost),
  };
}

function computeSummary(
  days: ProductionCostDayDto[],
): ProductionCostSummaryDto {
  let producedUnits = 0;
  let pieceworkCost = 0;
  let salaryCost = 0;
  let materialCost = 0;
  let idleCost = 0;
  let trackedMinutes = 0;
  let idleMinutes = 0;
  for (const d of days) {
    producedUnits += d.producedUnits;
    pieceworkCost += d.pieceworkCost;
    salaryCost += d.salaryCost;
    materialCost += d.materialCost;
    idleCost += d.idleCost;
    trackedMinutes += d.trackedMinutes;
    idleMinutes += d.idleMinutes;
  }
  const totalCost = round2(pieceworkCost + salaryCost + materialCost);
  const avgCostPerUnit =
    producedUnits > 0 ? round2(totalCost / producedUnits) : 0;
  return {
    producedUnits,
    pieceworkCost: round2(pieceworkCost),
    salaryCost: round2(salaryCost),
    materialCost: round2(materialCost),
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
