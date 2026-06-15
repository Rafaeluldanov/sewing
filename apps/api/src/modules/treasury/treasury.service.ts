import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type {
  CashAccountDto,
  CashFlowItemDto,
  CashFlowEntryDto,
  CashAccountBalanceDto,
  TreasuryBalancesDto,
  CreateCashAccountDto,
  UpdateCashAccountDto,
  ListCashAccountsQuery,
  CreateCashFlowItemDto,
  UpdateCashFlowItemDto,
  ListCashFlowItemsQuery,
  CreateCashFlowEntryDto,
  StornoCashFlowEntryDto,
  ListCashFlowEntriesQuery,
  CashFlowSource,
  TreasurySettingsDto,
  UpdateTreasurySettingsDto,
} from '@sewing/shared/treasury';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CashAccountInactiveException,
  CashAccountNotFoundException,
  CashFlowEntryAlreadyReversedException,
  CashFlowEntryNotFoundException,
  CashFlowEntryStornoNotAllowedException,
  CashFlowItemInactiveException,
  CashFlowItemNotFoundException,
} from '../../common/errors.js';

/**
 * Казначейство, Фаза 0 — журнал движения денежных средств.
 *
 * Единая «книга денег» цеха (касса + расчётный счёт). Реализует
 * инварианты из дизайн-контракта:
 *   - INV-7 (append-only + сторно): `CashFlowEntry` не редактируется;
 *     исправление = сторно-строка с обратным `direction`. Остаток
 *     счёта = Σ(IN) − Σ(OUT) по всем строкам.
 *   - INV-4 (идемпотентность): `@@unique(registrarType, registrarId,
 *     lineNo, isStorno)` + ловля P2002 в `storno()`.
 *   - округление ROUND_HALF_UP до 2 знаков на границе записи (`okr1c`).
 *
 * Аудит на Фазе 0 не подключаем отдельно: append-only журнал с
 * `postedById` сам по себе аудит-след. Бизнес-логику разнесения долга
 * (поставщики/зарплата) добавит Фаза 1.
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Деньги
  // ===========================================================================

  /** Единое округление денег (аналог `okr1c`): ROUND_HALF_UP до 0.01. */
  private okr1c(value: Prisma.Decimal.Value): Prisma.Decimal {
    return new Prisma.Decimal(value).toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );
  }

  private money(value: Prisma.Decimal | null | undefined): string {
    return (value ?? new Prisma.Decimal(0)).toFixed(2);
  }

  /**
   * Tx-aware проводка журнала — для документов Фазы 1 (`SupplierPayment`,
   * `PayrollPayout`), которые проводят движение ДС в своей транзакции.
   * Сумма округляется `okr1c`. Идемпотентность (INV-4) обеспечивает
   * unique-индекс `(registrarType, registrarId, lineNo, isStorno)`:
   * повторное проведение бросит P2002 — ловит вызывающий документ.
   */
  async postEntryTx(
    tx: Prisma.TransactionClient,
    input: {
      accountId: string;
      itemId: string;
      direction: 'IN' | 'OUT';
      amount: Prisma.Decimal.Value;
      source: CashFlowSource;
      sourceId?: string | null;
      registrarType: string;
      registrarId: string;
      lineNo?: number;
      note?: string | null;
      postedById?: string | null;
      postedAt?: Date;
    },
  ): Promise<{ id: string }> {
    return tx.cashFlowEntry.create({
      data: {
        accountId: input.accountId,
        itemId: input.itemId,
        direction: input.direction,
        amount: this.okr1c(input.amount),
        source: input.source,
        sourceId: input.sourceId ?? null,
        isStorno: false,
        registrarType: input.registrarType,
        registrarId: input.registrarId,
        lineNo: input.lineNo ?? 1,
        note: input.note ?? null,
        postedAt: input.postedAt ?? new Date(),
        postedById: input.postedById ?? null,
      },
      select: { id: true },
    });
  }

  // ===========================================================================
  // CashAccount — счета ДС
  // ===========================================================================

  async listAccounts(query: ListCashAccountsQuery): Promise<CashAccountDto[]> {
    const where: Prisma.CashAccountWhereInput = {};
    if (query.kind) where.kind = query.kind;
    if (query.activeOnly) where.isActive = true;
    const rows = await this.prisma.cashAccount.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { kind: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.mapAccount(r));
  }

  async getAccount(id: string): Promise<CashAccountDto> {
    const row = await this.prisma.cashAccount.findUnique({ where: { id } });
    if (!row) throw new CashAccountNotFoundException();
    return this.mapAccount(row);
  }

  async createAccount(dto: CreateCashAccountDto): Promise<CashAccountDto> {
    const row = await this.prisma.cashAccount.create({
      data: {
        kind: dto.kind,
        name: dto.name,
        currency: dto.currency ?? 'RUB',
        comment: dto.comment ?? null,
      },
    });
    return this.mapAccount(row);
  }

  async updateAccount(
    id: string,
    dto: UpdateCashAccountDto,
  ): Promise<CashAccountDto> {
    await this.assertAccountExists(id);
    const row = await this.prisma.cashAccount.update({
      where: { id },
      data: {
        name: dto.name,
        isActive: dto.isActive,
        comment: dto.comment === undefined ? undefined : dto.comment,
      },
    });
    return this.mapAccount(row);
  }

  // ===========================================================================
  // CashFlowItem — статьи ДДС
  // ===========================================================================

  async listItems(query: ListCashFlowItemsQuery): Promise<CashFlowItemDto[]> {
    const where: Prisma.CashFlowItemWhereInput = {};
    if (query.activeOnly) where.isActive = true;
    if (query.direction) {
      // статья применима к направлению, если её намёк совпадает ИЛИ не задан
      where.OR = [{ direction: query.direction }, { direction: null }];
    }
    const rows = await this.prisma.cashFlowItem.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.mapItem(r));
  }

  async createItem(dto: CreateCashFlowItemDto): Promise<CashFlowItemDto> {
    const row = await this.prisma.cashFlowItem.create({
      data: {
        name: dto.name,
        code: dto.code ?? null,
        direction: dto.direction ?? null,
        isOverhead: dto.isOverhead ?? false,
        comment: dto.comment ?? null,
      },
    });
    return this.mapItem(row);
  }

  async updateItem(
    id: string,
    dto: UpdateCashFlowItemDto,
  ): Promise<CashFlowItemDto> {
    const exists = await this.prisma.cashFlowItem.findUnique({ where: { id } });
    if (!exists) throw new CashFlowItemNotFoundException();
    const row = await this.prisma.cashFlowItem.update({
      where: { id },
      data: {
        name: dto.name,
        code: dto.code === undefined ? undefined : dto.code,
        direction: dto.direction === undefined ? undefined : dto.direction,
        isActive: dto.isActive,
        isOverhead: dto.isOverhead,
        comment: dto.comment === undefined ? undefined : dto.comment,
      },
    });
    return this.mapItem(row);
  }

  // ===========================================================================
  // CashFlowEntry — проводки журнала
  // ===========================================================================

  async listEntries(
    query: ListCashFlowEntriesQuery,
  ): Promise<CashFlowEntryDto[]> {
    const where: Prisma.CashFlowEntryWhereInput = {};
    if (query.accountId) where.accountId = query.accountId;
    if (query.itemId) where.itemId = query.itemId;
    if (query.direction) where.direction = query.direction;
    if (query.source) where.source = query.source;
    if (query.includeStorno === false) where.isStorno = false;
    if (query.dateFrom || query.dateTo) {
      where.postedAt = {};
      if (query.dateFrom) where.postedAt.gte = new Date(query.dateFrom);
      if (query.dateTo) where.postedAt.lte = new Date(query.dateTo);
    }
    const rows = await this.prisma.cashFlowEntry.findMany({
      where,
      orderBy: [{ postedAt: 'desc' }, { createdAt: 'desc' }],
      take: query.limit ?? 100,
      include: { account: true, item: true },
    });
    return rows.map((r) => this.mapEntry(r));
  }

  /** Ручная проводка (`registrarType = 'MANUAL'`). */
  async createEntry(
    dto: CreateCashFlowEntryDto,
    employeeId: string,
  ): Promise<CashFlowEntryDto> {
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

    const row = await this.prisma.cashFlowEntry.create({
      data: {
        accountId: dto.accountId,
        itemId: dto.itemId,
        direction: dto.direction,
        amount: this.okr1c(dto.amount),
        source: dto.source ?? 'OTHER',
        sourceId: dto.sourceId ?? null,
        isStorno: false,
        registrarType: 'MANUAL',
        registrarId: randomUUID(),
        lineNo: 1,
        note: dto.note ?? null,
        postedAt: dto.postedAt ? new Date(dto.postedAt) : new Date(),
        postedById: employeeId,
      },
      include: { account: true, item: true },
    });
    return this.mapEntry(row);
  }

  /**
   * Сторно проводки (INV-7): создаёт обратную строку с тем же счётом/
   * статьёй/суммой и противоположным `direction`. Идемпотентно по
   * `@@unique(registrarType='STORNO', registrarId=original.id, ...)`.
   */
  async storno(
    entryId: string,
    dto: StornoCashFlowEntryDto,
    employeeId: string,
  ): Promise<CashFlowEntryDto> {
    const original = await this.prisma.cashFlowEntry.findUnique({
      where: { id: entryId },
    });
    if (!original) throw new CashFlowEntryNotFoundException();
    if (original.isStorno) throw new CashFlowEntryStornoNotAllowedException();

    try {
      const row = await this.prisma.cashFlowEntry.create({
        data: {
          accountId: original.accountId,
          itemId: original.itemId,
          direction: original.direction === 'IN' ? 'OUT' : 'IN',
          amount: original.amount,
          source: original.source,
          sourceId: original.sourceId,
          isStorno: true,
          reversalOfId: original.id,
          registrarType: 'STORNO',
          registrarId: original.id,
          lineNo: 1,
          note: dto.note ?? 'Сторно',
          postedAt: new Date(),
          postedById: employeeId,
        },
        include: { account: true, item: true },
      });
      return this.mapEntry(row);
    } catch (e) {
      // INV-4: повторное сторно одной проводки ловится unique-индексом
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new CashFlowEntryAlreadyReversedException();
      }
      throw e;
    }
  }

  // ===========================================================================
  // Остатки по счетам
  // ===========================================================================

  async balances(): Promise<TreasuryBalancesDto> {
    const accounts = await this.prisma.cashAccount.findMany({
      orderBy: [{ isActive: 'desc' }, { kind: 'asc' }, { name: 'asc' }],
    });
    const grouped = await this.prisma.cashFlowEntry.groupBy({
      by: ['accountId', 'direction'],
      _sum: { amount: true },
    });

    const sums = new Map<string, { in: Prisma.Decimal; out: Prisma.Decimal }>();
    for (const g of grouped) {
      const cur =
        sums.get(g.accountId) ??
        { in: new Prisma.Decimal(0), out: new Prisma.Decimal(0) };
      const amt = g._sum.amount ?? new Prisma.Decimal(0);
      if (g.direction === 'IN') cur.in = cur.in.plus(amt);
      else cur.out = cur.out.plus(amt);
      sums.set(g.accountId, cur);
    }

    let total = new Prisma.Decimal(0);
    const rows: CashAccountBalanceDto[] = accounts.map((a) => {
      const s = sums.get(a.id) ?? {
        in: new Prisma.Decimal(0),
        out: new Prisma.Decimal(0),
      };
      const balance = s.in.minus(s.out);
      if (a.currency === 'RUB') total = total.plus(balance);
      return {
        accountId: a.id,
        accountName: a.name,
        kind: a.kind,
        currency: a.currency,
        inflow: this.money(s.in),
        outflow: this.money(s.out),
        balance: this.money(balance),
      };
    });

    return { accounts: rows, totalBalanceRub: this.money(total) };
  }

  // ===========================================================================
  // Настройки модуля (singleton)
  // ===========================================================================

  async getSettings(): Promise<TreasurySettingsDto> {
    const row = await this.prisma.treasurySettings.findUnique({
      where: { id: 'default' },
    });
    const salaryAccountId = row?.salaryAccountId ?? null;
    const salaryItemId = row?.salaryItemId ?? null;
    const [account, item] = await Promise.all([
      salaryAccountId
        ? this.prisma.cashAccount.findUnique({
            where: { id: salaryAccountId },
            select: { name: true },
          })
        : Promise.resolve(null),
      salaryItemId
        ? this.prisma.cashFlowItem.findUnique({
            where: { id: salaryItemId },
            select: { name: true },
          })
        : Promise.resolve(null),
    ]);
    return {
      salaryAccountId,
      salaryAccountName: account?.name ?? null,
      salaryItemId,
      salaryItemName: item?.name ?? null,
    };
  }

  async updateSettings(
    dto: UpdateTreasurySettingsDto,
  ): Promise<TreasurySettingsDto> {
    if (dto.salaryAccountId) {
      const a = await this.prisma.cashAccount.findUnique({
        where: { id: dto.salaryAccountId },
      });
      if (!a) throw new CashAccountNotFoundException();
      if (!a.isActive) throw new CashAccountInactiveException();
    }
    if (dto.salaryItemId) {
      const it = await this.prisma.cashFlowItem.findUnique({
        where: { id: dto.salaryItemId },
      });
      if (!it) throw new CashFlowItemNotFoundException();
      if (!it.isActive) throw new CashFlowItemInactiveException();
    }
    await this.prisma.treasurySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        salaryAccountId: dto.salaryAccountId ?? null,
        salaryItemId: dto.salaryItemId ?? null,
      },
      update: {
        salaryAccountId:
          dto.salaryAccountId === undefined ? undefined : dto.salaryAccountId,
        salaryItemId:
          dto.salaryItemId === undefined ? undefined : dto.salaryItemId,
      },
    });
    return this.getSettings();
  }

  // ===========================================================================
  // Tx-хелперы для документов Фазы 1 (зарплата)
  // ===========================================================================

  /**
   * Проводка расхода по выдаче зарплаты (`PayrollPayout.ISSUED`).
   * Опт-ин: пишет проводку ТОЛЬКО если в настройках заданы активные
   * зарплатный счёт и статья и сумма > 0. Иначе ничего не делает —
   * выдача выплат работает как раньше (нулевая регрессия).
   * Идемпотентно по `registrarType='PAYROLL_PAYOUT', registrarId=payoutId`.
   */
  async postPayrollPayoutTx(
    tx: Prisma.TransactionClient,
    input: {
      payoutId: string;
      amount: Prisma.Decimal.Value;
      employeeId: string;
      note?: string | null;
    },
  ): Promise<{ id: string } | null> {
    const amount = this.okr1c(input.amount);
    if (amount.lessThanOrEqualTo(0)) return null;

    const settings = await tx.treasurySettings.findUnique({
      where: { id: 'default' },
    });
    const accountId = settings?.salaryAccountId;
    const itemId = settings?.salaryItemId;
    if (!accountId || !itemId) return null;

    const [account, item] = await Promise.all([
      tx.cashAccount.findUnique({ where: { id: accountId } }),
      tx.cashFlowItem.findUnique({ where: { id: itemId } }),
    ]);
    if (!account || !account.isActive || !item || !item.isActive) return null;

    try {
      return await this.postEntryTx(tx, {
        accountId,
        itemId,
        direction: 'OUT',
        amount,
        source: 'PAYROLL_PAYOUT',
        sourceId: input.payoutId,
        registrarType: 'PAYROLL_PAYOUT',
        registrarId: input.payoutId,
        note: input.note ?? 'Выплата зарплаты',
        postedById: input.employeeId,
      });
    } catch (e) {
      // INV-4: проводка по этой выплате уже есть — не двоим
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Сторно проводки по документу-регистратору (для отмены выданной
   * выплаты). Находит исходную проводку по `(registrarType, registrarId,
   * isStorno=false)` и пишет обратную. Идемпотентно: повторное сторно
   * ловится unique-индексом (`stornoRegistrarType, registrarId`).
   * Возвращает `null`, если исходной проводки нет или она уже сторнирована.
   */
  async stornoByRegistrarTx(
    tx: Prisma.TransactionClient,
    input: {
      registrarType: string;
      registrarId: string;
      stornoRegistrarType: string;
      employeeId: string;
      note?: string | null;
    },
  ): Promise<{ id: string } | null> {
    const original = await tx.cashFlowEntry.findFirst({
      where: {
        registrarType: input.registrarType,
        registrarId: input.registrarId,
        isStorno: false,
      },
    });
    if (!original) return null;
    try {
      return await tx.cashFlowEntry.create({
        data: {
          accountId: original.accountId,
          itemId: original.itemId,
          direction: original.direction === 'IN' ? 'OUT' : 'IN',
          amount: original.amount,
          source: original.source,
          sourceId: original.sourceId,
          isStorno: true,
          reversalOfId: original.id,
          registrarType: input.stornoRegistrarType,
          registrarId: input.registrarId,
          lineNo: 1,
          note: input.note ?? 'Сторно',
          postedAt: new Date(),
          postedById: input.employeeId,
        },
        select: { id: true },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return null;
      }
      throw e;
    }
  }

  // ===========================================================================
  // Мапперы / хелперы
  // ===========================================================================

  private async assertAccountExists(id: string): Promise<void> {
    const exists = await this.prisma.cashAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new CashAccountNotFoundException();
  }

  private mapAccount(r: {
    id: string;
    kind: 'BANK' | 'CASH';
    name: string;
    currency: string;
    isActive: boolean;
    comment: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): CashAccountDto {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      currency: r.currency,
      isActive: r.isActive,
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapItem(r: {
    id: string;
    name: string;
    code: string | null;
    direction: 'IN' | 'OUT' | null;
    isActive: boolean;
    isOverhead: boolean;
    comment: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): CashFlowItemDto {
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      direction: r.direction,
      isActive: r.isActive,
      isOverhead: r.isOverhead,
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapEntry(r: {
    id: string;
    accountId: string;
    itemId: string;
    direction: 'IN' | 'OUT';
    amount: Prisma.Decimal;
    source: CashFlowEntryDto['source'];
    sourceId: string | null;
    isStorno: boolean;
    reversalOfId: string | null;
    registrarType: string;
    registrarId: string;
    note: string | null;
    postedAt: Date;
    postedById: string | null;
    createdAt: Date;
    account: { name: string };
    item: { name: string };
  }): CashFlowEntryDto {
    return {
      id: r.id,
      accountId: r.accountId,
      accountName: r.account.name,
      itemId: r.itemId,
      itemName: r.item.name,
      direction: r.direction,
      amount: r.amount.toFixed(2),
      source: r.source,
      sourceId: r.sourceId,
      isStorno: r.isStorno,
      reversalOfId: r.reversalOfId,
      registrarType: r.registrarType,
      registrarId: r.registrarId,
      note: r.note,
      postedAt: r.postedAt.toISOString(),
      postedById: r.postedById,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
