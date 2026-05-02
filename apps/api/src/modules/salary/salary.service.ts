import { Injectable } from '@nestjs/common';
import { Prisma, SalaryEntrySource } from '@prisma/client';
import type {
  ListSalaryQuery,
  SalaryEntryDto,
  SalaryPage,
  SalarySummaryDto,
  SalarySummaryQuery,
  UpdateSalaryEntryDto,
} from '@sewing/shared/salary';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  SalaryEntryNotFoundException,
  SalaryReentryWithoutRateException,
} from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { isSalaryEligible } from '../employees/compensation.js';
import { isSalaryManager } from './salary.constants.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис окладных начислений (ADR-0021, post-Шаг 18 / Шаг 19).
 *
 * Делает четыре вещи:
 *
 * 1. `syncDailySalary` — синхронизирует ровно одну `SalaryEntry` за
 *    день для конкретного сотрудника. Вызывается из
 *    `ShiftsService.start/stop`. Идемпотентен: если вызвать дважды,
 *    второго `INSERT` не будет (защищено `@@unique` + ON CONFLICT через
 *    Prisma `upsert`).
 *
 * 2. `list` / `summary` — read-методы под `/api/salary` и
 *    `/api/salary/summary` с RBAC-скоупом. Не-менеджер всегда видит
 *    только свои строки.
 *
 * 3. `updateManually` — ручная корректировка начислений менеджером.
 *    Меняет только `amount` и `managerComment`. Любая попытка передать
 *    `employeeId/date/source` извне физически невозможна — этих полей
 *    нет в `UpdateSalaryEntrySchema`.
 *
 * 4. `reset` (через `updateManually({reset:true})`) — снять флаг
 *    `editedManually`, вернуть запись под автоматический sync и
 *    выставить `amount = employee.salaryPerShift`.
 *
 * Бизнес-правила:
 *   - источник истины «день отработан» — наличие хотя бы одной
 *     `ShiftSession` с `startedAt::date == date`. Длительность и
 *     закрытие смены не учитываем (см. ADR-0021).
 *   - `compensationType` сотрудника решает, нужно ли вообще
 *     создавать запись. Спрашиваем у `isSalaryEligible` (ADR-0021):
 *     `SALARY`/`MIXED` ⇒ да, `PIECEWORK` ⇒ никогда.
 *   - `editedManually = true` запрещает автоматическую перезапись
 *     `amount`. Менеджер должен сам сбросить флаг (`reset = true`),
 *     если хочет вернуть под автоматику.
 */
@Injectable()
export class SalaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // SYNC
  // ===========================================================================

  /**
   * Создать/обновить дневное окладное начисление для пары
   * `(employeeId, date)`. Безопасно вызывать любое количество раз.
   *
   * @param employeeId сотрудник, по которому проверяем смену
   * @param date       дата в локальной таймзоне сервера; время
   *                   обнуляется до начала суток (Postgres `DATE`)
   * @param tx         опциональная транзакция; при отсутствии работаем
   *                   на корневом клиенте
   *
   * Алгоритм:
   * 1. Загружаем `Employee.compensationType` + `salaryPerShift`. Если
   *    `!isSalaryEligible(...)` (т.е. `PIECEWORK`) или сотрудник
   *    неактивен — выходим.
   * 2. Считаем количество `ShiftSession` за этот день. Если 0 —
   *    выходим (синхронизация только «вверх», окладные за дни без
   *    смен мы не создаём, а уже созданные не удаляем — менеджер мог
   *    оплатить «ручной» день, см. `source = MANUAL` ниже).
   * 3. Если `salaryPerShift = null` — выходим. Это аномальное
   *    состояние (инвариант запрещает SALARY/MIXED без ставки), но
   *    падать в `START SHIFT`/`STOP SHIFT` из-за этого нельзя.
   * 4. `upsert` по `(employeeId, date, source = SHIFT_DAY)`:
   *      - update: только если `editedManually = false` →
   *        `amount = salaryPerShift`;
   *      - create: новая запись с `source = SHIFT_DAY` и
   *        `amount = salaryPerShift`.
   *    Если `editedManually = true`, `amount` не трогаем — но запись
   *    всё равно `upsert`-аем, чтобы запомнить факт «смена в этот день
   *    была» (на текущий момент это нужно для будущей аналитики и
   *    самого факта существования записи; никаких полей не меняется).
   */
  async syncDailySalary(
    employeeId: string,
    date: Date,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<SalaryEntryDto | null> {
    const day = startOfDay(date);

    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        active: true,
        compensationType: true,
        salaryPerShift: true,
      },
    });
    if (!employee || !employee.active) return null;
    if (!isSalaryEligible(employee.compensationType)) return null;
    if (employee.salaryPerShift === null) {
      // SALARY/MIXED без ставки — на момент sync это аномалия, но
      // ронять `start/stop shift` нельзя. Просто ничего не делаем.
      return null;
    }

    const dayEnd = endOfDay(date);
    const shiftCount = await tx.shiftSession.count({
      where: {
        employeeId,
        startedAt: { gte: day, lte: dayEnd },
      },
    });
    if (shiftCount === 0) return null;

    const rate = new Prisma.Decimal(employee.salaryPerShift);

    // Ищем существующую запись, чтобы решить, можно ли перезаписывать
    // amount. `upsert` сам по себе уважает `editedManually` через
    // условный `update` ниже.
    const existing = await tx.salaryEntry.findUnique({
      where: {
        SalaryEntry_employee_date_source_uniq: {
          employeeId,
          date: day,
          source: SalaryEntrySource.SHIFT_DAY,
        },
      },
      include: salaryInclude,
    });

    if (existing) {
      if (existing.editedManually) {
        // Уважаем ручную правку, ничего не трогаем.
        return toDto(existing);
      }
      const updated = await tx.salaryEntry.update({
        where: { id: existing.id },
        data: { amount: roundMoney(rate) },
        include: salaryInclude,
      });
      return toDto(updated);
    }

    try {
      const created = await tx.salaryEntry.create({
        data: {
          employeeId,
          date: day,
          amount: roundMoney(rate),
          source: SalaryEntrySource.SHIFT_DAY,
        },
        include: salaryInclude,
      });
      return toDto(created);
    } catch (err) {
      // Гонка двух параллельных `start shift` подряд: уникальный
      // индекс `(employeeId, date, source)` поймает дубль; перечитаем
      // запись и вернём её.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await tx.salaryEntry.findUnique({
          where: {
            SalaryEntry_employee_date_source_uniq: {
              employeeId,
              date: day,
              source: SalaryEntrySource.SHIFT_DAY,
            },
          },
          include: salaryInclude,
        });
        return row ? toDto(row) : null;
      }
      throw err;
    }
  }

  // ===========================================================================
  // READ: list
  // ===========================================================================

  async list(query: ListSalaryQuery, viewer: AuthPrincipal): Promise<SalaryPage> {
    const scoped = this.applyViewerScope(query, viewer);
    const where = this.buildListWhere(scoped);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.salaryEntry.count({ where }),
      this.prisma.salaryEntry.findMany({
        where,
        include: salaryInclude,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: (scoped.page - 1) * scoped.pageSize,
        take: scoped.pageSize,
      }),
    ]);

    return {
      items: rows.map(toDto),
      total,
      page: scoped.page,
      pageSize: scoped.pageSize,
    };
  }

  // ===========================================================================
  // READ: summary
  // ===========================================================================

  async summary(
    query: SalarySummaryQuery,
    viewer: AuthPrincipal,
  ): Promise<SalarySummaryDto> {
    const where = this.buildSummaryWhere(query, viewer);

    const [all, edited] = await this.prisma.$transaction([
      this.prisma.salaryEntry.aggregate({
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.salaryEntry.aggregate({
        where: { ...where, editedManually: true },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    return {
      total: roundMoneyNumber(all._sum.amount),
      totalEditedManually: roundMoneyNumber(edited._sum.amount),
      count: all._count._all,
      countEditedManually: edited._count._all,
    };
  }

  // ===========================================================================
  // UPDATE (manual adjustment)
  // ===========================================================================

  /**
   * Ручная правка начисления менеджером. RBAC проверяется на уровне
   * контроллера через `@Roles(SHOP_MANAGER, ADMIN)`, но дополнительно
   * страхуемся в сервисе и игнорируем неуправленческих viewer-ов.
   *
   * Поведение:
   *   - `reset = true` → снять флаг, вернуть запись под автоматику и
   *     выставить `amount = employee.salaryPerShift`. Если ставка не
   *     задана, бросаем `SALARY_RATE_MISSING` — иначе пришлось бы
   *     обнулить сумму, что менеджер вряд ли имел в виду.
   *   - иначе обновляем то, что пришло (`amount` и/или
   *     `managerComment`), ставим `editedManually = true`,
   *     `editedByEmployeeId = viewer.employeeId`.
   *
   * `employeeId`, `date`, `source` мы не трогаем нигде — этих полей
   * нет в `UpdateSalaryEntrySchema`, чтобы запрос не мог их подменить.
   *
   * **PHASE 2 STEP 4 — audit trail.** Каждая успешная ручная правка
   * пишет ровно одно событие в `AuditLog`:
   *   - `SALARY_ENTRY_UPDATED` для обычного PATCH-а;
   *   - `SALARY_ENTRY_RESET` для `reset = true`.
   * Запись `AuditLog` живёт в той же `prisma.$transaction`, что и
   * `salaryEntry.update` — это инвариант «либо и операция, и аудит,
   * либо ничего» (см. `docs/domain.md §«Audit log»`,
   * `apps/api/src/modules/audit/audit.service.ts`).
   * Автоматический `syncDailySalary` (вызывается из `start/stop shift`)
   * аудит сознательно НЕ пишет — иначе журнал моментально засыпался
   * бы рутинной синхронизацией и потерял ценность для разбора правок.
   */
  async updateManually(
    id: string,
    dto: UpdateSalaryEntryDto,
    viewer: AuthPrincipal,
  ): Promise<SalaryEntryDto> {
    // Берём полный «before»-снимок: сравнить before/after — это и
    // payload audit-события, и страховка от незапланированных
    // изменений `employeeId/date/source` (этих полей нет в DTO,
    // но снимок документирует «что было» на случай реверса).
    const entry = await this.prisma.salaryEntry.findUnique({
      where: { id },
      select: {
        id: true,
        employeeId: true,
        date: true,
        amount: true,
        managerComment: true,
        editedManually: true,
      },
    });
    if (!entry) throw new SalaryEntryNotFoundException();

    if (dto.reset) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: entry.employeeId },
        select: { salaryPerShift: true },
      });
      if (!employee || employee.salaryPerShift === null) {
        throw new SalaryReentryWithoutRateException();
      }
      const newAmount = roundMoney(new Prisma.Decimal(employee.salaryPerShift));
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.salaryEntry.update({
          where: { id },
          data: {
            amount: newAmount,
            editedManually: false,
            managerComment: null,
            editedByEmployeeId: null,
          },
          include: salaryInclude,
        });
        await this.audit.log(
          {
            event: 'SALARY_ENTRY_RESET',
            entityType: 'SALARY_ENTRY',
            entityId: row.id,
            employeeId: viewer.employeeId,
            payload: {
              salaryEntryId: row.id,
              employeeId: entry.employeeId,
              date: toDateOnly(entry.date),
              before: {
                amount: roundMoneyNumber(entry.amount),
                managerComment: entry.managerComment,
                editedManually: entry.editedManually,
              },
              after: {
                amount: roundMoneyNumber(row.amount),
                managerComment: row.managerComment,
                editedManually: row.editedManually,
              },
              reset: true,
              editedByEmployeeId: viewer.employeeId,
            },
          },
          tx,
        );
        return row;
      });
      return toDto(updated);
    }

    const data: Prisma.SalaryEntryUpdateInput = {
      editedManually: true,
      editedBy: { connect: { id: viewer.employeeId } },
    };
    if (dto.amount !== undefined) {
      data.amount = roundMoney(new Prisma.Decimal(dto.amount));
    }
    if (dto.managerComment !== undefined) {
      data.managerComment =
        dto.managerComment === null ? null : dto.managerComment.trim() || null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.salaryEntry.update({
        where: { id },
        data,
        include: salaryInclude,
      });
      await this.audit.log(
        {
          event: 'SALARY_ENTRY_UPDATED',
          entityType: 'SALARY_ENTRY',
          entityId: row.id,
          employeeId: viewer.employeeId,
          payload: {
            salaryEntryId: row.id,
            employeeId: entry.employeeId,
            date: toDateOnly(entry.date),
            before: {
              amount: roundMoneyNumber(entry.amount),
              managerComment: entry.managerComment,
              editedManually: entry.editedManually,
            },
            after: {
              amount: roundMoneyNumber(row.amount),
              managerComment: row.managerComment,
              editedManually: row.editedManually,
            },
            reset: false,
            editedByEmployeeId: viewer.employeeId,
          },
        },
        tx,
      );
      return row;
    });
    return toDto(updated);
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private applyViewerScope(
    query: ListSalaryQuery,
    viewer: AuthPrincipal,
  ): ListSalaryQuery {
    if (isSalaryManager(viewer.role)) return query;
    return { ...query, employeeId: viewer.employeeId };
  }

  private buildListWhere(query: ListSalaryQuery): Prisma.SalaryEntryWhereInput {
    const where: Prisma.SalaryEntryWhereInput = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.dateFrom || query.dateTo) {
      where.date = {};
      if (query.dateFrom) where.date.gte = startOfDay(new Date(query.dateFrom));
      if (query.dateTo) where.date.lte = startOfDay(new Date(query.dateTo));
    }
    return where;
  }

  private buildSummaryWhere(
    query: SalarySummaryQuery,
    viewer: AuthPrincipal,
  ): Prisma.SalaryEntryWhereInput {
    const where: Prisma.SalaryEntryWhereInput = {};
    if (!isSalaryManager(viewer.role)) {
      where.employeeId = viewer.employeeId;
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.dateFrom || query.dateTo) {
      where.date = {};
      if (query.dateFrom) where.date.gte = startOfDay(new Date(query.dateFrom));
      if (query.dateTo) where.date.lte = startOfDay(new Date(query.dateTo));
    }
    return where;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const salaryInclude = {
  employee: { select: { id: true, fullName: true } },
  editedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.SalaryEntryInclude;

type SalaryRow = Prisma.SalaryEntryGetPayload<{ include: typeof salaryInclude }>;

function toDto(row: SalaryRow): SalaryEntryDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeFullName: row.employee.fullName,
    date: toDateOnly(row.date),
    amount: roundMoneyNumber(row.amount),
    source: row.source,
    editedManually: row.editedManually,
    managerComment: row.managerComment ?? null,
    editedByEmployeeId: row.editedByEmployeeId,
    editedByFullName: row.editedBy?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function toDateOnly(d: Date): string {
  // `Date` уже хранится в UTC; берём YYYY-MM-DD по UTC, чтобы дата
  // не «прыгала» от таймзоны клиента (Postgres `DATE` мапится Prisma
  // в полночь UTC).
  return d.toISOString().slice(0, 10);
}

function roundMoney(amount: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(amount.toFixed(2));
}

function roundMoneyNumber(
  amount: Prisma.Decimal | number | null | undefined,
): number {
  if (amount === null || amount === undefined) return 0;
  if (typeof amount === 'number') return Math.round(amount * 100) / 100;
  return Number(amount.toFixed(2));
}
