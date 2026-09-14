import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CompensationType,
  EntryStatus,
  OperationCategory,
  PassportEventType,
  PassportStatus,
  Prisma,
} from '@prisma/client';
import {
  type FinalizeDayResultDto,
  type PassportCostDto,
  type PassportCostSalaryLineDto,
} from '@sewing/shared/costs';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  erpMaterialCostByPassport,
  erpMaterialCostForPassport,
} from './erp-material-fact.js';
import { isSalaryEligible } from '../employees/compensation.js';
import {
  effectiveHourlyRateWithNorm,
  resolveMonthNormHours,
} from '../salary/salary-rate.js';
import { resolveShiftWorkedCapSeconds } from '../salary/shift-worked-cap.js';
import { apportionEmployeeTime } from './time-apportionment.js';
import { buildWorkIntervals, type WorkEvent } from './work-intervals.js';
import {
  clipToShiftFrames,
  loadShiftFrames,
  splitByUtcDay,
} from './shift-frame.js';
import { loadTimeNormResolver } from './operation-time-norm.js';

const MATERIAL_ISSUE_STATUS_POSTED = 'POSTED';

/** События-«accept» (точный хронометраж — только по ним). */
const ISSUE_TYPES = [PassportEventType.ISSUED_TO_EMPLOYEE];
/**
 * На сколько дней раньше окна читать accept-ы: паспорт, взятый в пятницу и
 * сданный в понедельник, в понедельничном окне без своего `ISSUE` ушёл бы в
 * нормативную ветку, хотя хронометраж по нему есть. Рамка смены всё равно
 * оставит от такого интервала только минуты внутри смен (решение
 * владельца 14.09.2026).
 */
const ISSUE_LOOKBACK_DAYS = 7;
/** События-«complete» (терминалы операций/стадий). */
const COMPLETE_TYPES = [
  PassportEventType.OPERATION_FINISHED,
  PassportEventType.QC_PASSED,
  PassportEventType.WTO_PASSED,
  PassportEventType.PACKED,
];
/**
 * Аудит движка расчёта 13.09.2026, F1-3 (ревью): границы окна для оклада
 * выпущенных паспортов считаются только по завершениям ОКЛАДНЫХ операций
 * — этих категорий либо сотрудников с окладом (`SALARY`/`MIXED`), — а не
 * по любому `OPERATION_FINISHED` швеи-сдельщицы (иначе окно уезжало к
 * первой операции самого старого паспорта, обычно к дате кроя).
 */
const SALARIED_OPERATION_CATEGORIES: OperationCategory[] = [
  OperationCategory.QC,
  OperationCategory.IRONING,
  OperationCategory.PACKING,
  OperationCategory.CUTTING,
];
/**
 * Аудит движка расчёта 13.09.2026, F1-3 (ревью): предел расширения окна
 * назад от `dateFrom` — один переоткрытый/ретро-паспорт со старым
 * событием иначе заставлял дневной отчёт и v2 разносить оклад за месяцы
 * на каждый запрос. Дальше этого горизонта оклад паспорта считается не
 * полностью, о чём отчёт предупреждает.
 */
export const APPORTION_WINDOW_MAX_BACK_DAYS = 60;

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
  /**
   * Предупреждения разноса (решение владельца 14.09.2026): сейчас — «у
   * операции не задана норма времени» для завершений без хронометража,
   * которые из-за этого учтены как 0 минут. Пусто, когда сказать нечего.
   */
  warnings: string[];
  /**
   * Паспорта, у которых завершение окладника учтено как 0 мин из-за
   * незаданной нормы: `passportId → operationId[]`. Нужно потребителям с
   * разрезом по заказу (документ план→факт), чтобы предупредить именно
   * там, где строка занижена.
   */
  missingNormByPassport: Map<string, string[]>;
}

/**
 * Фактическая себестоимость паспорта и движок разноса оклада.
 *
 *   total = материал(нетто) + сдельная(APPROVED) + распределённый оклад
 *
 * Сдельная и материал — прямые суммы по паспорту (как в `CostsService`).
 * Окладная часть — ФАКТ ВЫПОЛНЕННЫХ РАБОТ окладника, разнесённый по
 * паспортам (решение владельца 14.09.2026: «в час оклад 500 ₽, 30 минут
 * съели операции — в себестоимость 30 минут, остальное простой»). Две
 * ветки, по одной на каждый способ отметки:
 *
 *   1. ХРОНОМЕТРАЖ — операции со своим accept (`ISSUED_TO_EMPLOYEE →
 *      OPERATION_FINISHED`: швеи-окладницы, деление кроя, «ВТО оклад»).
 *      `buildWorkIntervals` строит интервал `[взяла..сдала]`,
 *      `clipToShiftFrames` оставляет от него только минуты ВНУТРИ смен
 *      сотрудника (ночь и обед на изделие не ложатся; потолка в 60 минут
 *      больше нет), `apportionEmployeeTime` делит нахлёсты между
 *      одновременно удерживаемыми паспортами.
 *   2. НОРМА × ОБЪЁМ — завершения без accept (`QC_PASSED` / `WTO_PASSED`
 *      / `PACKED`, `OPERATION_FINISHED` без своего `ISSUE`): минуты =
 *      норма времени операции (с переопределением заказа, см.
 *      `operation-time-norm.ts`) × `qty` события / 60. Норма не задана →
 *      0 минут и предупреждение в `warnings` (молчаливый ноль читался бы
 *      как «ОТК бесплатна»).
 *
 *   3. минуты × ставка/мин сотрудника (по дню, `salary-rate.ts`) = ₽
 *      оклада на паспорт. Простой = оплаченные минуты дня
 *      (`shift-presence.ts`) − разнесённые; на изделия не ложится.
 *
 * Разнос требует ПОЛНОГО потока событий сотрудника (иначе деление «1/k»
 * посчитает k неверно), поэтому события грузятся по сотруднику за всё окно
 * (accept-ы — ещё на `ISSUE_LOOKBACK_DAYS` раньше), а минуты режутся по
 * UTC-дням уже после рамки смены — простой считается по дню.
 *
 * Метод `apportionedSalaryForPeriod` переиспользуют `CostsService`
 * (дневной отчёт), `ProductionCostV2Service`, `OrderFactCostService`,
 * `DashboardService` и документ план→факт заказа.
 */
@Injectable()
export class PassportRealCostService {
  private readonly logger = new Logger(PassportRealCostService.name);

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

    // Сдельная / материал — батчем по дню. Оклад — ПО КАЖДОМУ паспорту на
    // ЕГО собственном окне завершения (как живой `salaryFor`), а НЕ на окне
    // одного дня упаковки: иначе оклад за операции / ОТК / ВТО предыдущих
    // дней теряется в FINAL-снимке (C3 — снимок занижал ЗП vs живой вид).
    const [pwRows, issues, returns, erpByPassport] = await Promise.all([
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
      // Материалы под ERP — тем же батчем, что и свои: снимок обязан совпасть с живым видом.
      erpMaterialCostByPassport(this.prisma, passportIds),
    ]);
    // Оклад по каждому паспорту на его окне завершения — совпадает с живым
    // `getForPassport` (C3). Батч-задача конца дня, N вызовов допустимы.
    const salaryByPassport = new Map<string, number>();
    await Promise.all(
      passportIds.map(async (pid) => {
        salaryByPassport.set(pid, (await this.salaryFor(pid)).totalRub);
      }),
    );
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
    for (const [pid, rub] of erpByPassport) {
      matByPassport.set(pid, (matByPassport.get(pid) ?? 0) + decimalToNumber(rub));
    }

    const now = new Date();
    let finalized = 0;
    for (const pid of passportIds) {
      const info = byPassport.get(pid)!;
      const material = info.excluded ? 0 : matByPassport.get(pid) ?? 0;
      const piecework = pwByPassport.get(pid) ?? 0;
      const salaryRub = salaryByPassport.get(pid) ?? 0;
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
    // Два источника, которые не пересекаются: свои материалы цеха (`MaterialIssue` нетто
    // возвратов) и материалы под ERP (её списание по факту выпуска — шаг 6 «тёмной лестницы»;
    // своего документа расхода у них в цехе нет).
    const [issues, returns, erp] = await Promise.all([
      this.prisma.materialIssue.aggregate({
        where: { status: MATERIAL_ISSUE_STATUS_POSTED, passportId },
        _sum: { totalCost: true },
      }),
      this.prisma.materialIssueReturn.aggregate({
        where: { status: MATERIAL_ISSUE_STATUS_POSTED, passportId },
        _sum: { totalCost: true },
      }),
      erpMaterialCostForPassport(this.prisma, passportId),
    ]);
    return (
      decimalToNumber(issues._sum.totalCost) -
      decimalToNumber(returns._sum.totalCost) +
      decimalToNumber(erp)
    );
  }

  // -------------------------------------------------------------------------
  // salary (apportioned) — общий движок для паспорта и для периода
  // -------------------------------------------------------------------------

  /**
   * Разносит оклад всех окладников, активных в окне `[from..to]`, по
   * паспортам (обе ветки — хронометраж в рамке смены и норма × объём).
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
      warnings: [],
      missingNormByPassport: new Map(),
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
        salaryRateMode: true,
        salaryPerHour: true,
        salaryPerMonth: true,
      },
    });
    // Норма часов месяца — знаменатель ₽/час у месячного окладника
    // (29.07.2026). Аудит движка расчёта 13.09.2026, F1-3 (ревью): норма
    // берётся по месяцу ДНЯ ключа `employee|day`, а не по `from` окна —
    // иначе расширенное назад окно (`apportionedSalaryForPassports`)
    // считало все сентябрьские паспорта по августовской норме, а простой
    // тех же дней — по сентябрьской. Кэш `YYYY-MM → normHours`.
    const normByMonth = new Map<string, Prisma.Decimal>();
    const normHoursFor = async (dayKey: string): Promise<Prisma.Decimal> => {
      const month = dayKey.slice(0, 7);
      const cached = normByMonth.get(month);
      if (cached) return cached;
      const norm = await resolveMonthNormHours(
        this.prisma,
        new Date(`${month}-01T12:00:00.000Z`),
      );
      normByMonth.set(month, norm);
      return norm;
    };
    const salariedById = new Map<string, (typeof employees)[number]>();
    const nameByEmployee = new Map<string, string>();
    for (const e of employees) {
      nameByEmployee.set(e.id, e.fullName);
      // Есть ли у человека ставка вообще (норма любого месяца > 0 даёт
      // положительный ₽/час ровно при заданном окладе/часовой ставке).
      const minute = computeMinuteRate(
        effectiveHourlyRateWithNorm(e, await normHoursFor(toDateKey(from))),
      );
      if (minute > 0 && isSalaryEligible(e.compensationType)) {
        salariedById.set(e.id, e);
      }
    }
    const salariedIds = candidateIds.filter((id) => salariedById.has(id));
    if (salariedIds.length === 0) return empty;
    const rateFor = async (employeeId: string, dayKey: string): Promise<number> => {
      const e = salariedById.get(employeeId);
      if (!e) return 0;
      return computeMinuteRate(
        effectiveHourlyRateWithNorm(e, await normHoursFor(dayKey)),
      );
    };

    // 2) Полный поток окладников: accept-ы — с запасом назад (паспорт,
    //    взятый до окна и сданный в окне, иначе терял бы хронометраж),
    //    завершения — строго в окне. `OPERATION_SCAN` не читаем: для ОТК/ВТО
    //    скан и «проверено» разделяет секунда (см. `work-intervals.ts`).
    const issueFrom = new Date(from.getTime() - ISSUE_LOOKBACK_DAYS * 86_400_000);
    const events = await this.prisma.passportEvent.findMany({
      where: {
        employeeId: { in: salariedIds },
        OR: [
          { type: { in: ISSUE_TYPES }, createdAt: { gte: issueFrom, lte: to } },
          { type: { in: COMPLETE_TYPES }, createdAt: { gte: from, lte: to } },
        ],
      },
      select: {
        passportId: true,
        operationId: true,
        employeeId: true,
        type: true,
        createdAt: true,
        qty: true,
        passport: { select: { orderId: true, sizeId: true, qtyGood: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (events.length === 0) return empty;

    const passportMeta = new Map<
      string,
      { orderId: string | null; sizeId: string | null; qtyGood: number }
    >();
    const byEmployee = new Map<string, WorkEvent[]>();
    for (const ev of events) {
      if (!ev.employeeId) continue;
      passportMeta.set(ev.passportId, {
        orderId: ev.passport?.orderId ?? null,
        sizeId: ev.passport?.sizeId ?? null,
        qtyGood: ev.passport?.qtyGood ?? 0,
      });
      const arr = byEmployee.get(ev.employeeId) ?? [];
      arr.push({
        passportId: ev.passportId,
        operationId: ev.operationId,
        kind: ev.type === PassportEventType.ISSUED_TO_EMPLOYEE ? 'ISSUE' : 'COMPLETE',
        atMs: ev.createdAt.getTime(),
        qty: ev.qty,
      });
      byEmployee.set(ev.employeeId, arr);
    }

    // 3) Интервалы хронометража и завершения без accept — по сотруднику.
    type Built = ReturnType<typeof buildWorkIntervals>;
    const builtByEmployee = new Map<string, Built>();
    const normPairs: { operationId: string; orderId: string | null }[] = [];
    for (const [employeeId, evs] of byEmployee) {
      const built = buildWorkIntervals(evs);
      builtByEmployee.set(employeeId, built);
      for (const u of built.unmatched) {
        if (u.operationId) {
          normPairs.push({
            operationId: u.operationId,
            orderId: passportMeta.get(u.passportId)?.orderId ?? null,
          });
        }
      }
    }
    const [frames, norms] = await Promise.all([
      loadShiftFrames(
        this.prisma,
        Array.from(byEmployee.keys()),
        issueFrom,
        to,
        await resolveShiftWorkedCapSeconds(this.prisma),
      ),
      loadTimeNormResolver(this.prisma, normPairs),
    ]);

    const rubByPassport = new Map<string, number>();
    const trackedMinutesByEmpDay = new Map<string, number>();
    const operationIds = new Set<string>();
    type RawLine = {
      operationId: string | null;
      employeeId: string;
      minutes: number;
      rub: number;
      basis: PassportCostSalaryLineDto['basis'];
      qty: number | null;
    };
    const rawByPassport = new Map<string, RawLine[]>();
    // Сырой агрегат оклада по операциям (минуты/₽), до подписей.
    const byOpRaw = new Map<string, { minutes: number; rub: number }>();
    // Завершения без нормы: операция → сколько отметок и изделий ушло в 0.
    const missingNorm = new Map<string, { events: number; qty: number }>();
    const missingNormByPassport = new Map<string, string[]>();

    const addLine = (
      passportId: string,
      dayKey: string,
      line: RawLine,
    ): void => {
      if (line.minutes <= 0) return;
      const empDayKey = `${line.employeeId}|${dayKey}`;
      trackedMinutesByEmpDay.set(
        empDayKey,
        (trackedMinutesByEmpDay.get(empDayKey) ?? 0) + line.minutes,
      );
      rubByPassport.set(passportId, (rubByPassport.get(passportId) ?? 0) + line.rub);
      if (line.operationId) {
        operationIds.add(line.operationId);
        const op = byOpRaw.get(line.operationId) ?? { minutes: 0, rub: 0 };
        op.minutes += line.minutes;
        op.rub += line.rub;
        byOpRaw.set(line.operationId, op);
      }
      const arr = rawByPassport.get(passportId) ?? [];
      arr.push(line);
      rawByPassport.set(passportId, arr);
    };

    for (const [employeeId, built] of builtByEmployee) {
      // 4) Хронометраж: рамка смены → по UTC-дням → деление нахлёстов
      //    внутри дня (границы дня — те же точки заметающей прямой, что и
      //    в общем разносе, поэтому доли паспортов не меняются).
      const clipped = clipToShiftFrames(
        built.intervals,
        frames.get(employeeId) ?? [],
      );
      const byDay = new Map<string, typeof clipped>();
      for (const piece of splitByUtcDay(clipped)) {
        const arr = byDay.get(piece.dayKey) ?? [];
        arr.push(piece);
        byDay.set(piece.dayKey, arr);
      }
      for (const [dayKey, dayIntervals] of byDay) {
        const rate = await rateFor(employeeId, dayKey);
        for (const a of apportionEmployeeTime(dayIntervals)) {
          addLine(a.passportId, dayKey, {
            operationId: a.operationId,
            employeeId,
            minutes: a.minutes,
            rub: a.minutes * rate,
            basis: 'TIMED',
            qty: null,
          });
        }
      }

      // 5) Норма × объём: завершение без accept.
      for (const u of built.unmatched) {
        const dayKey = toDateKey(new Date(u.atMs));
        const meta = passportMeta.get(u.passportId);
        const qty = u.qty ?? meta?.qtyGood ?? 0;
        const sec = u.operationId
          ? norms.secondsFor(u.operationId, meta?.orderId ?? null, meta?.sizeId ?? null)
          : null;
        if (sec === null) {
          const key = u.operationId ?? '';
          const m = missingNorm.get(key) ?? { events: 0, qty: 0 };
          m.events += 1;
          m.qty += qty;
          missingNorm.set(key, m);
          if (u.operationId) {
            const arr = missingNormByPassport.get(u.passportId) ?? [];
            if (!arr.includes(u.operationId)) arr.push(u.operationId);
            missingNormByPassport.set(u.passportId, arr);
          }
          continue;
        }
        if (qty <= 0) continue;
        const minutes = (sec * qty) / 60;
        const rate = await rateFor(employeeId, dayKey);
        addLine(u.passportId, dayKey, {
          operationId: u.operationId,
          employeeId,
          minutes,
          rub: minutes * rate,
          basis: 'NORMED',
          qty,
        });
      }
    }

    // Подписи операций.
    for (const id of missingNorm.keys()) if (id) operationIds.add(id);
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
            basis: l.basis,
            qty: l.qty,
          };
        }),
      );
    }

    const warnings: string[] = [];
    if (missingNorm.size > 0) {
      const parts: string[] = [];
      for (const [opId, m] of missingNorm) {
        const meta = opId ? opMeta.get(opId) : null;
        const label = meta ? `${meta.name} (${meta.code})` : 'операция не указана';
        parts.push(`${label}: ${m.events} отм., ${m.qty} шт.`);
      }
      const msg = `Норма времени не задана — работа окладника учтена как 0 мин: ${parts.join('; ')}. Заполните норму в справочнике операций`;
      warnings.push(msg);
      this.logger.warn(`event=costs.salary-norm-missing ${msg}`);
    }

    return {
      rubByPassport,
      linesByPassport,
      trackedMinutesByEmpDay,
      salaryByOperation,
      warnings,
      missingNormByPassport,
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
  ): Promise<ApportionedSalary> {
    return this.apportionSalary(from, to);
  }

  /**
   * Аудит движка расчёта 13.09.2026, F1-3: оклад паспортов, ВЫПУЩЕННЫХ в
   * окне отчёта, считаем на окне самих паспортов (как `salaryFor` для
   * живого паспорта и `finalizeDay` для FINAL-снимка), а не на окне
   * отчёта — иначе минуты ОТК/ВТО до `dateFrom` не попадали ни в один
   * период, а дневной отчёт расходился со снимком за тот же день.
   *
   * Батч: одно окно = окно отчёта, расширенное до самого раннего / самого
   * позднего завершения ОКЛАДНЫХ операций по этим паспортам (ревью F1-3:
   * категории `SALARIED_OPERATION_CATEGORIES` либо сотрудник с окладом —
   * `OPERATION_FINISHED` швеи-сдельщицы окно не двигает); разнос по
   * сотруднику × UTC-дню не зависит от ширины окна, поэтому суммы по
   * паспорту совпадают с `salaryFor`. Расширение назад ограничено
   * `APPORTION_WINDOW_MAX_BACK_DAYS` от `from` отчёта — дальше оклад
   * паспорта считается не полностью, и об этом говорит `warnings` (v2 и
   * дневной отчёт отдают их в своём `warnings`, плюс `warn` в лог). Если
   * расширять нечего — возвращаем уже посчитанный разнос периода без
   * второго прохода.
   */
  async apportionedSalaryForPassports(
    passportIds: string[],
    period: {
      from: Date;
      to: Date;
      result: Pick<ApportionedSalary, 'rubByPassport' | 'linesByPassport'> & {
        warnings?: string[];
      };
    },
  ): Promise<
    Pick<ApportionedSalary, 'rubByPassport' | 'linesByPassport'> & {
      warnings: string[];
    }
  > {
    // Предупреждения самого разноса (норма не задана) едут дальше и без
    // второго прохода; при втором проходе его окно шире и покрывает их.
    const periodWarnings = period.result.warnings ?? [];
    if (passportIds.length === 0) {
      return { ...period.result, warnings: [...periodWarnings] };
    }
    const span = await this.prisma.passportEvent.aggregate({
      where: {
        passportId: { in: passportIds },
        type: { in: COMPLETE_TYPES },
        employeeId: { not: null },
        OR: [
          { operation: { category: { in: SALARIED_OPERATION_CATEGORIES } } },
          {
            employee: {
              compensationType: { in: [CompensationType.SALARY, CompensationType.MIXED] },
            },
          },
        ],
      },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    const warnings: string[] = [];
    let from = period.from;
    let to = period.to;
    if (span._min.createdAt && span._min.createdAt < from) {
      const wanted = startOfUtcDay(span._min.createdAt);
      const floor = new Date(
        period.from.getTime() - APPORTION_WINDOW_MAX_BACK_DAYS * 86_400_000,
      );
      if (wanted < floor) {
        from = floor;
        const msg = `Оклад выпущенных паспортов: окно разноса ограничено ${APPORTION_WINDOW_MAX_BACK_DAYS} дн. назад от ${toDateKey(period.from)} (есть окладные события от ${toDateKey(wanted)}) — оклад таких паспортов учтён не полностью`;
        warnings.push(msg);
        this.logger.warn(`event=costs.apportion-window-capped ${msg}`);
      } else {
        from = wanted;
      }
    }
    if (span._max.createdAt && span._max.createdAt > to) {
      to = endOfUtcDay(span._max.createdAt);
    }
    if (
      from.getTime() === period.from.getTime() &&
      to.getTime() === period.to.getTime()
    ) {
      return { ...period.result, warnings: [...periodWarnings, ...warnings] };
    }
    const second = await this.apportionSalary(from, to);
    return {
      rubByPassport: second.rubByPassport,
      linesByPassport: second.linesByPassport,
      warnings: [...warnings, ...second.warnings],
    };
  }

  /**
   * Разнесённый оклад по паспортам ОДНОГО заказа — для документа
   * план→факт (решение владельца 14.09.2026: у окладных операций факт в
   * документе был всегда 0, они не пишут `OperationEntry`). Окно — от
   * первого до последнего завершения окладных операций по паспортам заказа
   * (как `salaryFor` у одного паспорта); разнос идёт по всему цеху, чтобы
   * деление нахлёстов было честным, а наружу отдаются только строки этого
   * заказа.
   */
  async apportionedSalaryForOrder(orderId: string): Promise<{
    linesByPassport: Map<string, PassportCostSalaryLineDto[]>;
    /** Паспорта заказа с завершениями без нормы: `passportId → operationId[]`. */
    missingNormByPassport: Map<string, string[]>;
  }> {
    const empty = {
      linesByPassport: new Map<string, PassportCostSalaryLineDto[]>(),
      missingNormByPassport: new Map<string, string[]>(),
    };
    const passports = await this.prisma.passport.findMany({
      where: { orderId },
      select: { id: true },
    });
    if (passports.length === 0) return empty;
    const passportIds = passports.map((p) => p.id);
    const span = await this.prisma.passportEvent.aggregate({
      where: {
        passportId: { in: passportIds },
        type: { in: COMPLETE_TYPES },
        employeeId: { not: null },
        OR: [
          { operation: { category: { in: SALARIED_OPERATION_CATEGORIES } } },
          {
            employee: {
              compensationType: { in: [CompensationType.SALARY, CompensationType.MIXED] },
            },
          },
        ],
      },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    if (!span._min.createdAt || !span._max.createdAt) return empty;
    const all = await this.apportionSalary(
      startOfUtcDay(span._min.createdAt),
      endOfUtcDay(span._max.createdAt),
    );
    const own = new Set(passportIds);
    const linesByPassport = new Map<string, PassportCostSalaryLineDto[]>();
    for (const [pid, lines] of all.linesByPassport) {
      if (own.has(pid)) linesByPassport.set(pid, lines);
    }
    const missingNormByPassport = new Map<string, string[]>();
    for (const [pid, ops] of all.missingNormByPassport) {
      if (own.has(pid)) missingNormByPassport.set(pid, ops);
    }
    return { linesByPassport, missingNormByPassport };
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

/**
 * ₽/минуту оклада для разноса на паспорт. Источник — почасовая ставка
 * `Employee.salaryPerHour` (повременка): минута = ставка/час ÷ 60.
 * При бэкфилле `salaryPerHour = salaryPerShift / 8` (SHIFT_MINUTES =
 * 480) численно совпадает с прежним `salaryPerShift / SHIFT_MINUTES`.
 */
function computeMinuteRate(
  ratePerHour: Prisma.Decimal | null | undefined,
): number {
  if (ratePerHour === null || ratePerHour === undefined) return 0;
  const num = decimalToNumber(ratePerHour);
  if (num <= 0) return 0;
  return num / 60;
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
