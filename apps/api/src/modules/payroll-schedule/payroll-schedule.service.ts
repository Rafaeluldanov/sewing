import { Injectable, Logger } from '@nestjs/common';
import { EarningSource, PayrollPayoutStatus, Prisma } from '@prisma/client';
import {
  ORDER_STATUS_LABELS,
  type OrderStatus,
} from '@sewing/shared/orders';
import {
  accrualPeriodFor,
  daysBetweenIso,
  isAccrualDate,
  upcomingAccrualDates,
  type PayrollAccrualPreviewDto,
  type PayrollAccrualScheduleDto,
  type PayrollCutoffBasis,
  type PayrollDeferredEmployeeDto,
  type PayrollDeferredOrderDto,
  type UpdatePayrollAccrualScheduleDto,
} from '@sewing/shared/payroll-schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { moscowDayKey, moscowDayWindow } from '../../common/moscow-date.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PayrollAccrualDocumentsService } from '../payroll-accrual-documents/payroll-accrual-documents.service.js';
import {
  passesAccrualCutoff,
  pieceworkCandidateWhere,
  type AccrualCutoffRules,
} from './accrual-cutoff.js';

/** id singleton-строки настройки. */
const SCHEDULE_ID = 'default';

/**
 * Сервис «Расписание начисления зарплаты».
 *
 * Три обязанности:
 *
 * 1. `get` / `update` — singleton-настройка: дни месяца, правило
 *    отсечки, охват и автосоздание черновика. Правка идёт в аудит:
 *    настройка напрямую решает, попадут ли деньги человека в ближайшую
 *    выплату.
 *
 * 2. `preview` — «что войдёт и что отложено» на дату начисления. Тот
 *    же отбор, что делает документ (общий helper `accrual-cutoff.ts`),
 *    но без записи: менеджер видит отложенную сумму ДО того, как
 *    сформирует документ, а не после.
 *
 * 3. `ensureDueDraft` — ленивое автосоздание черновика в день
 *    начисления. Планировщика (`@nestjs/schedule`) в проекте нет, и
 *    заводить его ради одной задачи в сутки означало бы новую
 *    зависимость в контейнерах; вместо этого проверку дёргает сам
 *    экран зарплаты при заходе. Для менеджера разницы нет — черновик
 *    ждёт его в первый же визит после даты, — а инфраструктура не
 *    прирастает.
 */
@Injectable()
export class PayrollScheduleService {
  private readonly logger = new Logger(PayrollScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: PayrollAccrualDocumentsService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  /**
   * Настройка расписания. Строка создаётся миграцией, но `upsert`
   * оставлен как страховка для баз, накатанных иначе (тенант, seed):
   * отсутствие строки не должно ронять экран зарплаты.
   */
  async load(
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{
    daysOfMonth: number[];
    cutoffBasis: PayrollCutoffBasis;
    appliesToSewing: boolean;
    appliesToCutting: boolean;
    autoCreateDraft: boolean;
    runAtLocalTime: string;
    lastRunOn: Date | null;
    updatedAt: Date;
    updatedByEmployeeId: string | null;
  }> {
    const row = await tx.payrollAccrualSchedule.findUnique({
      where: { id: SCHEDULE_ID },
    });
    if (row) return row as never;
    return tx.payrollAccrualSchedule.create({
      data: { id: SCHEDULE_ID },
    }) as never;
  }

  async get(): Promise<PayrollAccrualScheduleDto> {
    const row = await this.load();
    const editor = row.updatedByEmployeeId
      ? await this.prisma.employee.findUnique({
          where: { id: row.updatedByEmployeeId },
          select: { fullName: true },
        })
      : null;
    return this.toDto(row, editor?.fullName ?? null);
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async update(
    dto: UpdatePayrollAccrualScheduleDto,
    viewer: AuthPrincipal,
  ): Promise<PayrollAccrualScheduleDto> {
    const before = await this.load();

    const row = await this.prisma.payrollAccrualSchedule.upsert({
      where: { id: SCHEDULE_ID },
      create: { id: SCHEDULE_ID, ...dto, updatedByEmployeeId: viewer.employeeId },
      update: { ...dto, updatedByEmployeeId: viewer.employeeId },
    });

    await this.audit.log({
      event: 'PAYROLL_SCHEDULE_UPDATED',
      entityType: 'PayrollAccrualSchedule',
      entityId: SCHEDULE_ID,
      employeeId: viewer.employeeId,
      payload: {
        before: {
          daysOfMonth: before.daysOfMonth,
          cutoffBasis: before.cutoffBasis,
          appliesToSewing: before.appliesToSewing,
          appliesToCutting: before.appliesToCutting,
          autoCreateDraft: before.autoCreateDraft,
          runAtLocalTime: before.runAtLocalTime,
        },
        after: dto,
      },
    });

    const editor = viewer.employeeId
      ? await this.prisma.employee.findUnique({
          where: { id: viewer.employeeId },
          select: { fullName: true },
        })
      : null;
    return this.toDto(row, editor?.fullName ?? null);
  }

  // ===========================================================================
  // PREVIEW
  // ===========================================================================

  /**
   * Что войдёт в документ на дату `accrualDateIso` (по умолчанию —
   * ближайшая дата начисления, а если расписание выключено — сегодня)
   * и что останется отложенным.
   *
   * Кандидаты грузятся ОДНИМ запросом и делятся в памяти
   * (`passesAccrualCutoff`), а не двумя симметричными запросами: два
   * запроса с инвертированными условиями расходятся при первой же
   * правке правила, и «войдёт + отложено» перестаёт сходиться с
   * реальностью.
   */
  async preview(accrualDateIso?: string): Promise<PayrollAccrualPreviewDto> {
    const schedule = await this.load();
    const today = moscowDayKey();
    const date =
      accrualDateIso ??
      upcomingAccrualDates(schedule.daysOfMonth, today, 1)[0] ??
      today;
    const cutoff = new Date(moscowDayWindow(date).to.getTime() - 1);
    const { periodFrom } = accrualPeriodFor(schedule.daysOfMonth, date);

    const rules: AccrualCutoffRules = {
      cutoffBasis: schedule.cutoffBasis as PayrollCutoffBasis,
      appliesToSewing: schedule.appliesToSewing,
      appliesToCutting: schedule.appliesToCutting,
    };

    // Строки, уже занятые активной выплатой, в расчёт не идут — так же,
    // как в `computeLines`: иначе предпросмотр обещал бы деньги, которые
    // документ второй раз не возьмёт.
    const activeLines = await this.prisma.payrollPayoutLine.findMany({
      where: {
        payout: {
          status: {
            in: [
              PayrollPayoutStatus.DRAFT,
              PayrollPayoutStatus.ISSUED,
              PayrollPayoutStatus.ACKNOWLEDGED,
            ],
          },
        },
        OR: [{ operationEntryId: { not: null } }, { salaryEntryId: { not: null } }],
      },
      select: { operationEntryId: true, salaryEntryId: true },
    });
    const usedOpIds = new Set(
      activeLines.map((l) => l.operationEntryId).filter((v): v is string => !!v),
    );
    const usedSalIds = new Set(
      activeLines.map((l) => l.salaryEntryId).filter((v): v is string => !!v),
    );

    const candidates = await this.prisma.operationEntry.findMany({
      where: {
        ...pieceworkCandidateWhere(cutoff),
        ...(usedOpIds.size > 0 ? { id: { notIn: [...usedOpIds] } } : {}),
      },
      select: {
        id: true,
        employeeId: true,
        amount: true,
        approvedAt: true,
        sourceEventType: true,
        passport: {
          select: {
            order: {
              select: {
                id: true,
                number: true,
                status: true,
                completedAt: true,
              },
            },
          },
        },
      },
    });

    const salaryEntries = await this.prisma.salaryEntry.findMany({
      where: {
        date: { lte: moscowDayWindow(date).from },
        ...(usedSalIds.size > 0 ? { id: { notIn: [...usedSalIds] } } : {}),
      },
      select: { employeeId: true, amount: true, source: true },
    });

    const employees = new Set<string>();
    let piecework = new Prisma.Decimal(0);
    let cutting = new Prisma.Decimal(0);
    let deferred = new Prisma.Decimal(0);
    const deferredByOrder = new Map<
      string,
      { number: string; status: OrderStatus; amount: Prisma.Decimal }
    >();
    // Отложенное в разрезе сотрудника — та же прогонка, второй срез:
    // менеджеру нужно ответить не только «сколько ждём», но и «у кого».
    const deferredByEmployee = new Map<
      string,
      { amount: Prisma.Decimal; orders: Map<string, Prisma.Decimal> }
    >();

    for (const c of candidates) {
      const order = c.passport?.order ?? null;
      const passes = passesAccrualCutoff(rules, cutoff, {
        sourceEventType: c.sourceEventType,
        approvedAt: c.approvedAt,
        orderCompletedAt: order?.completedAt ?? null,
      });
      if (passes) {
        employees.add(c.employeeId);
        if (c.sourceEventType === EarningSource.PASSPORT_CREATED) {
          cutting = cutting.plus(c.amount);
        } else {
          piecework = piecework.plus(c.amount);
        }
        continue;
      }
      deferred = deferred.plus(c.amount);
      const emp = deferredByEmployee.get(c.employeeId) ?? {
        amount: new Prisma.Decimal(0),
        orders: new Map<string, Prisma.Decimal>(),
      };
      emp.amount = emp.amount.plus(c.amount);
      if (order) {
        emp.orders.set(
          order.id,
          (emp.orders.get(order.id) ?? new Prisma.Decimal(0)).plus(c.amount),
        );
      }
      deferredByEmployee.set(c.employeeId, emp);
      if (order) {
        const acc = deferredByOrder.get(order.id) ?? {
          number: order.number,
          status: order.status as OrderStatus,
          amount: new Prisma.Decimal(0),
        };
        acc.amount = acc.amount.plus(c.amount);
        deferredByOrder.set(order.id, acc);
      }
    }

    let salary = new Prisma.Decimal(0);
    let recut = new Prisma.Decimal(0);
    for (const s of salaryEntries) {
      employees.add(s.employeeId);
      if (s.source === 'RECUT') recut = recut.plus(s.amount);
      else salary = salary.plus(s.amount);
    }

    const deferredOrders = await this.buildDeferredOrders(deferredByOrder);
    const orderById = new Map(deferredOrders.map((o) => [o.orderId, o]));
    const deferredEmployees: PayrollDeferredEmployeeDto[] = [
      ...deferredByEmployee.entries(),
    ]
      .map(([employeeId, v]) => ({
        employeeId,
        amount: money(v.amount),
        orders: [...v.orders.entries()]
          .map(([orderId, amount]) => {
            const base = orderById.get(orderId);
            return {
              orderId,
              orderNumber: base?.orderNumber ?? orderId,
              orderStatusLabel: base?.orderStatusLabel ?? '',
              packedQty: base?.packedQty ?? 0,
              totalQty: base?.totalQty ?? 0,
              amount: money(amount),
            };
          })
          .sort((a, b) => b.amount - a.amount),
      }))
      .sort((a, b) => b.amount - a.amount);

    return {
      accrualDate: date,
      periodFrom,
      cutoffBasis: rules.cutoffBasis,
      pieceworkAmount: money(piecework),
      cuttingAmount: money(cutting),
      salaryAmount: money(salary),
      recutAmount: money(recut),
      totalAmount: money(piecework.plus(cutting).plus(salary).plus(recut)),
      employeeCount: employees.size,
      deferredAmount: money(deferred),
      deferredOrders,
      deferredEmployees,
    };
  }

  /**
   * Разворачивает отложенные суммы в строки «почему не платим»:
   * номер заказа, его статус и сколько по нему уже упаковано.
   * Сортировка по убыванию суммы — сверху то, что дороже всего ждёт.
   */
  private async buildDeferredOrders(
    byOrder: Map<string, { number: string; status: OrderStatus; amount: Prisma.Decimal }>,
  ): Promise<PayrollDeferredOrderDto[]> {
    if (byOrder.size === 0) return [];
    const orderIds = [...byOrder.keys()];
    const grouped = await this.prisma.passport.groupBy({
      by: ['orderId', 'status'],
      where: { orderId: { in: orderIds } },
      _sum: { qtyCut: true, qtyGood: true },
    });
    const totals = new Map<string, { packed: number; total: number }>();
    for (const g of grouped) {
      const acc = totals.get(g.orderId) ?? { packed: 0, total: 0 };
      acc.total += g._sum.qtyCut ?? 0;
      if (g.status === 'PACKED') acc.packed += g._sum.qtyGood ?? 0;
      totals.set(g.orderId, acc);
    }
    return [...byOrder.entries()]
      .map(([orderId, v]) => ({
        orderId,
        orderNumber: v.number,
        orderStatusLabel: ORDER_STATUS_LABELS[v.status] ?? v.status,
        packedQty: totals.get(orderId)?.packed ?? 0,
        totalQty: totals.get(orderId)?.total ?? 0,
        amount: money(v.amount),
      }))
      .sort((a, b) => b.amount - a.amount);
  }

  // ===========================================================================
  // AUTO DRAFT
  // ===========================================================================

  /**
   * Создать черновик документа, если сегодня день начисления, время
   * подошло и документа на эту дату ещё нет. Идемпотентно: повторный
   * вызов в тот же день ничего не делает (`lastRunOn`).
   *
   * Fail-soft: ошибка автосоздания не должна ронять экран, с которого
   * проверку дёрнули, — менеджер всегда может сформировать документ
   * руками.
   */
  async ensureDueDraft(viewer: AuthPrincipal): Promise<string | null> {
    try {
      const schedule = await this.load();
      if (!schedule.autoCreateDraft) return null;
      if (schedule.daysOfMonth.length === 0) return null;

      const today = moscowDayKey();
      if (!isAccrualDate(schedule.daysOfMonth, today)) return null;
      if (schedule.lastRunOn && toIsoDate(schedule.lastRunOn) === today) {
        return null;
      }
      if (!this.isAfterRunTime(schedule.runAtLocalTime)) return null;

      const { from, to } = moscowDayWindow(today);
      const existing = await this.prisma.payrollAccrualDocument.findFirst({
        where: { accrualDate: { gte: from, lt: to } },
        select: { id: true },
      });
      if (existing) {
        await this.markRun(today);
        return null;
      }

      const doc = await this.documents.create(
        {
          accrualDate: today,
          managerComment: 'Черновик сформирован автоматически по расписанию',
        } as never,
        viewer,
      );
      await this.markRun(today);
      this.logger.log(
        `event=payroll.schedule.autoDraft date=${today} documentId=${doc.id}`,
      );
      return doc.id;
    } catch (err) {
      this.logger.warn(
        `ensureDueDraft failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Наступило ли уже локальное (московское) время запуска. */
  private isAfterRunTime(runAtLocalTime: string): boolean {
    const nowMsk = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    return nowMsk >= runAtLocalTime;
  }

  private async markRun(dayIso: string): Promise<void> {
    await this.prisma.payrollAccrualSchedule.update({
      where: { id: SCHEDULE_ID },
      data: { lastRunOn: new Date(`${dayIso}T00:00:00.000Z`) },
    });
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private toDto(
    row: {
      daysOfMonth: number[];
      cutoffBasis: string;
      appliesToSewing: boolean;
      appliesToCutting: boolean;
      autoCreateDraft: boolean;
      runAtLocalTime: string;
      lastRunOn: Date | null;
      updatedAt: Date;
    },
    updatedByFullName: string | null,
  ): PayrollAccrualScheduleDto {
    const today = moscowDayKey();
    return {
      daysOfMonth: row.daysOfMonth,
      cutoffBasis: row.cutoffBasis as PayrollCutoffBasis,
      appliesToSewing: row.appliesToSewing,
      appliesToCutting: row.appliesToCutting,
      autoCreateDraft: row.autoCreateDraft,
      runAtLocalTime: row.runAtLocalTime,
      lastRunOn: row.lastRunOn ? toIsoDate(row.lastRunOn) : null,
      updatedAt: row.updatedAt.toISOString(),
      updatedByFullName,
      upcoming: upcomingAccrualDates(row.daysOfMonth, today, 3).map((date) => ({
        date,
        periodFrom:
          accrualPeriodFor(row.daysOfMonth, date).periodFrom ?? date,
        daysLeft: daysBetweenIso(today, date),
      })),
    };
  }
}

function money(v: Prisma.Decimal): number {
  return Number(v.toFixed(2));
}

/** `YYYY-MM-DD` из `@db.Date` (Prisma отдаёт полночь UTC). */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
