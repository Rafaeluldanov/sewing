import { Injectable } from '@nestjs/common';
import { PayrollPayoutStatus, Prisma, SalaryEntrySource } from '@prisma/client';
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
  PayrollLockedException,
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
 * Бизнес-правила (повременная оплата, см. ADR-0021 rev.2):
 *   - сумма за день = `Σ(длительности ЗАКРЫТЫХ ShiftSession за день) /
 *     3600 × Employee.salaryPerHour`. Открытые смены (`endedAt = null`)
 *     не учитываются — часы по ним ещё неизвестны. Если за день нет ни
 *     одной закрытой смены — запись не создаётся (и существующая не
 *     обнуляется): дисциплина закрытия смены, иначе менеджер правит
 *     сумму руками.
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
   * 1. Загружаем `Employee.compensationType` + `salaryPerHour`. Если
   *    `!isSalaryEligible(...)` (т.е. `PIECEWORK`), сотрудник неактивен
   *    или `salaryPerHour = null` — выходим (последнее аномально, но
   *    падать в START/STOP SHIFT нельзя).
   * 2. Суммируем длительности ЗАКРЫТЫХ `ShiftSession` за этот день
   *    (`computeWorkedSeconds`). Если 0 — выходим: ещё нет закрытых
   *    смен, считать нечего (создавать пустую запись или обнулять
   *    существующую не будем — следующий `stop` пересчитает).
   * 3. `amount = worked / 3600 × salaryPerHour` (округление до копеек).
   * 4. `upsert` по `(employeeId, date, source = SHIFT_DAY)`:
   *      - update: только если `editedManually = false` и запись не
   *        в выплате → `amount` + `workedSeconds`;
   *      - create: новая запись с `source = SHIFT_DAY`, `amount`,
   *        `workedSeconds`.
   *    Если `editedManually = true` (или запись locked) — ничего не
   *    трогаем, возвращаем как есть.
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
        salaryPerHour: true,
      },
    });
    if (!employee || !employee.active) return null;
    if (!isSalaryEligible(employee.compensationType)) return null;
    if (employee.salaryPerHour === null) {
      // SALARY/MIXED без почасовой ставки — на момент sync это аномалия
      // (инвариант `requiresSalaryRate` её запрещает), но ронять
      // `start/stop shift` нельзя. Просто ничего не делаем.
      return null;
    }

    // Повременная оплата: считаем фактически отработанные секунды за
    // день ТОЛЬКО по закрытым сменам (`endedAt != null`). Открытая
    // смена в расчёт не идёт — пока сотрудник её не закрыл, часы
    // неизвестны. Несколько закрытых смен за день суммируются: активная
    // смена у человека одна (partial-unique индекс), интервалы не
    // перекрываются, поэтому сумма длительностей = реальное время.
    const worked = await computeWorkedSeconds(
      tx,
      employeeId,
      day,
      endOfDay(date),
    );
    if (worked <= 0) {
      // Ещё нет ни одной закрытой смены за день (например, sync на
      // `start`, когда смену только открыли). Не создаём пустую запись
      // и не обнуляем существующую — следующий `stop` пересчитает.
      return null;
    }

    const amount = hourlyAmount(employee.salaryPerHour, worked);

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
      // PHASE 3 STEP 3: locked payout lines are immutable; auto-sync
      // must not rewrite paid salary. Если запись уже попала в выплату
      // со статусом ISSUED/ACKNOWLEDGED — silent skip, не падаем
      // ошибкой в `start/stop shift` flow. DRAFT не блокирует:
      // черновик ещё пересобирается.
      if (await isSalaryEntryLocked(tx, existing.id)) {
        return toDto(existing);
      }
      const updated = await tx.salaryEntry.update({
        where: { id: existing.id },
        data: { amount, workedSeconds: worked },
        include: salaryInclude,
      });
      return toDto(updated);
    }

    try {
      const created = await tx.salaryEntry.create({
        data: {
          employeeId,
          date: day,
          amount,
          workedSeconds: worked,
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

  /**
   * «Подкрой» (`SalaryEntrySource.RECUT`): почасовая ДОПЛАТА сверх смены
   * за завершённые подкрои сотрудника за день (`model RecutSession`).
   *
   * Считается ОТДЕЛЬНОЙ строкой ведомости `(employee, date, RECUT)` — в
   * дополнение к `SHIFT_DAY`. Время подкроя при этом НЕ вычитается из
   * часов смены: подкрой идёт внутри смены, но оплачивается доплатой
   * сверху (сознательное решение, см. `RecutService`). Сумма =
   * `Σ(workedSeconds завершённых подкроев за день) / 3600 ×
   * Employee.salaryPerHour`.
   *
   * Полностью зеркалит `syncDailySalary` (та же эксплуатация
   * `editedManually` / lock-by-line / P2002-гонки), меняется лишь
   * источник времени (`computeRecutSeconds`) и `source`. Вызывается
   * `RecutService` fail-soft на завершении/отмене подкроя.
   */
  async syncDailyRecut(
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
        salaryPerHour: true,
      },
    });
    if (!employee || !employee.active) return null;
    // Оплата подкроя — почасовая, поэтому нужна та же почасовая
    // eligibility, что и у смены: SALARY/MIXED со ставкой. Чистому
    // PIECEWORK без `salaryPerHour` строку не создаём (подкрой всё равно
    // залогирован в `RecutSession`, но денег без часовой ставки нет).
    if (!isSalaryEligible(employee.compensationType)) return null;
    if (employee.salaryPerHour === null) return null;

    const worked = await computeRecutSeconds(
      tx,
      employeeId,
      day,
      endOfDay(date),
    );
    if (worked <= 0) {
      // Ещё нет ни одного завершённого подкроя за день (например, sync
      // на отмене единственного, ещё не завершённого подкроя). Пустую
      // запись не создаём.
      return null;
    }

    const amount = hourlyAmount(employee.salaryPerHour, worked);

    const existing = await tx.salaryEntry.findUnique({
      where: {
        SalaryEntry_employee_date_source_uniq: {
          employeeId,
          date: day,
          source: SalaryEntrySource.RECUT,
        },
      },
      include: salaryInclude,
    });

    if (existing) {
      if (existing.editedManually) return toDto(existing);
      if (await isSalaryEntryLocked(tx, existing.id)) return toDto(existing);
      const updated = await tx.salaryEntry.update({
        where: { id: existing.id },
        data: { amount, workedSeconds: worked },
        include: salaryInclude,
      });
      return toDto(updated);
    }

    try {
      const created = await tx.salaryEntry.create({
        data: {
          employeeId,
          date: day,
          amount,
          workedSeconds: worked,
          source: SalaryEntrySource.RECUT,
        },
        include: salaryInclude,
      });
      return toDto(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await tx.salaryEntry.findUnique({
          where: {
            SalaryEntry_employee_date_source_uniq: {
              employeeId,
              date: day,
              source: SalaryEntrySource.RECUT,
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
   *     пересчитать `amount` по почасовой ставке за тот же день
   *     (закрытые смены × `salaryPerHour`). Если ставка не задана,
   *     бросаем `SALARY_RATE_MISSING` — иначе пришлось бы обнулить
   *     сумму, что менеджер вряд ли имел в виду.
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

    // PHASE 3 STEP 3 — lock-by-line. Если эта SalaryEntry уже включена
    // в `PayrollPayoutLine` выплаты со статусом `ISSUED` или
    // `ACKNOWLEDGED`, ручная правка (включая `reset = true`) должна
    // отдавать 409 `PAYROLL_LOCKED`. `DRAFT` не блокирует — черновик
    // ещё пересобирается; `CANCELLED` тоже не блокирует — snapshot
    // снят, строка свободна. См. JSDoc `PayrollLockedException`.
    if (await isSalaryEntryLocked(this.prisma, id)) {
      throw new PayrollLockedException();
    }

    if (dto.reset) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: entry.employeeId },
        select: { salaryPerHour: true },
      });
      if (!employee || employee.salaryPerHour === null) {
        throw new SalaryReentryWithoutRateException();
      }
      // Возврат под автоматику = пересчёт по почасовой ставке за тот же
      // день (по закрытым сменам), а не «плоская ставка за смену».
      const worked = await computeWorkedSeconds(
        this.prisma,
        entry.employeeId,
        startOfDay(entry.date),
        endOfDay(entry.date),
      );
      const newAmount = hourlyAmount(employee.salaryPerHour, worked);
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.salaryEntry.update({
          where: { id },
          data: {
            amount: newAmount,
            workedSeconds: worked,
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
    workedSeconds: row.workedSeconds ?? null,
    source: row.source,
    editedManually: row.editedManually,
    managerComment: row.managerComment ?? null,
    editedByEmployeeId: row.editedByEmployeeId,
    editedByFullName: row.editedBy?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * PHASE 3 STEP 3 — lock-by-line guard. `true`, если данная
 * `SalaryEntry` уже привязана к `PayrollPayoutLine`, чьим родителем
 * является `PayrollPayout` со статусом `ISSUED` или `ACKNOWLEDGED`.
 *
 * `DRAFT` сознательно не блокирует: черновик ещё пересобирается
 * (`PayrollPayoutsService.recompute`), и менять начисление в нём
 * безопасно. `CANCELLED` тоже не блокирует: snapshot снят, строка
 * свободна — это та же семантика, что и для активной уникальности
 * (см. `PAYROLL_PAYOUT_LINE_ALREADY_INCLUDED`).
 *
 * Делается одним COUNT-запросом, чтобы guard оставался дешёвым и в
 * `updateManually`, и в горячем пути `syncDailySalary`.
 */
async function isSalaryEntryLocked(
  tx: Prisma.TransactionClient | PrismaService,
  salaryEntryId: string,
): Promise<boolean> {
  const found = await tx.payrollPayoutLine.count({
    where: {
      salaryEntryId,
      payout: {
        status: {
          in: [PayrollPayoutStatus.ISSUED, PayrollPayoutStatus.ACKNOWLEDGED],
        },
      },
    },
  });
  return found > 0;
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

/**
 * Сумма отработанных секунд за день по ЗАКРЫТЫМ сменам сотрудника.
 *
 * Берём только `ShiftSession` с `endedAt != null`, начавшиеся в
 * пределах `[dayStart, dayEnd]`, и складываем длительности
 * `endedAt − startedAt`. Активная смена у сотрудника одна (partial-
 * unique индекс `shift_session_active_employee_uniq`), значит
 * интервалы не перекрываются и простая сумма = реально отработанное
 * время без задвоений. Открытые смены игнорируются — часы по ним
 * ещё неизвестны (повременка «строго start→end»).
 */
async function computeWorkedSeconds(
  tx: Prisma.TransactionClient | PrismaService,
  employeeId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<number> {
  const sessions = await tx.shiftSession.findMany({
    where: {
      employeeId,
      startedAt: { gte: dayStart, lte: dayEnd },
      endedAt: { not: null },
    },
    select: { startedAt: true, endedAt: true },
  });
  let total = 0;
  for (const s of sessions) {
    if (!s.endedAt) continue;
    const sec = Math.floor((s.endedAt.getTime() - s.startedAt.getTime()) / 1000);
    if (sec > 0) total += sec;
  }
  return total;
}

/**
 * Сумма секунд завершённых подкроев (`RecutSession`, `status = DONE`)
 * сотрудника за день. Берём зафиксированный при завершении
 * `workedSeconds`; сессии, начавшиеся в пределах `[dayStart, dayEnd]`.
 * `ACTIVE`/`CANCELLED` не учитываются (первые ещё идут, вторые не
 * оплачиваются). Используется `SalaryService.syncDailyRecut`.
 */
async function computeRecutSeconds(
  tx: Prisma.TransactionClient | PrismaService,
  employeeId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<number> {
  const sessions = await tx.recutSession.findMany({
    where: {
      employeeId,
      status: 'DONE',
      startedAt: { gte: dayStart, lte: dayEnd },
    },
    select: { workedSeconds: true },
  });
  let total = 0;
  for (const s of sessions) {
    if (s.workedSeconds && s.workedSeconds > 0) total += s.workedSeconds;
  }
  return total;
}

/**
 * Денежная сумма повременной оплаты: `workedSeconds / 3600 ×
 * ratePerHour`, округлённая до копеек. Decimal-арифметика — без
 * float-погрешности на копейках.
 */
function hourlyAmount(
  ratePerHour: Prisma.Decimal,
  workedSeconds: number,
): Prisma.Decimal {
  const hours = new Prisma.Decimal(workedSeconds).div(3600);
  return roundMoney(new Prisma.Decimal(ratePerHour).mul(hours));
}

function roundMoneyNumber(
  amount: Prisma.Decimal | number | null | undefined,
): number {
  if (amount === null || amount === undefined) return 0;
  if (typeof amount === 'number') return Math.round(amount * 100) / 100;
  return Number(amount.toFixed(2));
}
