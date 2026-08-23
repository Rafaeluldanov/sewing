import { Injectable } from '@nestjs/common';
import {
  EntryStatus,
  PayrollPayoutLineKind,
  PayrollPayoutStatus,
  Prisma,
} from '@prisma/client';
import type {
  CancelPayrollAccrualDocumentDto,
  CreatePayrollAccrualDocumentDto,
  PayrollAccrualDocumentDto,
  PayrollAccrualDocumentLineDto,
  PayrollAccrualDocumentListItemDto,
  PayrollAccrualDocumentListQuery,
  PayrollAccrualDocumentPageDto,
  UpdatePayrollAccrualDocumentLineDto,
} from '@sewing/shared/payroll-accrual-documents';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  PayrollAccrualDocumentInvalidStateException,
  PayrollAccrualDocumentLineNotFoundException,
  PayrollAccrualDocumentNotFoundException,
  PayrollAccrualDocumentStaleSnapshotException,
  PayrollAccrualLineAlreadyPaidException,
} from '../../common/errors.js';
import { lockEmployeePayrollTx } from '../../common/payroll-lock.js';
import {
  pieceworkAccrualWhere,
  resolveAccrualBounds,
  type AccrualCutoffRules,
} from '../payroll-schedule/accrual-cutoff.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { TreasuryService } from '../treasury/treasury.service.js';

/**
 * Сервис «Документ начисления зарплаты» (PHASE 3 STEP 6.2–6.4).
 *
 * Основной поток:
 *   1. `create` — DRAFT + рассчитать строки по `OperationEntry` /
 *      `SalaryEntry` с датой ≤ `accrualDate`.
 *   2. `recompute` — пересчитать строки (только DRAFT), сохранив
 *      ручные корректировки (`manualAdjustRub` / `manualComment`).
 *   3. `updateLine` — скорректировать `manualAdjustRub` /
 *      `manualComment` у строки (только DRAFT).
 *   4. `pay` — провести документ: DRAFT → PAID, создать
 *      `PayrollPayout` ISSUED для каждой строки с `amountToPayRub > 0`.
 *      Если у строки `manualAdjustRub != 0`, создаётся дополнительная
 *      `PayrollPayoutLine` с `kind = ADJUSTMENT` (STEP 6.4).
 *   5. `cancel` — отменить черновик: DRAFT → CANCELLED.
 *
 * Контракт — `docs/api.md §«Payroll accrual documents»`.
 * Аудит — `docs/events.md §«PAYROLL_ACCRUAL_DOCUMENT»`.
 */
@Injectable()
export class PayrollAccrualDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly treasury: TreasuryService,
  ) {}

  // ===========================================================================
  // LIST
  // ===========================================================================

  async list(
    query: PayrollAccrualDocumentListQuery,
    _viewer: AuthPrincipal,
  ): Promise<PayrollAccrualDocumentPageDto> {
    const where: Prisma.PayrollAccrualDocumentWhereInput = {};

    if (query.status) where.status = query.status;
    if (query.dateFrom) {
      where.accrualDate = {
        ...(where.accrualDate as Prisma.DateTimeFilter | undefined),
        gte: parseDateOnly(query.dateFrom),
      };
    }
    if (query.dateTo) {
      where.accrualDate = {
        ...(where.accrualDate as Prisma.DateTimeFilter | undefined),
        lte: parseDateOnly(query.dateTo),
      };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payrollAccrualDocument.count({ where }),
      this.prisma.payrollAccrualDocument.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: documentListInclude,
      }),
    ]);

    return {
      items: rows.map(toListItemDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ===========================================================================
  // GET ONE (with lines)
  // ===========================================================================

  async get(id: string, _viewer: AuthPrincipal): Promise<PayrollAccrualDocumentDto> {
    const row = await this.prisma.payrollAccrualDocument.findUnique({
      where: { id },
      include: documentDetailInclude,
    });
    if (!row) throw new PayrollAccrualDocumentNotFoundException();
    return toDto(row, row.lines);
  }

  // ===========================================================================
  // CREATE (DRAFT + initial compute)
  // ===========================================================================

  async create(
    dto: CreatePayrollAccrualDocumentDto,
    viewer: AuthPrincipal,
  ): Promise<PayrollAccrualDocumentDto> {
    const accrualDateParsed = parseDateOnly(dto.accrualDate);

    const employeeFilterId = dto.employeeId ?? null;

    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.payrollAccrualDocument.create({
        data: {
          accrualDate: accrualDateParsed,
          status: 'DRAFT',
          employeeId: employeeFilterId,
          managerComment: dto.managerComment ?? null,
          createdById: viewer.employeeId,
          totalPieceworkRub: new Prisma.Decimal(0),
          totalSalaryRub: new Prisma.Decimal(0),
          totalAdjustRub: new Prisma.Decimal(0),
          totalToPayRub: new Prisma.Decimal(0),
        },
      });

      await this.computeLines(tx, doc.id, accrualDateParsed, new Map(), employeeFilterId);

      const updated = await tx.payrollAccrualDocument.findUnique({
        where: { id: doc.id },
        include: documentDetailInclude,
      });
      if (!updated) throw new PayrollAccrualDocumentNotFoundException();

      const totals = calcTotals(updated.lines);
      await tx.payrollAccrualDocument.update({
        where: { id: doc.id },
        data: totals,
      });

      await this.audit.log(
        {
          event: 'PAYROLL_ACCRUAL_DOCUMENT_CREATED',
          entityType: 'PAYROLL_ACCRUAL_DOCUMENT',
          entityId: doc.id,
          employeeId: viewer.employeeId,
          payload: {
            documentId: doc.id,
            accrualDate: dto.accrualDate,
            employeeId: employeeFilterId,
            linesCount: updated.lines.length,
            totalToPayRub: roundMoneyNumber(totals.totalToPayRub),
            createdById: viewer.employeeId,
          },
        },
        tx,
      );

      return toDto(
        { ...updated, ...totals },
        updated.lines,
      );
    });
  }

  // ===========================================================================
  // RECOMPUTE (DRAFT only)
  // ===========================================================================

  async recompute(
    id: string,
    viewer: AuthPrincipal,
  ): Promise<PayrollAccrualDocumentDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.payrollAccrualDocument.findUnique({
        where: { id },
        include: {
          lines: { select: { employeeId: true, manualAdjustRub: true, manualComment: true } },
        },
      });
      if (!row) throw new PayrollAccrualDocumentNotFoundException();
      if (row.status !== 'DRAFT') {
        throw new PayrollAccrualDocumentInvalidStateException(
          `Пересчитать строки можно только у черновика. Текущий статус: ${row.status}.`,
        );
      }

      const beforeTotalToPayRub = roundMoneyNumber(row.totalToPayRub);
      const beforeLinesCount = row.lines.length;

      // Сохранить ручные корректировки по employeeId.
      const manualMap = new Map<
        string,
        { manualAdjustRub: Prisma.Decimal; manualComment: string | null }
      >();
      for (const l of row.lines) {
        manualMap.set(l.employeeId, {
          manualAdjustRub: l.manualAdjustRub,
          manualComment: l.manualComment,
        });
      }

      // Удалить старые строки.
      await tx.payrollAccrualDocumentLine.deleteMany({ where: { documentId: id } });

      // Пересчитать (сохраняя охват документа: один сотрудник или все).
      await this.computeLines(tx, id, row.accrualDate, manualMap, row.employeeId ?? null);

      const updatedLines = await tx.payrollAccrualDocumentLine.findMany({
        where: { documentId: id },
        include: { employee: { select: employeeSelect } },
        orderBy: [{ createdAt: 'asc' }],
      });

      const totals = calcTotals(updatedLines);
      const updated = await tx.payrollAccrualDocument.update({
        where: { id },
        data: totals,
        include: documentDetailInclude,
      });

      await this.audit.log(
        {
          event: 'PAYROLL_ACCRUAL_DOCUMENT_RECOMPUTED',
          entityType: 'PAYROLL_ACCRUAL_DOCUMENT',
          entityId: id,
          employeeId: viewer.employeeId,
          payload: {
            documentId: id,
            accrualDate: toDateOnly(row.accrualDate),
            before: { linesCount: beforeLinesCount, totalToPayRub: beforeTotalToPayRub },
            after: {
              linesCount: updated.lines.length,
              totalToPayRub: roundMoneyNumber(totals.totalToPayRub),
            },
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // UPDATE LINE (DRAFT only)
  // ===========================================================================

  async updateLine(
    id: string,
    lineId: string,
    dto: UpdatePayrollAccrualDocumentLineDto,
    viewer: AuthPrincipal,
  ): Promise<PayrollAccrualDocumentDto> {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.payrollAccrualDocument.findUnique({ where: { id } });
      if (!doc) throw new PayrollAccrualDocumentNotFoundException();
      if (doc.status !== 'DRAFT') {
        throw new PayrollAccrualDocumentInvalidStateException(
          `Изменить строку можно только у черновика. Текущий статус: ${doc.status}.`,
        );
      }

      const line = await tx.payrollAccrualDocumentLine.findUnique({
        where: { id: lineId },
      });
      if (!line || line.documentId !== id) {
        throw new PayrollAccrualDocumentLineNotFoundException();
      }

      const beforeManualAdjustRub = roundMoneyNumber(line.manualAdjustRub);
      const beforeAmountToPayRub = roundMoneyNumber(line.amountToPayRub);

      const newManualAdjustRub =
        dto.manualAdjustRub !== undefined
          ? roundMoney(dto.manualAdjustRub)
          : line.manualAdjustRub;
      const newManualComment =
        dto.manualComment !== undefined ? (dto.manualComment ?? null) : line.manualComment;

      const newAmountToPayRub = roundMoney(
        line.amountPieceworkRub.plus(line.amountSalaryRub).plus(newManualAdjustRub),
      );

      await tx.payrollAccrualDocumentLine.update({
        where: { id: lineId },
        data: {
          manualAdjustRub: newManualAdjustRub,
          manualComment: newManualComment,
          amountToPayRub: newAmountToPayRub,
        },
      });

      // Пересчитать итоги документа.
      const allLines = await tx.payrollAccrualDocumentLine.findMany({
        where: { documentId: id },
        include: { employee: { select: employeeSelect } },
        orderBy: [{ createdAt: 'asc' }],
      });
      const totals = calcTotals(allLines);

      const updated = await tx.payrollAccrualDocument.update({
        where: { id },
        data: totals,
        include: documentDetailInclude,
      });

      await this.audit.log(
        {
          event: 'PAYROLL_ACCRUAL_DOCUMENT_LINE_UPDATED',
          entityType: 'PAYROLL_ACCRUAL_DOCUMENT',
          entityId: id,
          employeeId: viewer.employeeId,
          payload: {
            documentId: id,
            lineId,
            employeeId: line.employeeId,
            before: {
              manualAdjustRub: beforeManualAdjustRub,
              amountToPayRub: beforeAmountToPayRub,
            },
            after: {
              manualAdjustRub: roundMoneyNumber(newManualAdjustRub),
              amountToPayRub: roundMoneyNumber(newAmountToPayRub),
            },
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // PAY (DRAFT → PAID + create PayrollPayout ISSUED per line)
  // ===========================================================================

  async pay(id: string, viewer: AuthPrincipal): Promise<PayrollAccrualDocumentDto> {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.payrollAccrualDocument.findUnique({
        where: { id },
        include: documentDetailInclude,
      });
      if (!doc) throw new PayrollAccrualDocumentNotFoundException();
      if (doc.status !== 'DRAFT') {
        throw new PayrollAccrualDocumentInvalidStateException(
          `Провести документ можно только из черновика. Текущий статус: ${doc.status}.`,
        );
      }

      // STEP 6.4: ADJUSTMENT lines supported — no longer blocking pay.
      // (PayrollPayoutLineKind now includes 'ADJUSTMENT'.)

      // PAY4: сериализуем по сотрудникам (advisory-lock, тот же ключ, что и
      // rebuildLines) ДО проверок/вставок — закрываем окно двойной оплаты, в
      // т.ч. кросс-системной (accrual pay ∥ payout issue). Берём в
      // ОТСОРТИРОВАННОМ порядке, чтобы исключить deadlock со встречной tx.
      const lockEmployeeIds = [
        ...new Set(doc.lines.map((l) => l.employeeId)),
      ].sort();
      for (const eid of lockEmployeeIds) {
        await lockEmployeePayrollTx(tx, eid);
      }

      const now = new Date();
      const accrualDate = doc.accrualDate;
      let payoutsCreated = 0;

      for (const line of doc.lines) {
        if (line.amountToPayRub.lessThanOrEqualTo(0)) continue;

        const snapshot = line.snapshot as Record<string, unknown>;
        const opIds: string[] = Array.isArray(snapshot['operationEntryIds'])
          ? (snapshot['operationEntryIds'] as string[])
          : [];
        const salIds: string[] = Array.isArray(snapshot['salaryEntryIds'])
          ? (snapshot['salaryEntryIds'] as string[])
          : [];

        // Перед созданием: проверить, что строки из snapshot не в активных выплатах.
        if (opIds.length > 0 || salIds.length > 0) {
          const orClauses: Prisma.PayrollPayoutLineWhereInput[] = [];
          if (opIds.length > 0) orClauses.push({ operationEntryId: { in: opIds } });
          if (salIds.length > 0) orClauses.push({ salaryEntryId: { in: salIds } });

          const conflicts = await tx.payrollPayoutLine.findMany({
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
              OR: orClauses,
            },
            select: { payoutId: true, operationEntryId: true, salaryEntryId: true },
          });
          if (conflicts.length > 0) {
            const sample = conflicts[0]!;
            const which =
              sample.operationEntryId !== null
                ? `OperationEntry ${sample.operationEntryId}`
                : `SalaryEntry ${sample.salaryEntryId}`;
            throw new PayrollAccrualLineAlreadyPaidException(
              `${which} (сотрудник ${line.employeeId}) уже входит в активную выплату ${sample.payoutId}.`,
            );
          }
        }

        // PAY3: снимок мог устареть — брак / корректировка количества
        // (reconcileToQtyGood) снижают OperationEntry.amount ПОСЛЕ пересчёта
        // документа, а pay() строит выплату из замороженных сумм строки (в
        // отличие от payout issue(), который пересобирает по живым данным).
        // Сверяем замороженные суммы с ЖИВЫМИ начислениями (по тем записям,
        // что реально пойдут в выплату — snapshot.operationEntries/
        // salaryEntries); расхождение → 409, чтобы менеджер пересчитал
        // документ и перепроверил, а не выплатил устаревшую (завышенную) сумму.
        const snapOpEntries = Array.isArray(snapshot['operationEntries'])
          ? (snapshot['operationEntries'] as Record<string, unknown>[])
          : [];
        const snapSalEntries = Array.isArray(snapshot['salaryEntries'])
          ? (snapshot['salaryEntries'] as Record<string, unknown>[])
          : [];
        const checkOpIds = snapOpEntries
          .map((oe) => String(oe['id'] ?? ''))
          .filter(Boolean);
        const checkSalIds = snapSalEntries
          .map((se) => String(se['id'] ?? ''))
          .filter(Boolean);
        if (checkOpIds.length > 0) {
          const liveOp = await tx.operationEntry.findMany({
            where: { id: { in: checkOpIds } },
            select: { amount: true },
          });
          const livePiecework = liveOp.reduce(
            (s, e) => s.plus(roundMoney(e.amount)),
            new Prisma.Decimal(0),
          );
          if (!livePiecework.equals(line.amountPieceworkRub)) {
            throw new PayrollAccrualDocumentStaleSnapshotException(
              `Сдельные начисления сотрудника ${line.employeeId} изменились ` +
                `после пересчёта документа (снимок ` +
                `${line.amountPieceworkRub.toString()} → факт ` +
                `${livePiecework.toString()}). Пересчитайте документ и ` +
                `проверьте заново перед проведением.`,
            );
          }
        }
        if (checkSalIds.length > 0) {
          const liveSal = await tx.salaryEntry.findMany({
            where: { id: { in: checkSalIds } },
            select: { amount: true },
          });
          const liveSalary = liveSal.reduce(
            (s, e) => s.plus(roundMoney(e.amount)),
            new Prisma.Decimal(0),
          );
          if (!liveSalary.equals(line.amountSalaryRub)) {
            throw new PayrollAccrualDocumentStaleSnapshotException(
              `Окладные начисления сотрудника ${line.employeeId} изменились ` +
                `после пересчёта документа (снимок ` +
                `${line.amountSalaryRub.toString()} → факт ` +
                `${liveSalary.toString()}). Пересчитайте документ и ` +
                `проверьте заново перед проведением.`,
            );
          }
        }

        // Определить periodFrom из snapshot.
        const periodFrom = resolvePeriodFrom(snapshot, accrualDate);

        // Создать PayrollPayout ISSUED.
        const payout = await tx.payrollPayout.create({
          data: {
            employeeId: line.employeeId,
            periodFrom,
            periodTo: accrualDate,
            status: PayrollPayoutStatus.ISSUED,
            amountPieceworkRub: line.amountPieceworkRub,
            amountSalaryRub: line.amountSalaryRub,
            amountTotalRub: line.amountToPayRub,
            managerComment:
              doc.managerComment ?? line.manualComment ?? null,
            createdById: viewer.employeeId,
            issuedAt: now,
            issuedById: viewer.employeeId,
          },
        });

        // Создать PayrollPayoutLine для OperationEntry.
        const payoutLines: Prisma.PayrollPayoutLineCreateManyInput[] = [];

        const opEntries = Array.isArray(snapshot['operationEntries'])
          ? (snapshot['operationEntries'] as Record<string, unknown>[])
          : [];
        for (const oe of opEntries) {
          const oeId = String(oe['id'] ?? '');
          if (!oeId) continue;
          payoutLines.push({
            payoutId: payout.id,
            kind: PayrollPayoutLineKind.PIECEWORK,
            operationEntryId: oeId,
            salaryEntryId: null,
            amountRub: roundMoney(Number(oe['amount'] ?? 0)),
            occurredOn: oe['createdAt']
              ? startOfDayUtc(new Date(String(oe['createdAt'])))
              : accrualDate,
            snapshot: {
              operationId: oe['operationId'] ?? null,
              passportId: oe['passportId'] ?? null,
              qty: oe['qty'] ?? null,
              ratePerUnit: oe['ratePerUnit'] ?? null,
              amount: oe['amount'] ?? null,
              sourceEventType: oe['sourceEventType'] ?? null,
              createdAt: oe['createdAt'] ?? null,
              approvedAt: oe['approvedAt'] ?? null,
            } satisfies Prisma.InputJsonValue,
          });
        }

        const salEntries = Array.isArray(snapshot['salaryEntries'])
          ? (snapshot['salaryEntries'] as Record<string, unknown>[])
          : [];
        for (const se of salEntries) {
          const seId = String(se['id'] ?? '');
          if (!seId) continue;
          payoutLines.push({
            payoutId: payout.id,
            kind: PayrollPayoutLineKind.SALARY,
            operationEntryId: null,
            salaryEntryId: seId,
            amountRub: roundMoney(Number(se['amount'] ?? 0)),
            occurredOn: se['date']
              ? startOfDayUtc(new Date(String(se['date'])))
              : accrualDate,
            snapshot: {
              date: se['date'] ?? null,
              source: se['source'] ?? null,
              amount: se['amount'] ?? null,
              editedManually: se['editedManually'] ?? null,
              managerComment: se['managerComment'] ?? null,
            } satisfies Prisma.InputJsonValue,
          });
        }

        // STEP 6.4: корректировка != 0 → создать ADJUSTMENT PayrollPayoutLine.
        if (!line.manualAdjustRub.equals(0)) {
          payoutLines.push({
            payoutId: payout.id,
            kind: 'ADJUSTMENT' as PayrollPayoutLineKind,
            operationEntryId: null,
            salaryEntryId: null,
            amountRub: roundMoney(line.manualAdjustRub),
            occurredOn: accrualDate,
            snapshot: {
              manual: true,
              source: 'PAYROLL_ACCRUAL_DOCUMENT',
              documentId: id,
              documentLineId: line.id,
              employeeId: line.employeeId,
              manualAdjustRub: roundMoneyNumber(line.manualAdjustRub),
              manualComment: line.manualComment ?? null,
              accrualDate: toDateOnly(accrualDate),
              createdById: viewer.employeeId,
            } satisfies Prisma.InputJsonValue,
          });
        }

        if (payoutLines.length > 0) {
          await tx.payrollPayoutLine.createMany({ data: payoutLines });
        }

        // Привязать строку документа к выплате.
        await tx.payrollAccrualDocumentLine.update({
          where: { id: line.id },
          data: { payoutId: payout.id },
        });

        // Казначейство (Фаза 1, опт-ин): создаём заявку на расход
        // (`SupplierPayment`, kind=SALARY, DRAFT) на эту выплату со
        // статьёй ДДС сотрудника (fallback — глобальная). Проводка ДС
        // появится позже, на «Оплатить» заявку. Если казначейство не
        // настроено — заявка не создаётся (выплата работает как раньше).
        await this.treasury.createSalaryExpenseRequestTx(tx, {
          payoutId: payout.id,
          employeeId: line.employeeId,
          amount: line.amountToPayRub,
          postedById: viewer.employeeId,
        });

        payoutsCreated += 1;
      }

      // Обновить документ: DRAFT → PAID.
      const paidAt = now;
      const updated = await tx.payrollAccrualDocument.update({
        where: { id },
        data: {
          status: 'PAID',
          paidAt,
          paidById: viewer.employeeId,
        },
        include: documentDetailInclude,
      });

      await this.audit.log(
        {
          event: 'PAYROLL_ACCRUAL_DOCUMENT_PAID',
          entityType: 'PAYROLL_ACCRUAL_DOCUMENT',
          entityId: id,
          employeeId: viewer.employeeId,
          payload: {
            documentId: id,
            accrualDate: toDateOnly(doc.accrualDate),
            payoutsCreated,
            totalToPayRub: roundMoneyNumber(doc.totalToPayRub),
            adjustmentsCount: doc.lines.filter((l) => !l.manualAdjustRub.equals(0)).length,
            totalAdjustRub: roundMoneyNumber(doc.totalAdjustRub),
            paidById: viewer.employeeId,
            paidAt: paidAt.toISOString(),
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // CANCEL (DRAFT → CANCELLED)
  // ===========================================================================

  async cancel(
    id: string,
    dto: CancelPayrollAccrualDocumentDto,
    viewer: AuthPrincipal,
  ): Promise<PayrollAccrualDocumentDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.payrollAccrualDocument.findUnique({ where: { id } });
      if (!row) throw new PayrollAccrualDocumentNotFoundException();
      if (row.status !== 'DRAFT') {
        throw new PayrollAccrualDocumentInvalidStateException(
          `Отменить можно только черновик. Текущий статус: ${row.status}. PAID документ отменить нельзя.`,
        );
      }

      const cancelledAt = new Date();
      const updated = await tx.payrollAccrualDocument.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt,
          cancelledById: viewer.employeeId,
          cancelReason: dto.reason ?? null,
        },
        include: documentDetailInclude,
      });

      await this.audit.log(
        {
          event: 'PAYROLL_ACCRUAL_DOCUMENT_CANCELLED',
          entityType: 'PAYROLL_ACCRUAL_DOCUMENT',
          entityId: id,
          employeeId: viewer.employeeId,
          payload: {
            documentId: id,
            accrualDate: toDateOnly(row.accrualDate),
            cancelledById: viewer.employeeId,
            cancelReason: dto.reason ?? null,
            cancelledAt: cancelledAt.toISOString(),
          },
        },
        tx,
      );

      return toDto(updated, updated.lines);
    });
  }

  // ===========================================================================
  // INTERNAL: compute lines
  // ===========================================================================

  /**
   * Рассчитывает (или пересчитывает) строки `PayrollAccrualDocumentLine`.
   *
   * Алгоритм:
   *   - accrualDate cutoff: включительно (≤ accrualDate 23:59:59.999 UTC);
   *   - `OperationEntry`: status = APPROVED, createdAt ≤ cutoff;
   *     исключить те, что уже в активных PayrollPayoutLine
   *     (payout.status ∈ DRAFT/ISSUED/ACKNOWLEDGED);
   *   - `SalaryEntry`: date ≤ accrualDate;
   *     исключить те, что уже в активных PayrollPayoutLine.
   *   - если задан `employeeFilterId` — учитываются только начисления
   *     этого сотрудника (документ по одному сотруднику);
   *   - Группировка по employeeId.
   *   - Строка создаётся только если amountPieceworkRub + amountSalaryRub > 0
   *     OR manualAdjustRub != 0 (из manualMap).
   */
  /**
   * Правила отсечки из настройки расписания. Строки может не быть
   * (база, накатанная в обход миграции) — тогда падаем на историческое
   * поведение `WORK_DATE`, чтобы формирование документа не ломалось.
   */
  private async loadCutoffRules(
    tx: Prisma.TransactionClient,
  ): Promise<AccrualCutoffRules> {
    const row = await tx.payrollAccrualSchedule.findUnique({
      where: { id: 'default' },
      select: {
        cutoffBasis: true,
        appliesToSewing: true,
        appliesToCutting: true,
      },
    });
    if (!row) {
      return {
        cutoffBasis: 'WORK_DATE',
        appliesToSewing: false,
        appliesToCutting: false,
      };
    }
    return {
      cutoffBasis: row.cutoffBasis,
      appliesToSewing: row.appliesToSewing,
      appliesToCutting: row.appliesToCutting,
    };
  }

  private async computeLines(
    tx: Prisma.TransactionClient,
    documentId: string,
    accrualDate: Date,
    manualMap: Map<string, { manualAdjustRub: Prisma.Decimal; manualComment: string | null }>,
    employeeFilterId: string | null,
  ): Promise<void> {
    // Границы дня начисления считает общий helper: та же функция, что
    // у предпросмотра. Раньше здесь стоял `endOfDayUtc`, а предпросмотр
    // резал по московскому концу суток — три часа разницы, в которые
    // попадает ночная смена: документ её брал, предпросмотр не
    // показывал.
    const { cutoff, salaryDate } = resolveAccrualBounds(
      accrualDate.toISOString().slice(0, 10),
    );

    // --- Загрузить активные PayrollPayoutLine (занятые id) ---
    const activePayoutLines = await tx.payrollPayoutLine.findMany({
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
        OR: [
          { operationEntryId: { not: null } },
          { salaryEntryId: { not: null } },
        ],
      },
      select: { operationEntryId: true, salaryEntryId: true },
    });
    const usedOpIds = new Set<string>();
    const usedSalIds = new Set<string>();
    for (const apl of activePayoutLines) {
      if (apl.operationEntryId) usedOpIds.add(apl.operationEntryId);
      if (apl.salaryEntryId) usedSalIds.add(apl.salaryEntryId);
    }

    // --- Загрузить OperationEntry ≤ cutoff (APPROVED, не занятые) ---
    //
    // Отсечка по расписанию (`PayrollAccrualSchedule`): по умолчанию в
    // документ идёт только сдельщина по ЗАКРЫТЫМ заказам. Правило живёт
    // в общем helper-е `accrual-cutoff.ts` — тем же пользуется
    // предпросмотр «войдёт / отложено», иначе документ и предпросмотр
    // разъехались бы в день выплаты. Пока настройка не тронута
    // (`WORK_DATE`), поведение ровно прежнее: всё начисленное до даты.
    const schedule = await this.loadCutoffRules(tx);
    const opEntries = await tx.operationEntry.findMany({
      where: {
        ...pieceworkAccrualWhere(schedule, cutoff),
        ...(employeeFilterId ? { employeeId: employeeFilterId } : {}),
        ...(usedOpIds.size > 0 ? { id: { notIn: Array.from(usedOpIds) } } : {}),
      },
      orderBy: [{ employeeId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    // --- Загрузить SalaryEntry ≤ accrualDate (не занятые) ---
    const salEntries = await tx.salaryEntry.findMany({
      where: {
        date: { lte: salaryDate },
        ...(employeeFilterId ? { employeeId: employeeFilterId } : {}),
        ...(usedSalIds.size > 0 ? { id: { notIn: Array.from(usedSalIds) } } : {}),
      },
      orderBy: [{ employeeId: 'asc' }, { date: 'asc' }, { id: 'asc' }],
    });

    // --- Группировка по employeeId ---
    const byEmployee = new Map<
      string,
      {
        opEntries: typeof opEntries;
        salEntries: typeof salEntries;
      }
    >();

    for (const oe of opEntries) {
      const g = byEmployee.get(oe.employeeId) ?? { opEntries: [], salEntries: [] };
      g.opEntries.push(oe);
      byEmployee.set(oe.employeeId, g);
    }
    for (const se of salEntries) {
      const g = byEmployee.get(se.employeeId) ?? { opEntries: [], salEntries: [] };
      g.salEntries.push(se);
      byEmployee.set(se.employeeId, g);
    }

    // Добавить employeeId из manualMap, у которых нет начислений (для сохранения manual строк).
    // При фильтре по сотруднику — только его (другие manual-строки в охват не входят).
    for (const [empId] of manualMap) {
      if (employeeFilterId && empId !== employeeFilterId) continue;
      if (!byEmployee.has(empId)) {
        byEmployee.set(empId, { opEntries: [], salEntries: [] });
      }
    }

    // --- Создать строки ---
    const linesToCreate: Prisma.PayrollAccrualDocumentLineCreateManyInput[] = [];

    for (const [employeeId, group] of byEmployee) {
      let pieceworkSum = new Prisma.Decimal(0);
      let salarySum = new Prisma.Decimal(0);

      for (const oe of group.opEntries) {
        pieceworkSum = pieceworkSum.plus(roundMoney(oe.amount));
      }
      for (const se of group.salEntries) {
        salarySum = salarySum.plus(roundMoney(se.amount));
      }

      const manual = manualMap.get(employeeId);
      const manualAdjustRub = manual ? roundMoney(manual.manualAdjustRub) : new Prisma.Decimal(0);
      const manualComment = manual?.manualComment ?? null;

      // Пропустить строку если нет начислений и нет ручной корректировки.
      if (pieceworkSum.equals(0) && salarySum.equals(0) && manualAdjustRub.equals(0)) {
        continue;
      }

      const amountToPayRub = roundMoney(pieceworkSum.plus(salarySum).plus(manualAdjustRub));

      // Snapshot.
      const opEntrySnapshots = group.opEntries.map((oe) => ({
        id: oe.id,
        operationId: oe.operationId,
        passportId: oe.passportId,
        qty: oe.qty,
        ratePerUnit: roundMoneyNumber(oe.ratePerUnit),
        amount: roundMoneyNumber(oe.amount),
        sourceEventType: oe.sourceEventType,
        createdAt: oe.createdAt.toISOString(),
        approvedAt: oe.approvedAt ? oe.approvedAt.toISOString() : null,
      }));

      const salEntrySnapshots = group.salEntries.map((se) => ({
        id: se.id,
        date: toDateOnly(se.date),
        source: se.source,
        amount: roundMoneyNumber(se.amount),
        editedManually: se.editedManually,
        managerComment: se.managerComment ?? null,
      }));

      const snapshot: Prisma.InputJsonValue = {
        accrualDate: toDateOnly(accrualDate),
        operationEntryIds: group.opEntries.map((oe) => oe.id),
        salaryEntryIds: group.salEntries.map((se) => se.id),
        operationEntries: opEntrySnapshots,
        salaryEntries: salEntrySnapshots,
      };

      linesToCreate.push({
        documentId,
        employeeId,
        amountPieceworkRub: pieceworkSum,
        amountSalaryRub: salarySum,
        manualAdjustRub,
        manualComment,
        amountToPayRub,
        snapshot,
      });
    }

    if (linesToCreate.length > 0) {
      await tx.payrollAccrualDocumentLine.createMany({ data: linesToCreate });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const employeeSelect = {
  id: true,
  fullName: true,
  role: true,
} as const;

/**
 * Стандартный include для карточки документа: сотрудник-охват (если задан)
 * и строки с их сотрудниками.
 */
const documentDetailInclude = {
  employee: { select: employeeSelect },
  lines: {
    include: { employee: { select: employeeSelect } },
    orderBy: [{ createdAt: 'asc' }],
  },
} satisfies Prisma.PayrollAccrualDocumentInclude;

const documentListInclude = {
  employee: { select: employeeSelect },
  _count: { select: { lines: true } },
} satisfies Prisma.PayrollAccrualDocumentInclude;

type DocRow = Prisma.PayrollAccrualDocumentGetPayload<{
  include: typeof documentDetailInclude;
}>;

type LineRow = Prisma.PayrollAccrualDocumentLineGetPayload<{
  include: { employee: { select: typeof employeeSelect } };
}>;

type ListRow = Prisma.PayrollAccrualDocumentGetPayload<{
  include: typeof documentListInclude;
}>;

function toListItemDto(row: ListRow): PayrollAccrualDocumentListItemDto {
  return {
    id: row.id,
    accrualDate: toDateOnly(row.accrualDate),
    status: row.status,
    employeeId: row.employeeId ?? null,
    employee: toEmployeeDto(row.employee),
    totalPieceworkRub: roundMoneyNumber(row.totalPieceworkRub),
    totalSalaryRub: roundMoneyNumber(row.totalSalaryRub),
    totalAdjustRub: roundMoneyNumber(row.totalAdjustRub),
    totalToPayRub: roundMoneyNumber(row.totalToPayRub),
    managerComment: row.managerComment ?? null,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    linesCount: row._count.lines,
  };
}

/** Маппинг сотрудника-охвата документа в DTO (или `null`). */
function toEmployeeDto(
  employee: { id: string; fullName: string; role: string } | null,
): { id: string; fullName: string; role: string } | null {
  return employee
    ? { id: employee.id, fullName: employee.fullName, role: employee.role }
    : null;
}

function toLineDto(line: LineRow): PayrollAccrualDocumentLineDto {
  return {
    id: line.id,
    documentId: line.documentId,
    employeeId: line.employeeId,
    employee: line.employee
      ? {
          id: line.employee.id,
          fullName: line.employee.fullName,
          role: line.employee.role,
        }
      : { id: line.employeeId, fullName: '', role: '' },
    amountPieceworkRub: roundMoneyNumber(line.amountPieceworkRub),
    amountSalaryRub: roundMoneyNumber(line.amountSalaryRub),
    manualAdjustRub: roundMoneyNumber(line.manualAdjustRub),
    manualComment: line.manualComment ?? null,
    amountToPayRub: roundMoneyNumber(line.amountToPayRub),
    payoutId: line.payoutId ?? null,
    snapshot: line.snapshot,
    createdAt: line.createdAt.toISOString(),
    updatedAt: line.updatedAt.toISOString(),
  };
}

function toDto(
  row: Omit<DocRow, 'lines'> & {
    totalPieceworkRub: Prisma.Decimal;
    totalSalaryRub: Prisma.Decimal;
    totalAdjustRub: Prisma.Decimal;
    totalToPayRub: Prisma.Decimal;
  },
  lines: LineRow[],
): PayrollAccrualDocumentDto {
  return {
    id: row.id,
    accrualDate: toDateOnly(row.accrualDate),
    status: row.status,
    employeeId: row.employeeId ?? null,
    employee: toEmployeeDto(row.employee),
    totalPieceworkRub: roundMoneyNumber(row.totalPieceworkRub),
    totalSalaryRub: roundMoneyNumber(row.totalSalaryRub),
    totalAdjustRub: roundMoneyNumber(row.totalAdjustRub),
    totalToPayRub: roundMoneyNumber(row.totalToPayRub),
    managerComment: row.managerComment ?? null,
    createdById: row.createdById,
    paidById: row.paidById ?? null,
    cancelledById: row.cancelledById ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    cancelReason: row.cancelReason ?? null,
    lines: lines.map(toLineDto),
  };
}

function calcTotals(lines: { amountPieceworkRub: Prisma.Decimal; amountSalaryRub: Prisma.Decimal; manualAdjustRub: Prisma.Decimal; amountToPayRub: Prisma.Decimal }[]): {
  totalPieceworkRub: Prisma.Decimal;
  totalSalaryRub: Prisma.Decimal;
  totalAdjustRub: Prisma.Decimal;
  totalToPayRub: Prisma.Decimal;
} {
  let totalPieceworkRub = new Prisma.Decimal(0);
  let totalSalaryRub = new Prisma.Decimal(0);
  let totalAdjustRub = new Prisma.Decimal(0);
  let totalToPayRub = new Prisma.Decimal(0);
  for (const l of lines) {
    totalPieceworkRub = totalPieceworkRub.plus(l.amountPieceworkRub);
    totalSalaryRub = totalSalaryRub.plus(l.amountSalaryRub);
    totalAdjustRub = totalAdjustRub.plus(l.manualAdjustRub);
    totalToPayRub = totalToPayRub.plus(l.amountToPayRub);
  }
  return { totalPieceworkRub, totalSalaryRub, totalAdjustRub, totalToPayRub };
}

/**
 * Определить `periodFrom` для `PayrollPayout` из snapshot строки.
 * Берём минимальную дату начисления: сначала из `salaryEntries[].date`,
 * потом из `operationEntries[].createdAt`. Если ничего нет — accrualDate.
 */
function resolvePeriodFrom(
  snapshot: Record<string, unknown>,
  accrualDate: Date,
): Date {
  let min: Date | null = null;

  const salEntries = Array.isArray(snapshot['salaryEntries'])
    ? (snapshot['salaryEntries'] as Record<string, unknown>[])
    : [];
  for (const se of salEntries) {
    if (se['date']) {
      const d = startOfDayUtc(new Date(String(se['date'])));
      if (!min || d < min) min = d;
    }
  }

  const opEntries = Array.isArray(snapshot['operationEntries'])
    ? (snapshot['operationEntries'] as Record<string, unknown>[])
    : [];
  for (const oe of opEntries) {
    if (oe['createdAt']) {
      const d = startOfDayUtc(new Date(String(oe['createdAt'])));
      if (!min || d < min) min = d;
    }
  }

  return min ?? startOfDayUtc(accrualDate);
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function startOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
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
