import { Injectable } from '@nestjs/common';
import {
  EntryStatus,
  PayrollPayoutLineKind,
  PayrollPayoutStatus,
  Prisma,
} from '@prisma/client';
import type {
  CancelPayrollPayoutDto,
  CreatePayrollPayoutDto,
  PayrollPayoutDto,
  PayrollPayoutLineDto,
  PayrollPayoutListQuery,
  PayrollPayoutPageDto,
} from '@sewing/shared/payroll-payouts';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  PayrollPayoutForbiddenAckException,
  PayrollPayoutInvalidTransitionException,
  PayrollPayoutLineAlreadyIncludedException,
  PayrollPayoutNotFoundException,
} from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { isSalaryManager } from '../salary/salary.constants.js';
import { TreasuryService } from '../treasury/treasury.service.js';

/**
 * Сервис «Выплата зарплаты сотруднику» (PHASE 3 STEP 2).
 *
 * Создаёт «папку выплаты» (`PayrollPayout`) поверх уже существующих
 * `OperationEntry` / `SalaryEntry` за период. Сами таблицы начислений
 * статусами «выплачено» НЕ помечаются — состояние выплаты живёт в
 * `PayrollPayout.status` (`DRAFT → ISSUED → ACKNOWLEDGED|CANCELLED`,
 * `DRAFT → CANCELLED`). Snapshot-итоги (`amountPieceworkRub`,
 * `amountSalaryRub`, `amountTotalRub`) и `PayrollPayoutLine[]`
 * фиксируются при `recompute` / `issue` и не пересчитываются после
 * `ISSUED`.
 *
 * Бизнес-инвариант:
 *   - в выплату попадают **только APPROVED** `OperationEntry` и
 *     `SalaryEntry` за период `[periodFrom, periodTo]`. Pending
 *     сдельщина исключается сознательно: она ещё не подтверждена и
 *     может быть отменена/изменена;
 *   - одна и та же `OperationEntry` / `SalaryEntry` не может попасть
 *     в две **активные** выплаты (`DRAFT`/`ISSUED`/`ACKNOWLEDGED`).
 *     `CANCELLED` не блокирует. Уникальность проверяется здесь, на
 *     уровне БД `@@unique` по FK сознательно НЕ ставится — иначе
 *     перевключить строку после `CANCELLED` было бы невозможно;
 *   - `recompute`/`issue` доступны только в `DRAFT`;
 *   - `cancel` доступен только в `DRAFT` или `ISSUED`;
 *   - `ack` доступен только сотруднику-получателю
 *     (`viewer.employeeId === payout.employeeId`); менеджер не может
 *     «расписаться» за работника. Идемпотентность: повторный
 *     `ack` от того же сотрудника возвращает существующий DTO.
 *
 * Контракт DTO/zod — `packages/shared/src/payroll-payouts.ts`.
 * Документация — `docs/api.md §«Payroll payouts»`,
 * `docs/erd.md §2.9`, `docs/events.md §3.3 «PAYROLL_PAYOUT»`.
 */
@Injectable()
export class PayrollPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly treasury: TreasuryService,
  ) {}

  // ===========================================================================
  // LIST
  // ===========================================================================

  /**
   * `GET /api/payroll/payouts`. RBAC: менеджер/админ видят все
   * выплаты; обычный сотрудник — только свои (`employeeId
   * = viewer.employeeId`). Период (`periodFrom`/`periodTo`) трактуется
   * как «выплаты, период которых пересекается с заданным» —
   * `payout.periodFrom <= q.periodTo AND payout.periodTo >= q.periodFrom`.
   */
  async list(
    query: PayrollPayoutListQuery,
    viewer: AuthPrincipal,
  ): Promise<PayrollPayoutPageDto> {
    const where: Prisma.PayrollPayoutWhereInput = {};
    if (isSalaryManager(viewer.role)) {
      if (query.employeeId) where.employeeId = query.employeeId;
    } else {
      // Обычный сотрудник всегда видит только свои строки. Любой
      // явный `employeeId`-фильтр игнорируется и заменяется на
      // `viewer.employeeId` — это и RBAC-страховка, и защита от
      // утечки чужих id через 0-результат.
      where.employeeId = viewer.employeeId;
    }
    if (query.status) where.status = query.status as PayrollPayoutStatus;
    if (query.periodFrom) {
      where.periodTo = {
        ...(where.periodTo as Prisma.DateTimeFilter | undefined),
        gte: parseDateOnly(query.periodFrom),
      };
    }
    if (query.periodTo) {
      where.periodFrom = {
        ...(where.periodFrom as Prisma.DateTimeFilter | undefined),
        lte: parseDateOnly(query.periodTo),
      };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payrollPayout.count({ where }),
      this.prisma.payrollPayout.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { employee: { select: employeeSelect } },
      }),
    ]);

    return {
      items: rows.map((r) => toDto(r, undefined)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ===========================================================================
  // GET ONE (with lines)
  // ===========================================================================

  /**
   * `GET /api/payroll/payouts/:id`. Карточка выплаты со строками.
   * Обычный сотрудник для чужой выплаты получает `404`
   * (`PAYROLL_PAYOUT_NOT_FOUND`), не `403` — иначе утекают id чужих
   * выплат через различимое поведение.
   */
  async get(id: string, viewer: AuthPrincipal): Promise<PayrollPayoutDto> {
    const row = await this.prisma.payrollPayout.findUnique({
      where: { id },
      include: {
        employee: { select: employeeSelect },
        lines: { orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!row) throw new PayrollPayoutNotFoundException();
    if (
      !isSalaryManager(viewer.role) &&
      row.employeeId !== viewer.employeeId
    ) {
      // Сознательно 404, а не 403: см. JSDoc исключения.
      throw new PayrollPayoutNotFoundException();
    }
    return toDto(row, row.lines);
  }

  // ===========================================================================
  // CREATE (DRAFT + initial snapshot)
  // ===========================================================================

  /**
   * `POST /api/payroll/payouts` — менеджер создаёт черновик. Сразу
   * собирает строки snapshot-ом по APPROVED `OperationEntry` /
   * `SalaryEntry` за период (`periodFrom 00:00:00.000 UTC` —
   * `periodTo 23:59:59.999 UTC`). Pending сдельщина исключается.
   *
   * Активный инвариант проверяется до создания строк: если хотя бы
   * одна найденная `OperationEntry` / `SalaryEntry` уже в активной
   * выплате — отдаём 422 `PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED`.
   *
   * Аудит: `PAYROLL_PAYOUT_CREATED` в той же транзакции, что и
   * `payrollPayout.create` + `payrollPayoutLine.createMany`.
   */
  async create(
    dto: CreatePayrollPayoutDto,
    viewer: AuthPrincipal,
  ): Promise<PayrollPayoutDto> {
    const periodFromDate = parseDateOnly(dto.periodFrom);
    const periodToDate = parseDateOnly(dto.periodTo);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.payrollPayout.create({
        data: {
          employeeId: dto.employeeId,
          periodFrom: periodFromDate,
          periodTo: periodToDate,
          status: PayrollPayoutStatus.DRAFT,
          managerComment: dto.managerComment ?? null,
          createdById: viewer.employeeId,
          amountPieceworkRub: new Prisma.Decimal(0),
          amountSalaryRub: new Prisma.Decimal(0),
          amountTotalRub: new Prisma.Decimal(0),
        },
      });

      const totals = await this.rebuildLines(
        tx,
        created.id,
        dto.employeeId,
        periodFromDate,
        periodToDate,
      );

      const updated = await tx.payrollPayout.update({
        where: { id: created.id },
        data: {
          amountPieceworkRub: totals.piecework,
          amountSalaryRub: totals.salary,
          amountTotalRub: totals.piecework.plus(totals.salary),
        },
        include: {
          employee: { select: employeeSelect },
          lines: {
            orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });

      await this.audit.log(
        {
          event: 'PAYROLL_PAYOUT_CREATED',
          entityType: 'PAYROLL_PAYOUT',
          entityId: updated.id,
          employeeId: viewer.employeeId,
          payload: {
            payoutId: updated.id,
            employeeId: updated.employeeId,
            periodFrom: dto.periodFrom,
            periodTo: dto.periodTo,
            amountPieceworkRub: roundMoneyNumber(updated.amountPieceworkRub),
            amountSalaryRub: roundMoneyNumber(updated.amountSalaryRub),
            amountTotalRub: roundMoneyNumber(updated.amountTotalRub),
            lineCount: updated.lines.length,
            createdById: viewer.employeeId,
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // RECOMPUTE (DRAFT only)
  // ===========================================================================

  /**
   * `POST /api/payroll/payouts/:id/recompute` — пересобрать строки
   * черновика. Удаляем текущие `PayrollPayoutLine` и пересоздаём по
   * актуальному состоянию `OperationEntry` / `SalaryEntry`.
   * Допустимо только в `DRAFT`.
   */
  async recompute(
    id: string,
    viewer: AuthPrincipal,
  ): Promise<PayrollPayoutDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.payrollPayout.findUnique({ where: { id } });
      if (!row) throw new PayrollPayoutNotFoundException();
      if (row.status !== PayrollPayoutStatus.DRAFT) {
        throw new PayrollPayoutInvalidTransitionException(
          `Пересобрать строки можно только у черновика. Текущий статус: ${row.status}.`,
        );
      }

      const beforeAgg = await tx.payrollPayoutLine.aggregate({
        where: { payoutId: id },
        _sum: { amountRub: true },
        _count: { _all: true },
      });
      const beforeTotal = roundMoneyNumber(beforeAgg._sum.amountRub);
      const beforeCount = beforeAgg._count._all;

      await tx.payrollPayoutLine.deleteMany({ where: { payoutId: id } });
      const totals = await this.rebuildLines(
        tx,
        id,
        row.employeeId,
        row.periodFrom,
        row.periodTo,
      );

      const updated = await tx.payrollPayout.update({
        where: { id },
        data: {
          amountPieceworkRub: totals.piecework,
          amountSalaryRub: totals.salary,
          amountTotalRub: totals.piecework.plus(totals.salary),
        },
        include: {
          employee: { select: employeeSelect },
          lines: {
            orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });

      await this.audit.log(
        {
          event: 'PAYROLL_PAYOUT_LINES_RECOMPUTED',
          entityType: 'PAYROLL_PAYOUT',
          entityId: updated.id,
          employeeId: viewer.employeeId,
          payload: {
            payoutId: updated.id,
            employeeId: updated.employeeId,
            periodFrom: toDateOnly(updated.periodFrom),
            periodTo: toDateOnly(updated.periodTo),
            before: {
              amountTotalRub: beforeTotal,
              lineCount: beforeCount,
            },
            after: {
              amountTotalRub: roundMoneyNumber(updated.amountTotalRub),
              lineCount: updated.lines.length,
            },
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // ISSUE (DRAFT → ISSUED)
  // ===========================================================================

  /**
   * `POST /api/payroll/payouts/:id/issue` — менеджер «выдаёт»
   * выплату. Перед сменой статуса в той же транзакции выполняется
   * recompute (строки пересобираются по актуальному снимку, чтобы
   * `ISSUED`-snapshot всегда соответствовал состоянию начислений в
   * момент выдачи).
   */
  async issue(id: string, viewer: AuthPrincipal): Promise<PayrollPayoutDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.payrollPayout.findUnique({ where: { id } });
      if (!row) throw new PayrollPayoutNotFoundException();
      if (row.status !== PayrollPayoutStatus.DRAFT) {
        throw new PayrollPayoutInvalidTransitionException(
          `Выдать выплату можно только из черновика. Текущий статус: ${row.status}.`,
        );
      }

      await tx.payrollPayoutLine.deleteMany({ where: { payoutId: id } });
      const totals = await this.rebuildLines(
        tx,
        id,
        row.employeeId,
        row.periodFrom,
        row.periodTo,
      );

      const issuedAt = new Date();
      const updated = await tx.payrollPayout.update({
        where: { id },
        data: {
          status: PayrollPayoutStatus.ISSUED,
          amountPieceworkRub: totals.piecework,
          amountSalaryRub: totals.salary,
          amountTotalRub: totals.piecework.plus(totals.salary),
          issuedAt,
          issuedById: viewer.employeeId,
        },
        include: {
          employee: { select: employeeSelect },
          lines: {
            orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });

      // Казначейство (Фаза 1, опт-ин): при выдаче создаём заявку на расход
      // (`SupplierPayment`, kind=SALARY, DRAFT) со статьёй ДДС сотрудника
      // (fallback — глобальная). Движения денег ещё нет — проводка журнала
      // ДС пишется позже, на шаге «Оплатить» заявку. Если казначейство не
      // настроено — заявка не создаётся, выдача работает как раньше.
      await this.treasury.createSalaryExpenseRequestTx(tx, {
        payoutId: updated.id,
        employeeId: updated.employeeId,
        amount: updated.amountTotalRub,
        postedById: viewer.employeeId,
      });

      await this.audit.log(
        {
          event: 'PAYROLL_PAYOUT_ISSUED',
          entityType: 'PAYROLL_PAYOUT',
          entityId: updated.id,
          employeeId: viewer.employeeId,
          payload: {
            payoutId: updated.id,
            employeeId: updated.employeeId,
            periodFrom: toDateOnly(updated.periodFrom),
            periodTo: toDateOnly(updated.periodTo),
            amountTotalRub: roundMoneyNumber(updated.amountTotalRub),
            lineCount: updated.lines.length,
            issuedById: viewer.employeeId,
            issuedAt: issuedAt.toISOString(),
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // ACK (ISSUED → ACKNOWLEDGED, owner only, idempotent)
  // ===========================================================================

  /**
   * `POST /api/payroll/payouts/:id/ack` — сотрудник подтверждает
   * получение. Доступ:
   *   - менеджер/админ за чужого работника — `403 PAYROLL_PAYOUT_FORBIDDEN_ACK`;
   *   - не-владелец вообще — `404 PAYROLL_PAYOUT_NOT_FOUND` (сначала
   *     проверяется существование/видимость, потом RBAC ack);
   *   - повторный `ack` тем же владельцем по уже `ACKNOWLEDGED`-выплате
   *     — идемпотентен, возвращает текущий DTO без записи аудита;
   *   - остальное (`DRAFT`, `CANCELLED`, `ACKNOWLEDGED` другим
   *     владельцем — теоретически невозможно, но на всякий случай) —
   *     `409 PAYROLL_PAYOUT_INVALID_TRANSITION`.
   */
  async ack(id: string, viewer: AuthPrincipal): Promise<PayrollPayoutDto> {
    const row = await this.prisma.payrollPayout.findUnique({
      where: { id },
      include: {
        employee: { select: employeeSelect },
        lines: { orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!row) throw new PayrollPayoutNotFoundException();

    // Только владелец имеет право подтверждать. Менеджеру/админу,
    // если employeeId не совпадает с его, тоже отказываем — нельзя
    // «расписаться» за сотрудника. См. ТЗ PHASE 3 STEP 2 «ack only
    // employee-владелец».
    if (row.employeeId !== viewer.employeeId) {
      throw new PayrollPayoutForbiddenAckException();
    }

    if (row.status === PayrollPayoutStatus.ACKNOWLEDGED) {
      // Идемпотентность повторного подтверждения тем же владельцем.
      // ACK от другого владельца уже отсечён выше: владелец один,
      // сравнение по employeeId.
      return toDto(row, row.lines);
    }
    if (row.status !== PayrollPayoutStatus.ISSUED) {
      throw new PayrollPayoutInvalidTransitionException(
        `Подтвердить получение можно только у выданной выплаты (ISSUED). Текущий статус: ${row.status}.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payrollPayout.update({
        where: { id },
        data: {
          status: PayrollPayoutStatus.ACKNOWLEDGED,
          acknowledgedAt: new Date(),
          acknowledgedByEmployeeId: viewer.employeeId,
        },
        include: {
          employee: { select: employeeSelect },
          lines: {
            orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });

      await this.audit.log(
        {
          event: 'PAYROLL_PAYOUT_ACKNOWLEDGED',
          entityType: 'PAYROLL_PAYOUT',
          entityId: updated.id,
          employeeId: viewer.employeeId,
          payload: {
            payoutId: updated.id,
            employeeId: updated.employeeId,
            acknowledgedByEmployeeId: viewer.employeeId,
            amountTotalRub: roundMoneyNumber(updated.amountTotalRub),
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // CANCEL (DRAFT|ISSUED → CANCELLED)
  // ===========================================================================

  async cancel(
    id: string,
    dto: CancelPayrollPayoutDto,
    viewer: AuthPrincipal,
  ): Promise<PayrollPayoutDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.payrollPayout.findUnique({ where: { id } });
      if (!row) throw new PayrollPayoutNotFoundException();
      if (
        row.status !== PayrollPayoutStatus.DRAFT &&
        row.status !== PayrollPayoutStatus.ISSUED
      ) {
        throw new PayrollPayoutInvalidTransitionException(
          `Отменить можно только черновик или выданную выплату. Текущий статус: ${row.status}.`,
        );
      }

      const fromStatus = row.status;
      const updated = await tx.payrollPayout.update({
        where: { id },
        data: {
          status: PayrollPayoutStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: viewer.employeeId,
          cancelReason: dto.reason ?? null,
        },
        include: {
          employee: { select: employeeSelect },
          lines: {
            orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });

      // Казначейство (Фаза 1): при отмене выданной выплаты отменяем
      // связанную заявку на расход, если она ещё не оплачена
      // (`DRAFT`/`APPROVED` → `CANCELLED`). Если заявка уже оплачена —
      // не трогаем: деньги двинулись, исправление через сторно журнала.
      // Для черновика выплаты заявки нет — ничего не делаем.
      if (fromStatus === PayrollPayoutStatus.ISSUED) {
        await this.treasury.cancelSalaryExpenseRequestByPayoutTx(tx, {
          payoutId: id,
          employeeId: viewer.employeeId,
          reason: 'Отмена выплаты зарплаты',
        });
      }

      await this.audit.log(
        {
          event: 'PAYROLL_PAYOUT_CANCELLED',
          entityType: 'PAYROLL_PAYOUT',
          entityId: updated.id,
          employeeId: viewer.employeeId,
          payload: {
            payoutId: updated.id,
            employeeId: updated.employeeId,
            fromStatus,
            cancelledById: viewer.employeeId,
            cancelReason: updated.cancelReason ?? null,
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // INTERNAL: snapshot collection
  // ===========================================================================

  /**
   * Удаление текущих строк должно быть выполнено вызывающим (для
   * `recompute`/`issue`); метод собирает свежий snapshot и создаёт
   * новые `PayrollPayoutLine`. Возвращает свёрнутые суммы.
   *
   * Активная уникальность строки начисления:
   *   - проверяем `PayrollPayoutLine`, у которых `payoutId !=
   *     current` и родительский `PayrollPayout.status` ∈
   *     {DRAFT,ISSUED,ACKNOWLEDGED}, а FK совпадает с одним из
   *     наших кандидатов;
   *   - если такие есть — `422 PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED`
   *     с конкретным сообщением.
   */
  private async rebuildLines(
    tx: Prisma.TransactionClient,
    payoutId: string,
    employeeId: string,
    periodFrom: Date,
    periodTo: Date,
  ): Promise<{ piecework: Prisma.Decimal; salary: Prisma.Decimal }> {
    const fromTs = startOfDayUtc(periodFrom);
    const toTs = endOfDayUtc(periodTo);
    const fromDate = startOfDayUtc(periodFrom);
    const toDate = startOfDayUtc(periodTo);

    const [opEntries, salEntries] = await Promise.all([
      tx.operationEntry.findMany({
        where: {
          employeeId,
          status: EntryStatus.APPROVED,
          createdAt: { gte: fromTs, lte: toTs },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.salaryEntry.findMany({
        where: {
          employeeId,
          date: { gte: fromDate, lte: toDate },
        },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
    ]);

    // Активная уникальность: ни одна из выбранных `OperationEntry` /
    // `SalaryEntry` не должна быть привязана к другой не-CANCELLED
    // выплате. Проверка единым запросом — дешевле, чем по строке.
    const opIds = opEntries.map((e) => e.id);
    const salIds = salEntries.map((e) => e.id);
    if (opIds.length > 0 || salIds.length > 0) {
      const orClauses: Prisma.PayrollPayoutLineWhereInput[] = [];
      if (opIds.length > 0) {
        orClauses.push({ operationEntryId: { in: opIds } });
      }
      if (salIds.length > 0) {
        orClauses.push({ salaryEntryId: { in: salIds } });
      }
      const conflicts = await tx.payrollPayoutLine.findMany({
        where: {
          payoutId: { not: payoutId },
          payout: {
            status: {
              in: [
                PayrollPayoutStatus.DRAFT,
                PayrollPayoutStatus.ISSUED,
                PayrollPayoutStatus.ACKNOWLEDGED,
              ],
            },
          },
          OR: orClauses,
        },
        select: {
          payoutId: true,
          operationEntryId: true,
          salaryEntryId: true,
        },
      });
      if (conflicts.length > 0) {
        const sample = conflicts[0]!;
        const which =
          sample.operationEntryId !== null
            ? `OperationEntry ${sample.operationEntryId}`
            : `SalaryEntry ${sample.salaryEntryId}`;
        throw new PayrollPayoutLineAlreadyIncludedException(
          `${which} уже входит в активную выплату ${sample.payoutId}. ` +
            `Отмените её или дождитесь подтверждения.`,
        );
      }
    }

    let pieceworkSum = new Prisma.Decimal(0);
    let salarySum = new Prisma.Decimal(0);
    const data: Prisma.PayrollPayoutLineCreateManyInput[] = [];

    for (const e of opEntries) {
      const amount = roundMoney(e.amount);
      pieceworkSum = pieceworkSum.plus(amount);
      data.push({
        payoutId,
        kind: PayrollPayoutLineKind.PIECEWORK,
        operationEntryId: e.id,
        salaryEntryId: null,
        amountRub: amount,
        occurredOn: startOfDayUtc(e.createdAt),
        snapshot: {
          operationId: e.operationId,
          passportId: e.passportId,
          qty: e.qty,
          ratePerUnit: roundMoneyNumber(e.ratePerUnit),
          amount: roundMoneyNumber(e.amount),
          sourceEventType: e.sourceEventType,
          createdAt: e.createdAt.toISOString(),
          approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
        } satisfies Prisma.InputJsonValue,
      });
    }

    for (const s of salEntries) {
      const amount = roundMoney(s.amount);
      salarySum = salarySum.plus(amount);
      data.push({
        payoutId,
        kind: PayrollPayoutLineKind.SALARY,
        operationEntryId: null,
        salaryEntryId: s.id,
        amountRub: amount,
        occurredOn: s.date,
        snapshot: {
          date: toDateOnly(s.date),
          source: s.source,
          amount: roundMoneyNumber(s.amount),
          editedManually: s.editedManually,
          managerComment: s.managerComment ?? null,
        } satisfies Prisma.InputJsonValue,
      });
    }

    if (data.length > 0) {
      await tx.payrollPayoutLine.createMany({ data });
    }

    return { piecework: pieceworkSum, salary: salarySum };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const employeeSelect = {
  id: true,
  fullName: true,
  role: true,
} as const;

type PayoutWithEmployee = Prisma.PayrollPayoutGetPayload<{
  include: { employee: { select: typeof employeeSelect } };
}>;
type PayoutLineRow = Prisma.PayrollPayoutLineGetPayload<{}>;

function toDto(
  row: PayoutWithEmployee,
  lines: PayoutLineRow[] | undefined,
): PayrollPayoutDto {
  const dto: PayrollPayoutDto = {
    id: row.id,
    employeeId: row.employeeId,
    employee: row.employee
      ? {
          id: row.employee.id,
          fullName: row.employee.fullName,
          role: row.employee.role,
        }
      : undefined,
    periodFrom: toDateOnly(row.periodFrom),
    periodTo: toDateOnly(row.periodTo),
    status: row.status,
    amountPieceworkRub: roundMoneyNumber(row.amountPieceworkRub),
    amountSalaryRub: roundMoneyNumber(row.amountSalaryRub),
    amountTotalRub: roundMoneyNumber(row.amountTotalRub),
    managerComment: row.managerComment ?? null,
    createdAt: row.createdAt.toISOString(),
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    acknowledgedAt: row.acknowledgedAt
      ? row.acknowledgedAt.toISOString()
      : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
  if (lines !== undefined) {
    dto.lines = lines.map(toLineDto);
  }
  return dto;
}

function toLineDto(line: PayoutLineRow): PayrollPayoutLineDto {
  return {
    id: line.id,
    kind: line.kind,
    operationEntryId: line.operationEntryId,
    salaryEntryId: line.salaryEntryId,
    amountRub: roundMoneyNumber(line.amountRub),
    occurredOn: toDateOnly(line.occurredOn),
    snapshot:
      (line.snapshot as Prisma.JsonValue as Record<string, unknown>) ?? {},
  };
}

function parseDateOnly(value: string): Date {
  // `YYYY-MM-DD` нормализуется до полуночи UTC. Поле БД — `@db.Date`,
  // Prisma корректно сравнивает с `DateTime` границами.
  return new Date(`${value}T00:00:00.000Z`);
}

function startOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function endOfDayUtc(d: Date): Date {
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

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function roundMoney(value: Prisma.Decimal | number | string): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return new Prisma.Decimal(value.toFixed(2));
  }
  return new Prisma.Decimal(round2(Number(value)).toFixed(2));
}

function roundMoneyNumber(
  value: Prisma.Decimal | number | string | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return round2(value);
  if (typeof value === 'string') return round2(Number(value));
  return Number(value.toFixed(2));
}
