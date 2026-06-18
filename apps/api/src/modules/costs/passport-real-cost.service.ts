import { Injectable, NotFoundException } from '@nestjs/common';
import {
  EntryStatus,
  PassportEventType,
  PassportStatus,
  Prisma,
} from '@prisma/client';
import {
  MAX_STAGE_MINUTES_PER_PASSPORT,
  SHIFT_MINUTES,
  type FinalizeDayResultDto,
  type PassportCostDto,
  type PassportCostSalaryLineDto,
} from '@sewing/shared/costs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { isSalaryEligible } from '../employees/compensation.js';
import {
  apportionEmployeeTime,
} from './time-apportionment.js';
import { buildWorkIntervals, type WorkEvent } from './work-intervals.js';

const MATERIAL_ISSUE_STATUS_POSTED = 'POSTED';
const CAP_MS = MAX_STAGE_MINUTES_PER_PASSPORT * 60_000;
const MIN_MS = 60_000; // минимальный учитываемый интервал = 1 минута

/** События-«accept». */
const ISSUE_TYPES = [PassportEventType.ISSUED_TO_EMPLOYEE];
/** События-«complete» (терминалы операций/стадий). */
const COMPLETE_TYPES = [
  PassportEventType.OPERATION_FINISHED,
  PassportEventType.QC_PASSED,
  PassportEventType.WTO_PASSED,
  PassportEventType.PACKED,
];

/** Агрегат разноса оклада за окно. */
export interface ApportionedSalary {
  /** ₽ оклада по паспортам (сумма по всем окладникам/операциям). */
  rubByPassport: Map<string, number>;
  /** Детализация по паспортам (операция × сотрудник × минуты × ₽). */
  linesByPassport: Map<string, PassportCostSalaryLineDto[]>;
  /** Учтённые (разнесённые) минуты по ключу `${employeeId}|${YYYY-MM-DD}`. */
  trackedMinutesByEmpDay: Map<string, number>;
  /**
   * Агрегат разнесённого оклада ПО ОПЕРАЦИЯМ за окно (для таблицы
   * операций отчёта «Себестоимость»). Ключ — `operationId`; операции без
   * `operationId` (теоретические старые события) не агрегируются.
   */
  salaryByOperation: Map<
    string,
    {
      operationName: string;
      operationCategory: string;
      minutes: number;
      rub: number;
    }
  >;
}

/**
 * Фактическая себестоимость паспорта и движок разноса оклада.
 *
 *   total = материал(нетто) + сдельная(APPROVED) + распределённый оклад
 *
 * Сдельная и материал — прямые суммы по паспорту (как в `CostsService`).
 * Окладная часть — реальное время окладников, разнесённое по паспортам:
 *   1. `buildWorkIntervals` строит интервалы `[accept..complete]` из
 *      событий сотрудника (точный ISSUE→FINISHED либо фолбэк по разрыву
 *      для ОТК/ВТО/упаковки), capped `MAX_STAGE_MINUTES_PER_PASSPORT`;
 *   2. `apportionEmployeeTime` делит нахлёсты между одновременно
 *      удерживаемыми паспортами;
 *   3. минуты × (`salaryPerShift` / `SHIFT_MINUTES`) = ₽ оклада на паспорт.
 *
 * Разнос требует ПОЛНОГО потока событий сотрудника за день (иначе деление
 * «1/k» посчитает k неверно), поэтому события грузятся по сотруднику за
 * всё окно, обработка — по сотруднику × UTC-дню (cap рвёт ночные разрывы).
 *
 * Метод `apportionedSalaryForPeriod` переиспользует `CostsService` для
 * дневного отчёта «Себестоимость выпуска».
 */
@Injectable()
export class PassportRealCostService {
  constructor(private readonly prisma: PrismaService) {}

  async getForPassport(passportId: string): Promise<PassportCostDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      select: {
        id: true,
        number: true,
        qtyGood: true,
        product: { select: { name: true } },
        size: { select: { code: true } },
        order: { select: { materialsAndHardwareCostPolicy: true } },
      },
    });
    if (!passport) {
      throw new NotFoundException('Паспорт не найден');
    }

    const [pieceworkCost, materialCost, salary] = await Promise.all([
      this.pieceworkFor(passportId),
      this.materialFor(
        passportId,
        passport.order?.materialsAndHardwareCostPolicy === 'EXCLUDE',
      ),
      this.salaryFor(passportId),
    ]);

    const liveTotal = round2(materialCost + pieceworkCost + salary.totalRub);
    const qtyGood = passport.qtyGood ?? 0;

    // Если есть финализированный снимок — отдаём застывшие суммы
    // (стабильно/аудируемо); детализацию окладной части показываем live.
    const snapshot = await this.prisma.passportCostSnapshot.findUnique({
      where: { passportId },
      select: {
        status: true,
        materialCostRub: true,
        pieceworkCostRub: true,
        salaryCostRub: true,
        totalCostRub: true,
        perUnitCostRub: true,
        finalizedAt: true,
      },
    });
    const isFinal = snapshot?.status === 'FINAL';

    return {
      passportId: passport.id,
      passportNumber: passport.number,
      productName: passport.product?.name ?? null,
      sizeCode: passport.size?.code ?? null,
      qtyGood,
      materialCost:
        isFinal && snapshot
          ? decimalToNumber(snapshot.materialCostRub)
          : round2(materialCost),
      pieceworkCost:
        isFinal && snapshot
          ? decimalToNumber(snapshot.pieceworkCostRub)
          : round2(pieceworkCost),
      salaryCost:
        isFinal && snapshot
          ? decimalToNumber(snapshot.salaryCostRub)
          : round2(salary.totalRub),
      totalCost:
        isFinal && snapshot ? decimalToNumber(snapshot.totalCostRub) : liveTotal,
      perUnitCost:
        isFinal && snapshot
          ? decimalToNumber(snapshot.perUnitCostRub)
          : qtyGood > 0
            ? round2(liveTotal / qtyGood)
            : 0,
      salaryLines: salary.lines,
      isFinal,
      finalizedAt:
        isFinal && snapshot?.finalizedAt
          ? snapshot.finalizedAt.toISOString()
          : null,
    };
  }

  /**
   * Финализация себестоимости за UTC-день `[from..to]`: пересчитывает все
   * паспорта, упакованные в этот день (когда разнос оклада упаковщика уже
   * полный), и пишет `FINAL`-снимки. Идемпотентна — повторный вызов
   * перезаписывает снимки. Запускается планировщиком/менеджером после
   * закрытия дня.
   */
  async finalizeDay(from: Date, to: Date): Promise<FinalizeDayResultDto> {
    const date = toDateKey(from);

    // Паспорта, упакованные в окне и СЕЙЧАС в статусе PACKED.
    const packed = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.PACKED,
        createdAt: { gte: from, lte: to },
        passport: { status: PassportStatus.PACKED },
      },
      select: {
        passportId: true,
        createdAt: true,
        passport: {
          select: {
            qtyGood: true,
            order: { select: { materialsAndHardwareCostPolicy: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const byPassport = new Map<
      string,
      { packedAt: Date; qtyGood: number; excluded: boolean }
    >();
    for (const e of packed) {
      if (byPassport.has(e.passportId)) continue;
      byPassport.set(e.passportId, {
        packedAt: e.createdAt,
        qtyGood: e.passport.qtyGood ?? 0,
        excluded:
          e.passport.order?.materialsAndHardwareCostPolicy === 'EXCLUDE',
      });
    }
    const passportIds = Array.from(byPassport.keys());
    if (passportIds.length === 0) return { date, finalized: 0 };

    // Разнос оклада за день (полный, день закрыт) + батч сдельной/материала.
    const [{ rubByPassport }, pwRows, issues, returns] = await Promise.all([
      this.apportionSalary(from, to),
      this.prisma.operationEntry.groupBy({
        by: ['passportId'],
        where: { passportId: { in: passportIds }, status: EntryStatus.APPROVED },
        _sum: { amount: true },
      }),
      this.prisma.materialIssue.groupBy({
        by: ['passportId'],
        where: { status: MATERIAL_ISSUE_STATUS_POSTED, passportId: { in: passportIds } },
        _sum: { totalCost: true },
      }),
      this.prisma.materialIssueReturn.groupBy({
        by: ['passportId'],
        where: { status: MATERIAL_ISSUE_STATUS_POSTED, passportId: { in: passportIds } },
        _sum: { totalCost: true },
      }),
    ]);
    const pwByPassport = new Map<string, number>();
    for (const r of pwRows) {
      if (r.passportId) pwByPassport.set(r.passportId, decimalToNumber(r._sum.amount));
    }
    const matByPassport = new Map<string, number>();
    for (const r of issues) {
      if (r.passportId) {
        matByPassport.set(
          r.passportId,
          (matByPassport.get(r.passportId) ?? 0) + decimalToNumber(r._sum.totalCost),
        );
      }
    }
    for (const r of returns) {
      if (r.passportId) {
        matByPassport.set(
          r.passportId,
          (matByPassport.get(r.passportId) ?? 0) - decimalToNumber(r._sum.totalCost),
        );
      }
    }

    const now = new Date();
    let finalized = 0;
    for (const pid of passportIds) {
      const info = byPassport.get(pid)!;
      const material = info.excluded ? 0 : matByPassport.get(pid) ?? 0;
      const piecework = pwByPassport.get(pid) ?? 0;
      const salaryRub = rubByPassport.get(pid) ?? 0;
      const total = round2(material + piecework + salaryRub);
      const perUnit = info.qtyGood > 0 ? round2(total / info.qtyGood) : 0;
      const fields = {
        qtyGood: info.qtyGood,
        materialCostRub: new Prisma.Decimal(round2(material)),
        pieceworkCostRub: new Prisma.Decimal(round2(piecework)),
        salaryCostRub: new Prisma.Decimal(round2(salaryRub)),
        totalCostRub: new Prisma.Decimal(total),
        perUnitCostRub: new Prisma.Decimal(perUnit),
        status: 'FINAL',
        packedDate: startOfUtcDay(info.packedAt),
        computedAt: now,
        finalizedAt: now,
      };
      await this.prisma.passportCostSnapshot.upsert({
        where: { passportId: pid },
        create: { passportId: pid, ...fields },
        update: fields,
      });
      finalized += 1;
    }
    return { date, finalized };
  }

  // -------------------------------------------------------------------------
  // piecework / material
  // -------------------------------------------------------------------------

  private async pieceworkFor(passportId: string): Promise<number> {
    const agg = await this.prisma.operationEntry.aggregate({
      where: { passportId, status: EntryStatus.APPROVED },
      _sum: { amount: true },
    });
    return decimalToNumber(agg._sum.amount);
  }

  private async materialFor(
    passportId: string,
    excluded: boolean,
  ): Promise<number> {
    if (excluded) return 0;
    const [issues, returns] = await Promise.all([
      this.prisma.materialIssue.aggregate({
        where: { status: MATERIAL_ISSUE_STATUS_POSTED, passportId },
        _sum: { totalCost: true },
      }),
      this.prisma.materialIssueReturn.aggregate({
        where: { status: MATERIAL_ISSUE_STATUS_POSTED, passportId },
        _sum: { totalCost: true },
      }),
    ]);
    return (
      decimalToNumber(issues._sum.totalCost) -
      decimalToNumber(returns._sum.totalCost)
    );
  }

  // -------------------------------------------------------------------------
  // salary (apportioned) — общий движок для паспорта и для периода
  // -------------------------------------------------------------------------

  /**
   * Разносит оклад всех окладников, активных в окне `[from..to]`, по
   * паспортам. Обработка идёт по сотруднику × UTC-дню.
   */
  private async apportionSalary(
    from: Date,
    to: Date,
  ): Promise<ApportionedSalary> {
    const empty: ApportionedSalary = {
      rubByPassport: new Map(),
      linesByPassport: new Map(),
      trackedMinutesByEmpDay: new Map(),
      salaryByOperation: new Map(),
    };

    // 1) Кандидаты — исполнители терминальных событий в окне.
    const completes = await this.prisma.passportEvent.findMany({
      where: {
        type: { in: COMPLETE_TYPES },
        employeeId: { not: null },
        createdAt: { gte: from, lte: to },
      },
      select: { employeeId: true },
    });
    const candidateIds = Array.from(
      new Set(
        completes
          .map((e) => e.employeeId)
          .filter((x): x is string => x !== null),
      ),
    );
    if (candidateIds.length === 0) return empty;

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: candidateIds } },
      select: {
        id: true,
        fullName: true,
        compensationType: true,
        salaryPerShift: true,
      },
    });
    const rateByEmployee = new Map<string, number>();
    const nameByEmployee = new Map<string, string>();
    for (const e of employees) {
      nameByEmployee.set(e.id, e.fullName);
      const minute = computeMinuteRate(e.salaryPerShift);
      if (minute > 0 && isSalaryEligible(e.compensationType)) {
        rateByEmployee.set(e.id, minute);
      }
    }
    const salariedIds = candidateIds.filter((id) => rateByEmployee.has(id));
    if (salariedIds.length === 0) return empty;

    // 2) Полный поток ISSUE/COMPLETE окладников в окне.
    const events = await this.prisma.passportEvent.findMany({
      where: {
        employeeId: { in: salariedIds },
        type: { in: [...ISSUE_TYPES, ...COMPLETE_TYPES] },
        createdAt: { gte: from, lte: to },
      },
      select: {
        passportId: true,
        operationId: true,
        employeeId: true,
        type: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // emp×day -> события.
    const byEmpDay = new Map<string, WorkEvent[]>();
    for (const ev of events) {
      if (!ev.employeeId) continue;
      const kind =
        ev.type === PassportEventType.ISSUED_TO_EMPLOYEE ? 'ISSUE' : 'COMPLETE';
      const key = `${ev.employeeId}|${toDateKey(ev.createdAt)}`;
      const arr = byEmpDay.get(key) ?? [];
      arr.push({
        passportId: ev.passportId,
        operationId: ev.operationId,
        kind,
        atMs: ev.createdAt.getTime(),
      });
      byEmpDay.set(key, arr);
    }

    const rubByPassport = new Map<string, number>();
    const trackedMinutesByEmpDay = new Map<string, number>();
    const operationIds = new Set<string>();
    const rawByPassport = new Map<
      string,
      Array<{
        operationId: string | null;
        employeeId: string;
        minutes: number;
        rub: number;
      }>
    >();
    // Сырой агрегат оклада по операциям (минуты/₽), до подписей.
    const byOpRaw = new Map<string, { minutes: number; rub: number }>();

    for (const [key, dayEvents] of byEmpDay) {
      const employeeId = key.slice(0, key.lastIndexOf('|'));
      const rate = rateByEmployee.get(employeeId) ?? 0;
      const intervals = buildWorkIntervals(dayEvents, {
        capMs: CAP_MS,
        minMs: MIN_MS,
      });
      const apportioned = apportionEmployeeTime(intervals);
      let trackedThisEmpDay = 0;
      for (const a of apportioned) {
        if (a.minutes <= 0) continue;
        trackedThisEmpDay += a.minutes;
        const rub = a.minutes * rate;
        rubByPassport.set(
          a.passportId,
          (rubByPassport.get(a.passportId) ?? 0) + rub,
        );
        if (a.operationId) {
          operationIds.add(a.operationId);
          const op = byOpRaw.get(a.operationId) ?? { minutes: 0, rub: 0 };
          op.minutes += a.minutes;
          op.rub += rub;
          byOpRaw.set(a.operationId, op);
        }
        const arr = rawByPassport.get(a.passportId) ?? [];
        arr.push({ operationId: a.operationId, employeeId, minutes: a.minutes, rub });
        rawByPassport.set(a.passportId, arr);
      }
      trackedMinutesByEmpDay.set(
        key,
        (trackedMinutesByEmpDay.get(key) ?? 0) + trackedThisEmpDay,
      );
    }

    // Подписи операций.
    const opMeta = new Map<
      string,
      { code: string; name: string; category: string }
    >();
    if (operationIds.size > 0) {
      const ops = await this.prisma.operation.findMany({
        where: { id: { in: Array.from(operationIds) } },
        select: { id: true, code: true, name: true, category: true },
      });
      for (const o of ops) {
        opMeta.set(o.id, { code: o.code, name: o.name, category: o.category });
      }
    }
    const salaryByOperation: ApportionedSalary['salaryByOperation'] = new Map();
    for (const [opId, agg] of byOpRaw) {
      const meta = opMeta.get(opId);
      salaryByOperation.set(opId, {
        operationName: meta?.name ?? opId,
        operationCategory: meta?.category ?? '',
        minutes: round1(agg.minutes),
        rub: round2(agg.rub),
      });
    }
    const linesByPassport = new Map<string, PassportCostSalaryLineDto[]>();
    for (const [pid, raws] of rawByPassport) {
      linesByPassport.set(
        pid,
        raws.map((l) => {
          const meta = l.operationId ? opMeta.get(l.operationId) ?? null : null;
          return {
            operationId: l.operationId,
            operationCode: meta?.code ?? null,
            operationName: meta?.name ?? null,
            employeeId: l.employeeId,
            employeeName: nameByEmployee.get(l.employeeId) ?? l.employeeId,
            minutes: round1(l.minutes),
            rub: round2(l.rub),
          };
        }),
      );
    }

    return {
      rubByPassport,
      linesByPassport,
      trackedMinutesByEmpDay,
      salaryByOperation,
    };
  }

  /**
   * Разнос оклада за период — для дневного отчёта (`CostsService`).
   * Возвращает ₽ оклада по паспортам и учтённые минуты по сотруднику×дню
   * (для расчёта простоя).
   */
  async apportionedSalaryForPeriod(
    from: Date,
    to: Date,
  ): Promise<
    Pick<
      ApportionedSalary,
      | 'rubByPassport'
      | 'linesByPassport'
      | 'trackedMinutesByEmpDay'
      | 'salaryByOperation'
    >
  > {
    const {
      rubByPassport,
      linesByPassport,
      trackedMinutesByEmpDay,
      salaryByOperation,
    } = await this.apportionSalary(from, to);
    return {
      rubByPassport,
      linesByPassport,
      trackedMinutesByEmpDay,
      salaryByOperation,
    };
  }

  private async salaryFor(
    passportId: string,
  ): Promise<{ totalRub: number; lines: PassportCostSalaryLineDto[] }> {
    // Окно дней обработки ЭТОГО паспорта окладниками.
    const completionsHere = await this.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: { in: COMPLETE_TYPES },
        employeeId: { not: null },
      },
      select: { createdAt: true },
    });
    if (completionsHere.length === 0) return { totalRub: 0, lines: [] };
    let minAt = completionsHere[0].createdAt;
    let maxAt = completionsHere[0].createdAt;
    for (const e of completionsHere) {
      if (e.createdAt < minAt) minAt = e.createdAt;
      if (e.createdAt > maxAt) maxAt = e.createdAt;
    }
    const { rubByPassport, linesByPassport } = await this.apportionSalary(
      startOfUtcDay(minAt),
      endOfUtcDay(maxAt),
    );
    return {
      totalRub: rubByPassport.get(passportId) ?? 0,
      lines: linesByPassport.get(passportId) ?? [],
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
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
