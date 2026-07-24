import { Injectable } from '@nestjs/common';
import { ExpensePaymentKind, Prisma, SupplierPaymentStatus } from '@prisma/client';
import type {
  SupplierPaymentDto,
  CreateSupplierPaymentDto,
  CancelSupplierPaymentDto,
  ListSupplierPaymentsQuery,
} from '@sewing/shared/treasury';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CashAccountInactiveException,
  CashAccountNotFoundException,
  CashFlowItemInactiveException,
  CashFlowItemNotFoundException,
  PurchaseOrderNotFoundException,
  SupplierNotFoundException,
  SupplierPaymentAlreadyPaidException,
  SupplierPaymentInvalidStatusException,
  SupplierPaymentNotFoundException,
} from '../../common/errors.js';
import { TreasuryService } from './treasury.service.js';
import { ExpensePaymentNumberService } from './expense-payment-number.service.js';

/**
 * Оплата поставщику (Фаза 1 казначейства).
 *
 * Документ «санкционировал → оплатил» поверх закупочного контура.
 * Жизненный цикл `DRAFT → APPROVED → PAID`, плюс `CANCELLED` (до оплаты).
 * Проведение (`pay`) атомарно создаёт проводку журнала ДДС через
 * `TreasuryService.postEntryTx` в той же транзакции; идемпотентность —
 * unique-индекс журнала (повторная оплата → P2002 →
 * `SUPPLIER_PAYMENT_ALREADY_PAID`).
 *
 * Связь с `Supplier`/`PurchaseOrder` — soft (id + snapshot, без FK):
 * закупочный контур не связываем с казначейским жёстко.
 */
@Injectable()
export class SupplierPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly treasury: TreasuryService,
    private readonly expenseNumber: ExpensePaymentNumberService,
  ) {}

  // ---------------------------------------------------------------------------
  // Чтение
  // ---------------------------------------------------------------------------

  async list(query: ListSupplierPaymentsQuery): Promise<SupplierPaymentDto[]> {
    const where: Prisma.SupplierPaymentWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.kind) where.kind = query.kind as ExpensePaymentKind;
    const rows = await this.prisma.supplierPayment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 100,
      include: { account: true, item: true },
    });
    return rows.map((r) => this.map(r));
  }

  async get(id: string): Promise<SupplierPaymentDto> {
    const row = await this.prisma.supplierPayment.findUnique({
      where: { id },
      include: { account: true, item: true },
    });
    if (!row) throw new SupplierPaymentNotFoundException();
    return this.map(row);
  }

  // ---------------------------------------------------------------------------
  // Создание (DRAFT)
  // ---------------------------------------------------------------------------

  async create(
    dto: CreateSupplierPaymentDto,
    employeeId: string,
  ): Promise<SupplierPaymentDto> {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: dto.supplierId },
      select: { id: true, name: true },
    });
    if (!supplier) throw new SupplierNotFoundException();

    const account = await this.prisma.cashAccount.findUnique({
      where: { id: dto.accountId },
    });
    if (!account) throw new CashAccountNotFoundException();
    if (!account.isActive) throw new CashAccountInactiveException();

    const item = await this.prisma.cashFlowItem.findUnique({
      where: { id: dto.itemId },
    });
    if (!item) throw new CashFlowItemNotFoundException();
    if (!item.isActive) throw new CashFlowItemInactiveException();

    let poNumber: string | null = null;
    if (dto.purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findUnique({
        where: { id: dto.purchaseOrderId },
        select: { id: true, number: true },
      });
      if (!po) throw new PurchaseOrderNotFoundException();
      poNumber = po.number;
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const number = await this.expenseNumber.nextNumber(
        tx,
        ExpensePaymentKind.SUPPLIER,
      );
      return tx.supplierPayment.create({
        data: {
          number,
          kind: ExpensePaymentKind.SUPPLIER,
          supplierId: supplier.id,
          supplierNameSnapshot: supplier.name,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          purchaseOrderNumberSnapshot: poNumber,
          accountId: dto.accountId,
          itemId: dto.itemId,
          amount: new Prisma.Decimal(dto.amount),
          status: SupplierPaymentStatus.DRAFT,
          comment: dto.comment ?? null,
          createdById: employeeId,
        },
        include: { account: true, item: true },
      });
    });
    return this.map(row);
  }

  /**
   * Хэндофф «заявка на оплату → казначейство»: создаём ЧЕРНОВИК заявки
   * на расход (`SupplierPayment`, kind SUPPLIER) из этапа заявки на
   * оплату. Снимки имени/№PO берём из заявки. Бросает, если счёт/статья
   * ДДС не найдены или неактивны — вызывающий (хэндофф) ловит и
   * продолжает (best-effort, опт-ин).
   */
  async createDraftFromRequestStage(input: {
    supplierId: string;
    supplierNameSnapshot: string;
    purchaseOrderId: string | null;
    purchaseOrderNumberSnapshot: string | null;
    accountId: string;
    itemId: string;
    amount: Prisma.Decimal;
    comment: string | null;
    createdById: string | null;
  }): Promise<SupplierPaymentDto> {
    const account = await this.prisma.cashAccount.findUnique({
      where: { id: input.accountId },
    });
    if (!account) throw new CashAccountNotFoundException();
    if (!account.isActive) throw new CashAccountInactiveException();
    const item = await this.prisma.cashFlowItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item) throw new CashFlowItemNotFoundException();
    if (!item.isActive) throw new CashFlowItemInactiveException();

    // Номер как у ручного create() (иначе черновики-хэндоффы висят с пустым
    // номером в «Заявках на расход» — T3). nextNumber требует tx-клиент;
    // UNIQUE защищает от гонки.
    const row = await this.prisma.$transaction(async (tx) => {
      const number = await this.expenseNumber.nextNumber(
        tx,
        ExpensePaymentKind.SUPPLIER,
      );
      return tx.supplierPayment.create({
        data: {
          number,
          kind: ExpensePaymentKind.SUPPLIER,
          supplierId: input.supplierId,
          supplierNameSnapshot: input.supplierNameSnapshot,
          purchaseOrderId: input.purchaseOrderId,
          purchaseOrderNumberSnapshot: input.purchaseOrderNumberSnapshot,
          accountId: input.accountId,
          itemId: input.itemId,
          amount: input.amount,
          status: SupplierPaymentStatus.DRAFT,
          comment: input.comment,
          createdById: input.createdById,
        },
        include: { account: true, item: true },
      });
    });
    return this.map(row);
  }

  // ---------------------------------------------------------------------------
  // Согласование (DRAFT → APPROVED)
  // ---------------------------------------------------------------------------

  async approve(id: string, employeeId: string): Promise<SupplierPaymentDto> {
    const row = await this.prisma.supplierPayment.findUnique({ where: { id } });
    if (!row) throw new SupplierPaymentNotFoundException();
    if (row.status !== SupplierPaymentStatus.DRAFT) {
      throw new SupplierPaymentInvalidStatusException(
        `Согласовать можно только черновик. Текущий статус: ${row.status}.`,
      );
    }
    const updated = await this.prisma.supplierPayment.update({
      where: { id },
      data: {
        status: SupplierPaymentStatus.APPROVED,
        approvedById: employeeId,
        approvedAt: new Date(),
      },
      include: { account: true, item: true },
    });
    return this.map(updated);
  }

  // ---------------------------------------------------------------------------
  // Оплата (APPROVED → PAID) — проводка в журнал, одна транзакция
  // ---------------------------------------------------------------------------

  async pay(id: string, employeeId: string): Promise<SupplierPaymentDto> {
    const pre = await this.prisma.supplierPayment.findUnique({ where: { id } });
    if (!pre) throw new SupplierPaymentNotFoundException();
    if (pre.status !== SupplierPaymentStatus.APPROVED) {
      throw new SupplierPaymentInvalidStatusException(
        `Оплатить можно только согласованную заявку. Текущий статус: ${pre.status}.`,
      );
    }

    const account = await this.prisma.cashAccount.findUnique({
      where: { id: pre.accountId },
    });
    if (!account) throw new CashAccountNotFoundException();
    if (!account.isActive) throw new CashAccountInactiveException();
    const item = await this.prisma.cashFlowItem.findUnique({
      where: { id: pre.itemId },
    });
    if (!item) throw new CashFlowItemNotFoundException();
    if (!item.isActive) throw new CashFlowItemInactiveException();

    try {
      const isSalary = pre.kind === ExpensePaymentKind.SALARY;
      const updated = await this.prisma.$transaction(async (tx) => {
        const entry = await this.treasury.postEntryTx(tx, {
          accountId: pre.accountId,
          itemId: pre.itemId,
          direction: 'OUT',
          amount: pre.amount,
          // Журнал ДС: источник по виду заявки. registrarType
          // оставляем единым ('SUPPLIER_PAYMENT') — это ключ
          // идемпотентности по `registrarId = заявка.id`, общий для
          // обоих видов расхода.
          source: isSalary ? 'PAYROLL_PAYOUT' : 'SUPPLIER_PAYMENT',
          sourceId: pre.id,
          registrarType: 'SUPPLIER_PAYMENT',
          registrarId: pre.id,
          note: isSalary
            ? `Выплата зарплаты: ${pre.employeeNameSnapshot ?? ''}`.trim()
            : `Оплата поставщику: ${pre.supplierNameSnapshot ?? ''}`.trim(),
          postedById: employeeId,
        });
        return tx.supplierPayment.update({
          where: { id },
          data: {
            status: SupplierPaymentStatus.PAID,
            paidById: employeeId,
            paidAt: new Date(),
            cashFlowEntryId: entry.id,
          },
          include: { account: true, item: true },
        });
      });
      return this.map(updated);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // INV-4: проводка по этому документу уже есть — двойная оплата
        throw new SupplierPaymentAlreadyPaidException();
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Отмена (DRAFT|APPROVED → CANCELLED)
  // ---------------------------------------------------------------------------

  async cancel(
    id: string,
    dto: CancelSupplierPaymentDto,
    employeeId: string,
  ): Promise<SupplierPaymentDto> {
    const row = await this.prisma.supplierPayment.findUnique({ where: { id } });
    if (!row) throw new SupplierPaymentNotFoundException();
    if (
      row.status !== SupplierPaymentStatus.DRAFT &&
      row.status !== SupplierPaymentStatus.APPROVED
    ) {
      throw new SupplierPaymentInvalidStatusException(
        row.status === SupplierPaymentStatus.PAID
          ? 'Оплаченную заявку нельзя отменить — сторнируйте проводку в журнале.'
          : `Отменить можно только черновик или согласованную заявку. Текущий статус: ${row.status}.`,
      );
    }
    const updated = await this.prisma.supplierPayment.update({
      where: { id },
      data: {
        status: SupplierPaymentStatus.CANCELLED,
        cancelledById: employeeId,
        cancelledAt: new Date(),
        cancelReason: dto.reason ?? null,
      },
      include: { account: true, item: true },
    });
    return this.map(updated);
  }

  // ---------------------------------------------------------------------------
  // Маппер
  // ---------------------------------------------------------------------------

  private map(r: {
    id: string;
    number: string | null;
    kind: ExpensePaymentKind;
    supplierId: string | null;
    supplierNameSnapshot: string | null;
    employeeId: string | null;
    employeeNameSnapshot: string | null;
    payrollPayoutId: string | null;
    purchaseOrderId: string | null;
    purchaseOrderNumberSnapshot: string | null;
    accountId: string;
    itemId: string;
    amount: Prisma.Decimal;
    status: SupplierPaymentStatus;
    comment: string | null;
    cashFlowEntryId: string | null;
    createdAt: Date;
    approvedAt: Date | null;
    paidAt: Date | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    account: { name: string };
    item: { name: string };
  }): SupplierPaymentDto {
    const payeeName =
      r.kind === ExpensePaymentKind.SALARY
        ? r.employeeNameSnapshot
        : r.supplierNameSnapshot;
    return {
      id: r.id,
      number: r.number,
      kind: r.kind,
      supplierId: r.supplierId,
      supplierName: r.supplierNameSnapshot,
      employeeId: r.employeeId,
      employeeName: r.employeeNameSnapshot,
      payrollPayoutId: r.payrollPayoutId,
      payeeName,
      purchaseOrderId: r.purchaseOrderId,
      purchaseOrderNumber: r.purchaseOrderNumberSnapshot,
      accountId: r.accountId,
      accountName: r.account.name,
      itemId: r.itemId,
      itemName: r.item.name,
      amount: r.amount.toFixed(2),
      status: r.status,
      comment: r.comment,
      cashFlowEntryId: r.cashFlowEntryId,
      createdAt: r.createdAt.toISOString(),
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
      cancelReason: r.cancelReason,
    };
  }
}
