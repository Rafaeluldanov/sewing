import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ApprovalMode,
  EarningSource,
  EntryStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import type {
  EarningDto,
  EarningsPage,
  EarningsSummaryDto,
  EarningsSummaryQuery,
  ListEarningsQuery,
} from '@sewing/shared/earnings';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OperationsService } from '../operations/operations.service.js';
import { isEarningsManager } from './earnings.constants.js';

/**
 * Сервис сдельных начислений (Шаг 9 MVP).
 *
 * Делает три большие вещи:
 *
 * 1. Создаёт `OperationEntry` в нужный момент:
 *    - immediate-начисление раскройщику в `PassportsService.create`
 *      (`createImmediateForCutter`);
 *    - deferred-начисление швее за предыдущую операцию в
 *      `PassportsService.scanOnOperation` (`createPendingForPreviousOperation`).
 *
 * 2. Подтверждает все pending-начисления паспорта в момент упаковки
 *    (`approvePendingForPassport`, вызывается из `PackingService.addPassport`).
 *
 * 3. Отдаёт три read-метода под минимальный API/UI просмотра
 *    (`list`, `summary`, `listByPassport`).
 *
 * Бизнес-правила: ADR-0005, ADR-0012, `docs/flows.md §F2`/`§F4`/`§F7`.
 *
 * Идемпотентность: запись в БД защищена `@@unique` на
 * `(passportId, operationId, employeeId, sourceEventType)`. Сервис
 * дополнительно ловит `P2002` и трактует его как «начисление уже было
 * создано» — повторный скан/повторный create паспорта в той же
 * транзакции не приводит к дублям и не ломается с 500-кой.
 */
@Injectable()
export class EarningsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationsService,
  ) {}

  // ===========================================================================
  // CREATE: cutter (immediate)
  // ===========================================================================

  /**
   * Раскройщик: начисление сразу `APPROVED` при выпуске паспорта.
   *
   * Контракт ADR-0005 §«Создание»:
   *   `operationId = CUT_CUT`, `qty = passport.qtyCut`,
   *   `status = APPROVED`, `approvedAt = now()`.
   *
   * Если у раскройщика `paymentType ≠ PIECEWORK` — ничего не создаём.
   * Это покрывает кейс, когда демо-раскройщик случайно посажен на
   * оклад (на проде раскройщик-сдельщик — норма).
   *
   * Должен вызываться из той же транзакции, что и
   * `passport.create`, чтобы зарплата и паспорт жили атомарно.
   */
  async createImmediateForCutter(
    tx: Prisma.TransactionClient,
    args: {
      passportId: string;
      cutterId: string;
      sizeId: string;
      productId: string;
      qty: number;
    },
  ): Promise<void> {
    if (args.qty <= 0) return;

    const employee = await tx.employee.findUnique({
      where: { id: args.cutterId },
      select: { id: true, paymentType: true, active: true },
    });
    if (!employee || !employee.active) return;
    if (employee.paymentType !== PaymentType.PIECEWORK) return;

    const op = await tx.operation.findUnique({
      where: { code: 'CUT_CUT' },
      select: { id: true, code: true, pricingMode: true },
    });
    if (!op) return;
    // Если раскрой переведён на оклад — никаких сдельных начислений.
    if (op.pricingMode === 'SALARY_ONLY') return;

    const rate = await this.operations.resolveRate(op.id, args.sizeId, tx);
    if (!rate) return;

    const amount = roundMoney(rate.times(args.qty));
    await this.safeCreate(tx, {
      passportId: args.passportId,
      operationId: op.id,
      employeeId: employee.id,
      qty: args.qty,
      ratePerUnit: rate,
      amount,
      status: EntryStatus.APPROVED,
      approvalMode: ApprovalMode.IMMEDIATE,
      sourceEventType: EarningSource.PASSPORT_CREATED,
      sourceEventId: null,
      approvedAt: new Date(),
    });
  }

  // ===========================================================================
  // CREATE: sewing (after release)
  // ===========================================================================

  /**
   * Пошив: при переходе паспорта на следующую операцию мы платим
   * предыдущему исполнителю предыдущей операции. Контракт ADR-0005
   * §«Создание»: `status = PENDING_RELEASE`, `approvedAt = null`,
   * `qty = passport.qtyCut` на момент перехода.
   *
   * Источник истины «есть ли сдельная ставка» — `Operation.pricingMode`
   * (см. `docs/domain.md §16a`, `OperationsService.resolveRate`). Если
   * предыдущая операция оклад/нет ставки или исполнитель не piecework —
   * тихо ничего не создаём.
   *
   * Дубли защищены `@@unique`: повторный скан той же сменой/тем же
   * сотрудником на той же операции не поднимает второе начисление.
   *
   * Должен вызываться из той же транзакции, что и обновление
   * `Passport.currentOperationId/currentEmployeeId` и `OPERATION_SCAN`.
   */
  async createPendingForPreviousOperation(
    tx: Prisma.TransactionClient,
    args: {
      passportId: string;
      previousOperationId: string | null;
      previousEmployeeId: string | null;
      productId: string;
      sizeId: string;
      qty: number;
      sourceEventId?: string | null;
    },
  ): Promise<void> {
    if (!args.previousOperationId || !args.previousEmployeeId) return;
    if (args.qty <= 0) return;

    const op = await tx.operation.findUnique({
      where: { id: args.previousOperationId },
      select: { id: true, code: true, pricingMode: true },
    });
    if (!op) return;
    // Источник истины — Operation.pricingMode (см. ADR-0005,
    // `docs/domain.md §16a`):
    //   SALARY_ONLY → нет сдельной ставки, ничего не создаём;
    //   FIXED / BY_SIZE → создаём начисление по resolveRate.
    if (op.pricingMode === 'SALARY_ONLY') return;
    // CUT_CUT покрывается immediate-веткой при выпуске паспорта
    // (`createImmediateForCutter`), здесь — только пошив.
    if (op.code === 'CUT_CUT') return;

    const employee = await tx.employee.findUnique({
      where: { id: args.previousEmployeeId },
      select: { id: true, paymentType: true, active: true },
    });
    if (!employee || !employee.active) return;
    if (employee.paymentType !== PaymentType.PIECEWORK) return;

    const rate = await this.operations.resolveRate(op.id, args.sizeId, tx);
    if (!rate) return;

    const amount = roundMoney(rate.times(args.qty));
    await this.safeCreate(tx, {
      passportId: args.passportId,
      operationId: op.id,
      employeeId: employee.id,
      qty: args.qty,
      ratePerUnit: rate,
      amount,
      status: EntryStatus.PENDING_RELEASE,
      approvalMode: ApprovalMode.AFTER_RELEASE,
      sourceEventType: EarningSource.OPERATION_TRANSITION,
      sourceEventId: args.sourceEventId ?? null,
      approvedAt: null,
    });
  }

  // ===========================================================================
  // APPROVE: after packing
  // ===========================================================================

  /**
   * Подтверждение всех висящих pending-начислений паспорта в момент
   * упаковки. Ровно один SQL-update в общей транзакции.
   *
   * Возвращает количество затронутых записей — удобно для логирования
   * и тестов, но в самом `PackingService` не обязательно.
   */
  async approvePendingForPassport(
    tx: Prisma.TransactionClient,
    passportId: string,
    approvedAt: Date = new Date(),
  ): Promise<number> {
    const result = await tx.operationEntry.updateMany({
      where: {
        passportId,
        status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
      },
      data: {
        status: EntryStatus.APPROVED,
        approvedAt,
      },
    });
    return result.count;
  }

  // ===========================================================================
  // READ: list
  // ===========================================================================

  /**
   * Списочное чтение начислений с RBAC-скоупом.
   *
   * Менеджерские роли (`SHOP_MANAGER`, `ADMIN`, см.
   * `EARNINGS_MANAGER_ROLES`) видят все строки и могут фильтровать по
   * любому `employeeId`/`status` из query. Все остальные роли получают
   * принудительный скоуп: `employeeId = viewer.employeeId` и
   * `status = APPROVED`. Любой query-параметр, которым обычный
   * пользователь пытается посмотреть чужие строки или pending —
   * затирается на сервере.
   *
   * См. `docs/api.md §10`, ADR-0014 §«Сотрудник всегда из сессии».
   */
  async list(
    query: ListEarningsQuery,
    viewer: AuthPrincipal,
  ): Promise<EarningsPage> {
    const scoped = this.applyViewerScopeToList(query, viewer);
    const where = this.buildWhere(scoped);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.operationEntry.count({ where }),
      this.prisma.operationEntry.findMany({
        where,
        include: this.detailInclude(),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (scoped.page - 1) * scoped.pageSize,
        take: scoped.pageSize,
      }),
    ]);

    return {
      items: rows.map((r) => this.toDto(r)),
      total,
      page: scoped.page,
      pageSize: scoped.pageSize,
    };
  }

  // ===========================================================================
  // READ: summary
  // ===========================================================================

  async summary(
    query: EarningsSummaryQuery,
    viewer: AuthPrincipal,
  ): Promise<EarningsSummaryDto> {
    const isManager = isEarningsManager(viewer.role);
    const baseWhere: Prisma.OperationEntryWhereInput = {};
    // Не-менеджер всегда видит только свои строки. employeeId из query
    // игнорируется (см. ADR-0014 §«Сотрудник всегда из сессии»).
    if (!isManager) {
      baseWhere.employeeId = viewer.employeeId;
    } else if (query.employeeId) {
      baseWhere.employeeId = query.employeeId;
    }
    if (query.dateFrom || query.dateTo) {
      baseWhere.createdAt = {};
      if (query.dateFrom) baseWhere.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) baseWhere.createdAt.lte = new Date(query.dateTo);
    }

    if (!isManager) {
      // Обычный сотрудник не видит pending → нет смысла агрегировать
      // их и нет шанса «случайно» отдать сумму неподтверждённых.
      const approved = await this.prisma.operationEntry.aggregate({
        where: { ...baseWhere, status: EntryStatus.APPROVED },
        _sum: { amount: true },
        _count: { _all: true },
      });
      return {
        totalApproved: roundMoneyNumber(approved._sum.amount),
        totalPending: 0,
        countApproved: approved._count._all,
        countPending: 0,
      };
    }

    // Считаем pending как PENDING_RELEASE + legacy PENDING (на случай
    // ранее созданных строк): это снимает риск «пропавших копеек» при
    // переходе со старой схемы на новую.
    const [approved, pending] = await this.prisma.$transaction([
      this.prisma.operationEntry.aggregate({
        where: { ...baseWhere, status: EntryStatus.APPROVED },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.operationEntry.aggregate({
        where: {
          ...baseWhere,
          status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    return {
      totalApproved: roundMoneyNumber(approved._sum.amount),
      totalPending: roundMoneyNumber(pending._sum.amount),
      countApproved: approved._count._all,
      countPending: pending._count._all,
    };
  }

  // ===========================================================================
  // READ: by passport
  // ===========================================================================

  async listByPassport(
    passportId: string,
    viewer: AuthPrincipal,
  ): Promise<EarningDto[]> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      select: { id: true },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    const where: Prisma.OperationEntryWhereInput = { passportId };
    if (!isEarningsManager(viewer.role)) {
      // Обычный сотрудник по паспорту видит только свои подтверждённые
      // начисления. Если их нет — отдаём пустой список, не подсвечивая
      // факт чужих pending/approved строк по этому паспорту.
      where.employeeId = viewer.employeeId;
      where.status = EntryStatus.APPROVED;
    }
    const rows = await this.prisma.operationEntry.findMany({
      where,
      include: this.detailInclude(),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  /**
   * Накладывает RBAC-скоуп на query для `/api/earnings`. Для не-менеджера
   * затирает `employeeId` на свой и фиксирует `status = APPROVED`,
   * игнорируя любые попытки обойти ограничение через query-string.
   */
  private applyViewerScopeToList(
    query: ListEarningsQuery,
    viewer: AuthPrincipal,
  ): ListEarningsQuery {
    if (isEarningsManager(viewer.role)) return query;
    return {
      ...query,
      employeeId: viewer.employeeId,
      status: 'APPROVED',
    };
  }

  private buildWhere(query: ListEarningsQuery): Prisma.OperationEntryWhereInput {
    const where: Prisma.OperationEntryWhereInput = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.passportId) where.passportId = query.passportId;
    if (query.status) {
      // На MVP принимаем PENDING_RELEASE как фильтр; PENDING как legacy
      // подтягиваем через OR, чтобы старые тестовые данные не «исчезали»
      // из списка при выборе фильтра «PENDING_RELEASE».
      if (query.status === 'PENDING_RELEASE') {
        where.status = {
          in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING],
        };
      } else {
        where.status = EntryStatus[query.status];
      }
    }
    if (query.approvalMode) where.approvalMode = ApprovalMode[query.approvalMode];
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }
    return where;
  }

  private detailInclude() {
    return {
      passport: {
        include: {
          order: { select: { id: true, number: true } },
          product: { select: { name: true } },
          size: true,
        },
      },
      operation: { select: { id: true, code: true, name: true } },
      employee: { select: { id: true, fullName: true } },
    } satisfies Prisma.OperationEntryInclude;
  }

  private toDto(
    row: Prisma.OperationEntryGetPayload<{
      include: {
        passport: {
          include: {
            order: { select: { id: true; number: true } };
            product: { select: { name: true } };
            size: true;
          };
        };
        operation: { select: { id: true; code: true; name: true } };
        employee: { select: { id: true; fullName: true } };
      };
    }>,
  ): EarningDto {
    return {
      id: row.id,
      passportId: row.passportId,
      passportNumber: row.passport.number,
      orderId: row.passport.order.id,
      orderNumber: row.passport.order.number,
      productName: row.passport.product.name,
      color: row.passport.color,
      sizeId: row.passport.sizeId,
      sizeCode: row.passport.size.code,
      sizeSortOrder: row.passport.size.sortOrder,
      operationId: row.operation.id,
      operationCode: row.operation.code,
      operationName: row.operation.name,
      employeeId: row.employee.id,
      employeeFullName: row.employee.fullName,
      qty: row.qty,
      ratePerUnit: roundMoneyNumber(row.ratePerUnit),
      amount: roundMoneyNumber(row.amount),
      // Маппим legacy `PENDING` в публичный `PENDING_RELEASE`, чтобы UI
      // не разбирался в двух именах одного и того же состояния.
      status:
        row.status === EntryStatus.PENDING
          ? 'PENDING_RELEASE'
          : (row.status as EarningDto['status']),
      approvalMode: row.approvalMode as EarningDto['approvalMode'],
      sourceEventType: row.sourceEventType as EarningDto['sourceEventType'],
      createdAt: row.createdAt.toISOString(),
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    };
  }

  /**
   * `tx.operationEntry.create` обёрнутая в обработку P2002
   * (нарушение `@@unique` на ключе идемпотентности). Любая другая
   * ошибка пробрасывается наружу — это уже не дубль, а реальный сбой.
   */
  private async safeCreate(
    tx: Prisma.TransactionClient,
    data: Prisma.OperationEntryUncheckedCreateInput,
  ): Promise<void> {
    try {
      await tx.operationEntry.create({ data });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// money helpers
// ---------------------------------------------------------------------------

/**
 * Округление до двух знаков. Используем half-up (не банковское) —
 * совпадает с тем, как считают на бумаге и в 1С на участке зарплат.
 */
function roundMoney(amount: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(amount.toFixed(2));
}

function roundMoneyNumber(amount: Prisma.Decimal | null | undefined): number {
  if (!amount) return 0;
  return Number(amount.toFixed(2));
}
