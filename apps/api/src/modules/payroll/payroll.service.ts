import { Injectable, NotFoundException } from '@nestjs/common';
import { EntryStatus, Prisma, type Role } from '@prisma/client';
import type {
  PayrollDailyEmployeeRowDto,
  PayrollDailyPageDto,
  PayrollDailyQuery,
  PayrollDailySummaryDto,
  PayrollDebtEmployeeRowDto,
  PayrollDebtsPageDto,
  PayrollDebtsQuery,
  PayrollDebtsSummaryDto,
  PayrollEmployeeDetailDto,
  PayrollEmployeeOperationEntryDto,
  PayrollEmployeeQuery,
  PayrollEmployeeSalaryEntryDto,
  PayrollEmployeeShiftDto,
  PayrollPeriodEmployeeRowDto,
  PayrollPeriodPageDto,
  PayrollPeriodQuery,
  PayrollPeriodSummaryDto,
} from '@sewing/shared/payroll';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Read-only payroll-агрегатор (PHASE 1).
 *
 * Сервис **только читает** уже существующие таблицы и собирает из них
 * управленческие сводки:
 *
 *   - `OperationEntry` — сдельные начисления (раскрой / пошив);
 *   - `SalaryEntry` — окладные начисления (день со сменой);
 *   - `ShiftSession` — факт смены за день;
 *   - `Employee` + `Order.companyDivision` — атрибуты для фильтров /
 *     группировок.
 *
 * Что сервис НЕ делает (и в PHASE 1 НЕ должен):
 *   - не пишет в БД, не дёргает `EarningsService` / `SalaryService`;
 *   - не меняет статусы / суммы / lifecycle;
 *   - не пишет `AuditLog` (read-only — журналировать нечего).
 *
 * Источники истины — те же, что и у `/api/earnings`:
 *   - сдельщина: `OperationEntry.createdAt` для попадания в период,
 *     `OperationEntry.amount` уже округлён до 2 знаков;
 *   - оклад: `SalaryEntry.date` для попадания в период;
 *   - смены: `ShiftSession.startedAt::date`. «Дни на смене» —
 *     количество **уникальных** дат `startedAt`, как у
 *     `SalaryService.syncDailySalary`.
 *
 * Связанные документы:
 *   - `docs/api.md §10c`, `docs/domain.md §10.6`,
 *     `docs/screens.md §12a`.
 */
@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // READ: period
  // ===========================================================================

  /**
   * Ведомость по сотрудникам за период (`/api/payroll/period`).
   *
   * Алгоритм:
   *   1. Считаем «список релевантных сотрудников» — те, у кого в
   *      периоде есть `OperationEntry`, `SalaryEntry` или
   *      `ShiftSession`. Это закрывает все три контура: PIECEWORK,
   *      SALARY, MIXED. Окладные роли без смен в период не появляются —
   *      платить им не за что.
   *   2. Дополнительно фильтруем по `role` / `divisionCode` /
   *      `employeeId`, если они есть в query.
   *   3. Параллельно тянем три агрегата (groupBy + count) по
   *      сотрудникам и складываем их в `PayrollPeriodEmployeeRowDto`.
   *   4. Считаем общий summary по тому же набору сотрудников.
   *   5. Пагинируем уже собранный массив (server-side, без round-trip
   *      в БД за «лишними» сотрудниками — на MVP это дёшево, и любой
   *      менеджер с 100 сотрудниками получит ответ за миллисекунды).
   *
   * `divisionCode` фильтрует:
   *   - сдельную часть — через `OperationEntry.passport.order.
   *     companyDivision.code` (фактическое подразделение заказа);
   *   - окладную часть и смены — через `Employee.companyDivision.code`
   *     (PHASE 2 STEP 2): сотрудник прибит к подразделению, и его
   *     дневной оклад ходит за ним. Сотрудники без `companyDivisionId`
   *     не попадают в выдачу при `divisionCode`-фильтре.
   *
   * Если у сотрудника есть и сдельщина в заказе MARKETPLACE, и
   * привязка к OTHER — при выборе MARKETPLACE он будет виден со
   * сдельщиной, при выборе OTHER — с окладом. Это сознательно: фильтр
   * показывает «деньги, относящиеся к подразделению», а не «всех
   * сотрудников подразделения».
   */
  async period(query: PayrollPeriodQuery): Promise<PayrollPeriodPageDto> {
    const { from, to, dayFrom, dayTo } = parsePeriodWindow(
      query.dateFrom,
      query.dateTo,
    );

    // Базовые фильтры для трёх таблиц. Сдельщину фильтруем по `createdAt`
    // (точное datetime), оклад — по `date` (DATE без времени). `role`
    // фильтрует по принадлежащему сотруднику, поэтому для сдельщины
    // мы заводим вложенный фильтр `employee.role`.
    const earningsWhere: Prisma.OperationEntryWhereInput = {
      createdAt: { gte: from, lte: to },
    };
    const salaryWhere: Prisma.SalaryEntryWhereInput = {
      date: { gte: dayFrom, lte: dayTo },
    };
    const shiftWhere: Prisma.ShiftSessionWhereInput = {
      startedAt: { gte: from, lte: to },
    };
    if (query.employeeId) {
      earningsWhere.employeeId = query.employeeId;
      salaryWhere.employeeId = query.employeeId;
      shiftWhere.employeeId = query.employeeId;
    }
    if (query.role) {
      // `Employee.role` — enum, но валидируем строкой и приводим — это
      // дешевле, чем держать тут whitelist в shared-схеме. Если строка
      // не совпадает ни с одной ролью, Prisma просто вернёт пустой
      // результат — не падаем.
      const role = query.role as Role;
      earningsWhere.employee = { role };
      salaryWhere.employee = { role };
      shiftWhere.employee = { role };
    }
    if (query.divisionCode) {
      // PHASE 2 STEP 2: фильтр работает на двух осях.
      //   - Сдельщина прибита к заказу → подразделению через
      //     паспорт. Используем существующий relation путь.
      //   - Оклад / смены прибиты к самому сотруднику через
      //     `Employee.companyDivisionId` (нововведение шага).
      // Это отражено в `relevantIds` ниже: окладника без сдельщины
      // мы тоже включаем, если он лично привязан к этому
      // подразделению.
      earningsWhere.passport = {
        order: { companyDivision: { code: query.divisionCode } },
      };
      salaryWhere.employee = {
        ...(salaryWhere.employee as Prisma.EmployeeWhereInput | undefined),
        companyDivision: { code: query.divisionCode },
      };
      shiftWhere.employee = {
        ...(shiftWhere.employee as Prisma.EmployeeWhereInput | undefined),
        companyDivision: { code: query.divisionCode },
      };
    }
    if (query.status) {
      // Только сдельщина имеет статус. Маппим как в EarningsService:
      // legacy PENDING сюда же подмешиваем для совместимости.
      if (query.status === 'PENDING_RELEASE') {
        earningsWhere.status = {
          in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING],
        };
      } else {
        earningsWhere.status = EntryStatus[query.status];
      }
    }

    // 1. Релевантные сотрудники — те, у кого В ПЕРИОДЕ есть хоть что-то.
    //    PHASE 2 STEP 2: `divisionCode` фильтрует SalaryEntry/ShiftSession
    //    через `Employee.companyDivision.code`, а не отбрасывает их
    //    целиком, как было до шага. Это позволяет окладника без
    //    сдельщины показать в его «своём» подразделении.
    const [earningsEmps, salaryEmps, shiftEmps] = await Promise.all([
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: earningsWhere,
      }),
      this.prisma.salaryEntry.groupBy({
        by: ['employeeId'],
        where: salaryWhere,
      }),
      this.prisma.shiftSession.groupBy({
        by: ['employeeId'],
        where: shiftWhere,
      }),
    ]);
    const relevantIds = new Set<string>();
    for (const r of earningsEmps) relevantIds.add(r.employeeId);
    for (const r of salaryEmps) relevantIds.add(r.employeeId);
    for (const r of shiftEmps) relevantIds.add(r.employeeId);
    if (relevantIds.size === 0) {
      return {
        items: [],
        summary: emptyPeriodSummary(),
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    }

    // 2. Подгружаем карточки сотрудников.
    //    PHASE 2 STEP 2: тащим `companyDivision` — нужно как fallback
    //    для строки, у которой за период не было сдельных начислений
    //    (только оклад/смены), и для строк с `Order.companyDivisionId
    //    = NULL`.
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: Array.from(relevantIds) } },
      select: {
        id: true,
        fullName: true,
        login: true,
        role: true,
        compensationType: true,
        active: true,
        companyDivision: { select: { id: true, code: true, name: true } },
      },
    });
    const empById = new Map(employees.map((e) => [e.id, e]));

    // 3. Параллельно собираем агрегаты:
    //    - сдельщина approved / pending / count;
    //    - оклад: total / edited / count / editedCount;
    //    - shift dates per employee (для daysOnShift).
    const [
      pieceworkApprovedAgg,
      pieceworkPendingAgg,
      pieceworkCountAgg,
      salaryAgg,
      salaryEditedAgg,
      shiftRows,
      pieceworkDivisionRows,
      payoutCoverageRows,
      payoutAdjustRows,
    ] = await Promise.all([
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: { ...earningsWhere, status: EntryStatus.APPROVED },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: {
          ...earningsWhere,
          status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: earningsWhere,
        _count: { _all: true },
      }),
      this.prisma.salaryEntry.groupBy({
        by: ['employeeId'],
        where: { ...salaryWhere, employeeId: { in: Array.from(relevantIds) } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.salaryEntry.groupBy({
        by: ['employeeId'],
        where: {
          ...salaryWhere,
          employeeId: { in: Array.from(relevantIds) },
          editedManually: true,
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.shiftSession.findMany({
        where: { ...shiftWhere, employeeId: { in: Array.from(relevantIds) } },
        select: { employeeId: true, startedAt: true },
      }),
      // «Основное подразделение» сотрудника за период — то, у которого
      // больше всего сдельных строк. Считаем дешёвым raw-запросом:
      // groupBy сразу по двум полям + count.
      this.prisma.$queryRaw<
        Array<{
          employeeId: string;
          companyDivisionId: string | null;
          companyDivisionCode: string | null;
          companyDivisionName: string | null;
          rows: bigint;
        }>
      >`
        SELECT oe."employeeId" AS "employeeId",
               cd."id"   AS "companyDivisionId",
               cd."code" AS "companyDivisionCode",
               cd."name" AS "companyDivisionName",
               COUNT(*)::bigint AS "rows"
          FROM "OperationEntry" oe
          JOIN "Passport" p ON p."id" = oe."passportId"
          JOIN "Order"    o ON o."id" = p."orderId"
          LEFT JOIN "CompanyDivision" cd ON cd."id" = o."companyDivisionId"
         WHERE oe."createdAt" >= ${from}
           AND oe."createdAt" <= ${to}
           AND oe."employeeId" IN (${Prisma.join(Array.from(relevantIds))})
         GROUP BY oe."employeeId", cd."id", cd."code", cd."name"
      `,
      // Покрытие выплатами: PayrollPayoutLine → OperationEntry / SalaryEntry
      // за этот же период, только активные выплаты (DRAFT/ISSUED/ACKNOWLEDGED).
      this.prisma.$queryRaw<
        Array<{
          employeeId: string;
          kind: string;
          coveredRub: string;
        }>
      >`
        SELECT
          COALESCE(oe."employeeId", se."employeeId") AS "employeeId",
          ppl."kind"                                  AS "kind",
          SUM(ppl."amountRub")::text                  AS "coveredRub"
        FROM "PayrollPayoutLine" ppl
        JOIN "PayrollPayout" pp ON pp."id" = ppl."payoutId"
        LEFT JOIN "OperationEntry" oe ON oe."id" = ppl."operationEntryId"
        LEFT JOIN "SalaryEntry"    se ON se."id" = ppl."salaryEntryId"
        WHERE pp."status" IN ('DRAFT', 'ISSUED', 'ACKNOWLEDGED')
          AND (
            (
              ppl."operationEntryId" IS NOT NULL
              AND oe."createdAt" >= ${from}
              AND oe."createdAt" <= ${to}
              AND oe."employeeId" IN (${Prisma.join(Array.from(relevantIds))})
            )
            OR
            (
              ppl."salaryEntryId" IS NOT NULL
              AND se."date" >= ${dayFrom}
              AND se."date" <= ${dayTo}
              AND se."employeeId" IN (${Prisma.join(Array.from(relevantIds))})
            )
          )
        GROUP BY COALESCE(oe."employeeId", se."employeeId"), ppl."kind"
      `,
      // Корректировки (ADJUSTMENT/BONUS/DEDUCTION/ADVANCE) — manual lines без FK.
      // Связываем через PayrollPayout.employeeId, период — через payout.periodFrom/periodTo.
      this.prisma.$queryRaw<
        Array<{ employeeId: string; adjustRub: string }>
      >`
        SELECT
          pp."employeeId"            AS "employeeId",
          SUM(ppl."amountRub")::text AS "adjustRub"
        FROM "PayrollPayoutLine" ppl
        JOIN "PayrollPayout" pp ON pp."id" = ppl."payoutId"
        WHERE pp."status" IN ('DRAFT', 'ISSUED', 'ACKNOWLEDGED')
          AND ppl."kind" IN ('ADJUSTMENT', 'BONUS', 'DEDUCTION', 'ADVANCE')
          AND ppl."operationEntryId" IS NULL
          AND ppl."salaryEntryId"    IS NULL
          AND pp."periodFrom" <= ${dayTo}
          AND pp."periodTo"   >= ${dayFrom}
          AND pp."employeeId" IN (${Prisma.join(Array.from(relevantIds))})
        GROUP BY pp."employeeId"
      `,
    ]);

    const piApproved = byId(pieceworkApprovedAgg);
    const piPending = byId(pieceworkPendingAgg);
    const piCount = byId(pieceworkCountAgg);
    const sal = byId(salaryAgg);
    const salEdited = byId(salaryEditedAgg);
    const daysByEmp = countUniqueDates(shiftRows);

    // Сводим покрытие выплатами по сотруднику + виду (PIECEWORK / SALARY).
    const payoutPieceworkCovered = new Map<string, number>();
    const payoutSalaryCovered = new Map<string, number>();
    for (const r of payoutCoverageRows) {
      const amount = round2(Number(r.coveredRub));
      if (r.kind === 'PIECEWORK') {
        payoutPieceworkCovered.set(
          r.employeeId,
          (payoutPieceworkCovered.get(r.employeeId) ?? 0) + amount,
        );
      } else {
        payoutSalaryCovered.set(
          r.employeeId,
          (payoutSalaryCovered.get(r.employeeId) ?? 0) + amount,
        );
      }
    }

    // Суммы manual kind lines (ADJUSTMENT / BONUS / DEDUCTION / ADVANCE) по сотруднику.
    const payoutAdjustMap = new Map<string, number>();
    for (const r of payoutAdjustRows) {
      payoutAdjustMap.set(r.employeeId, round2(Number(r.adjustRub)));
    }

    const divisionByEmp = new Map<
      string,
      { id: string | null; code: string | null; name: string | null }
    >();
    for (const r of pieceworkDivisionRows) {
      const prev = divisionByEmp.get(r.employeeId);
      const rows = Number(r.rows);
      if (!prev || rows > (prev as { _rows?: number })._rows!) {
        divisionByEmp.set(r.employeeId, {
          id: r.companyDivisionId,
          code: r.companyDivisionCode,
          name: r.companyDivisionName,
          // @ts-expect-error — служебное поле для сравнения, наружу
          // не уезжает
          _rows: rows,
        });
      }
    }

    // 4. Собираем строки.
    const items: PayrollPeriodEmployeeRowDto[] = [];
    for (const id of relevantIds) {
      const emp = empById.get(id);
      if (!emp) continue;
      const pa = roundMoneyNumber(piApproved.get(id)?._sum?.amount ?? 0);
      const pp = roundMoneyNumber(piPending.get(id)?._sum?.amount ?? 0);
      const ec = piCount.get(id)?._count?._all ?? 0;
      const sr = roundMoneyNumber(sal.get(id)?._sum?.amount ?? 0);
      const sre = roundMoneyNumber(salEdited.get(id)?._sum?.amount ?? 0);
      const div = divisionByEmp.get(id) ?? null;
      // PHASE 2 STEP 2: fallback на `Employee.companyDivision`, если
      // у сотрудника не было ни одного сдельного начисления
      // в подразделении (сюда же — если все сдельные строки висели
      // на заказах с `companyDivisionId = NULL`).
      const empDiv = emp.companyDivision ?? null;
      const finalDivId = div?.id ?? empDiv?.id ?? null;
      const finalDivName = div?.name ?? empDiv?.name ?? null;

      const grossAccruedRub = round2(pa + sr);
      const payoutPiecework = round2(payoutPieceworkCovered.get(id) ?? 0);
      const payoutSalary = round2(payoutSalaryCovered.get(id) ?? 0);
      const payoutCoveredRub = round2(payoutPiecework + payoutSalary);
      const netToPayRub = round2(Math.max(0, grossAccruedRub - payoutCoveredRub));
      const payoutAdjustRub = round2(payoutAdjustMap.get(id) ?? 0);

      items.push({
        employeeId: emp.id,
        fullName: emp.fullName,
        role: emp.role,
        compensationType: emp.compensationType,
        companyDivisionId: finalDivId,
        companyDivision: finalDivName,
        pieceworkApprovedRub: pa,
        pieceworkPendingRub: pp,
        salaryRub: sr,
        salaryEditedRub: sre,
        totalApprovedRub: round2(pa + sr),
        totalPendingRub: pp,
        totalRub: round2(pa + sr + pp),
        daysOnShift: daysByEmp.get(id) ?? 0,
        entriesCount: ec,
        grossAccruedRub,
        payoutCoveredRub,
        payoutPieceworkCoveredRub: payoutPiecework,
        payoutSalaryCoveredRub: payoutSalary,
        netToPayRub,
        payoutAdjustRub,
      });
    }
    items.sort((a, b) => {
      // Сначала те, у кого больше денег за период — менеджеру так
      // удобнее.
      if (b.totalRub !== a.totalRub) return b.totalRub - a.totalRub;
      return a.fullName.localeCompare(b.fullName, 'ru');
    });

    // 5. Summary считаем ДО пагинации — он по всему периоду.
    const summary = computePeriodSummary(items, {
      pieceworkPendingCount: sumCounts(piPending),
      salaryCount: sumCounts(sal),
      salaryEditedCount: sumCounts(salEdited),
    });

    const total = items.length;
    const offset = Math.max(0, (query.page - 1) * query.pageSize);
    const paged = items.slice(offset, offset + query.pageSize);

    return {
      items: paged,
      summary,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ===========================================================================
  // READ: daily snapshot
  // ===========================================================================

  /**
   * Снимок «кто сегодня работал» (`/api/payroll/daily`).
   *
   * Логика выбора сотрудников такая же, как в `period`, только
   * период — это ровно один календарный день. В строке отдаются:
   *
   *   - флаг `hadShift` (была ли хотя бы одна `ShiftSession`);
   *   - `shiftStartedAt` — `MIN(startedAt)`;
   *   - `shiftStoppedAt` — `MAX(endedAt)` (если все смены закрыты);
   *   - сдельщина approved / pending за день (по `createdAt`);
   *   - оклад за этот день (по `SalaryEntry.date`).
   */
  async daily(query: PayrollDailyQuery): Promise<PayrollDailyPageDto> {
    const { from, to, day } = parseDayWindow(query.date);

    const earningsWhere: Prisma.OperationEntryWhereInput = {
      createdAt: { gte: from, lte: to },
    };
    const salaryWhere: Prisma.SalaryEntryWhereInput = { date: day };
    const shiftWhere: Prisma.ShiftSessionWhereInput = {
      startedAt: { gte: from, lte: to },
    };
    if (query.role) {
      const role = query.role as Role;
      earningsWhere.employee = { role };
      salaryWhere.employee = { role };
      shiftWhere.employee = { role };
    }
    if (query.divisionCode) {
      // PHASE 2 STEP 2: то же двухосевое поведение, что и в `period`.
      earningsWhere.passport = {
        order: { companyDivision: { code: query.divisionCode } },
      };
      salaryWhere.employee = {
        ...(salaryWhere.employee as Prisma.EmployeeWhereInput | undefined),
        companyDivision: { code: query.divisionCode },
      };
      shiftWhere.employee = {
        ...(shiftWhere.employee as Prisma.EmployeeWhereInput | undefined),
        companyDivision: { code: query.divisionCode },
      };
    }

    const [earningsEmps, salaryEmps, shiftRows] = await Promise.all([
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: earningsWhere,
      }),
      this.prisma.salaryEntry.groupBy({
        by: ['employeeId'],
        where: salaryWhere,
      }),
      this.prisma.shiftSession.findMany({
        where: shiftWhere,
        select: { employeeId: true, startedAt: true, endedAt: true },
      }),
    ]);

    const relevantIds = new Set<string>();
    for (const r of earningsEmps) relevantIds.add(r.employeeId);
    for (const r of salaryEmps) relevantIds.add(r.employeeId);
    for (const r of shiftRows) relevantIds.add(r.employeeId);

    if (relevantIds.size === 0) {
      return {
        date: query.date,
        employees: [],
        summary: {
          employeesCount: 0,
          shiftsCount: 0,
          totalRub: 0,
          pieceworkApprovedRub: 0,
          pieceworkPendingRub: 0,
          salaryRub: 0,
        },
      };
    }

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: Array.from(relevantIds) } },
      select: {
        id: true,
        fullName: true,
        role: true,
        compensationType: true,
      },
    });
    const empById = new Map(employees.map((e) => [e.id, e]));

    const [piApproved, piPending, sal] = await Promise.all([
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: { ...earningsWhere, status: EntryStatus.APPROVED },
        _sum: { amount: true },
      }),
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: {
          ...earningsWhere,
          status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
        },
        _sum: { amount: true },
      }),
      this.prisma.salaryEntry.groupBy({
        by: ['employeeId'],
        where: { ...salaryWhere, employeeId: { in: Array.from(relevantIds) } },
        _sum: { amount: true },
      }),
    ]);
    const pa = byId(piApproved);
    const pp = byId(piPending);
    const sr = byId(sal);

    // Сматчим shifts → employee для shiftStartedAt/Stopped.
    const shiftSummary = new Map<
      string,
      {
        startedAt: Date | null;
        stoppedAt: Date | null;
        allClosed: boolean;
        count: number;
      }
    >();
    for (const s of shiftRows) {
      const prev = shiftSummary.get(s.employeeId) ?? {
        startedAt: null,
        stoppedAt: null,
        allClosed: true,
        count: 0,
      };
      prev.count += 1;
      if (!prev.startedAt || s.startedAt < prev.startedAt) {
        prev.startedAt = s.startedAt;
      }
      if (s.endedAt) {
        if (!prev.stoppedAt || s.endedAt > prev.stoppedAt) {
          prev.stoppedAt = s.endedAt;
        }
      } else {
        prev.allClosed = false;
      }
      shiftSummary.set(s.employeeId, prev);
    }

    const rows: PayrollDailyEmployeeRowDto[] = [];
    let shiftsCount = 0;
    for (const id of relevantIds) {
      const emp = empById.get(id);
      if (!emp) continue;
      const sh = shiftSummary.get(id) ?? null;
      if (sh) shiftsCount += sh.count;
      const piA = roundMoneyNumber(pa.get(id)?._sum?.amount ?? 0);
      const piP = roundMoneyNumber(pp.get(id)?._sum?.amount ?? 0);
      const slr = roundMoneyNumber(sr.get(id)?._sum?.amount ?? 0);
      rows.push({
        employeeId: emp.id,
        fullName: emp.fullName,
        role: emp.role,
        compensationType: emp.compensationType,
        hadShift: !!sh,
        shiftStartedAt: sh?.startedAt ? sh.startedAt.toISOString() : null,
        shiftStoppedAt:
          sh && sh.allClosed && sh.stoppedAt ? sh.stoppedAt.toISOString() : null,
        pieceworkApprovedRub: piA,
        pieceworkPendingRub: piP,
        salaryRub: slr,
        totalRub: round2(piA + piP + slr),
      });
    }
    rows.sort((a, b) => {
      if (b.totalRub !== a.totalRub) return b.totalRub - a.totalRub;
      return a.fullName.localeCompare(b.fullName, 'ru');
    });

    const summary: PayrollDailySummaryDto = {
      employeesCount: rows.length,
      shiftsCount,
      pieceworkApprovedRub: round2(
        rows.reduce((s, r) => s + r.pieceworkApprovedRub, 0),
      ),
      pieceworkPendingRub: round2(
        rows.reduce((s, r) => s + r.pieceworkPendingRub, 0),
      ),
      salaryRub: round2(rows.reduce((s, r) => s + r.salaryRub, 0)),
      totalRub: round2(rows.reduce((s, r) => s + r.totalRub, 0)),
    };

    return { date: query.date, employees: rows, summary };
  }

  // ===========================================================================
  // READ: employee detail
  // ===========================================================================

  /**
   * Карточка сотрудника `/api/payroll/employees/:id` за период.
   *
   * Возвращает:
   *   - реквизиты сотрудника (read-only, как в `EmployeesService.get`);
   *   - summary — те же поля, что в `period[i]`, но для одного человека;
   *   - `shifts[]` — все `ShiftSession` за период;
   *   - `operationEntries[]` — все сдельные начисления за период;
   *   - `salaryEntries[]` — все окладные начисления за период.
   *
   * Pagination в PHASE 1 не делаем: на одного сотрудника за разумный
   * период (месяц-два) объём данных небольшой.
   */
  async employeeDetail(
    employeeId: string,
    query: PayrollEmployeeQuery,
  ): Promise<PayrollEmployeeDetailDto> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        login: true,
        role: true,
        compensationType: true,
        salaryPerShift: true,
        active: true,
        companyDivision: { select: { id: true, code: true, name: true } },
      },
    });
    if (!employee) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Сотрудник не найден',
      });
    }

    const { from, to, dayFrom, dayTo } = parsePeriodWindow(
      query.dateFrom,
      query.dateTo,
    );

    const [shifts, operationEntries, salaryEntries] = await Promise.all([
      this.prisma.shiftSession.findMany({
        where: { employeeId, startedAt: { gte: from, lte: to } },
        orderBy: { startedAt: 'asc' },
        include: {
          equipment: { select: { id: true, code: true, name: true } },
          operation: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.operationEntry.findMany({
        where: { employeeId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'asc' },
        include: {
          passport: {
            select: {
              id: true,
              number: true,
              order: { select: { id: true, number: true } },
            },
          },
          operation: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.salaryEntry.findMany({
        where: { employeeId, date: { gte: dayFrom, lte: dayTo } },
        orderBy: { date: 'asc' },
        include: {
          editedBy: { select: { id: true, fullName: true } },
        },
      }),
    ]);

    const shiftsDto: PayrollEmployeeShiftDto[] = shifts.map((s) => ({
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      equipmentId: s.equipment.id,
      equipmentCode: s.equipment.code,
      equipmentName: s.equipment.name,
      operationId: s.operation.id,
      operationCode: s.operation.code,
      operationName: s.operation.name,
    }));

    const opsDto: PayrollEmployeeOperationEntryDto[] = operationEntries.map(
      (e) => ({
        id: e.id,
        passportId: e.passport.id,
        passportNumber: e.passport.number,
        orderId: e.passport.order.id,
        orderNumber: e.passport.order.number,
        operationId: e.operation.id,
        operationCode: e.operation.code,
        operationName: e.operation.name,
        qty: e.qty,
        ratePerUnit: roundMoneyNumber(e.ratePerUnit),
        amount: roundMoneyNumber(e.amount),
        // Маппим legacy PENDING в публичный PENDING_RELEASE так же,
        // как делает `EarningsService.toDto`, чтобы UI не разбирался
        // в двух именах одного состояния.
        status:
          e.status === EntryStatus.PENDING
            ? 'PENDING_RELEASE'
            : (e.status as PayrollEmployeeOperationEntryDto['status']),
        approvalMode:
          e.approvalMode as PayrollEmployeeOperationEntryDto['approvalMode'],
        sourceEventType:
          e.sourceEventType as PayrollEmployeeOperationEntryDto['sourceEventType'],
        createdAt: e.createdAt.toISOString(),
        approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
      }),
    );

    const salDto: PayrollEmployeeSalaryEntryDto[] = salaryEntries.map((s) => ({
      id: s.id,
      date: toDateOnly(s.date),
      amount: roundMoneyNumber(s.amount),
      source: s.source,
      editedManually: s.editedManually,
      managerComment: s.managerComment ?? null,
      editedByEmployeeId: s.editedByEmployeeId,
      editedByFullName: s.editedBy?.fullName ?? null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));

    const pieceworkApprovedRub = round2(
      opsDto
        .filter((e) => e.status === 'APPROVED')
        .reduce((s, e) => s + e.amount, 0),
    );
    const pieceworkPendingRub = round2(
      opsDto
        .filter((e) => e.status === 'PENDING_RELEASE')
        .reduce((s, e) => s + e.amount, 0),
    );
    const salaryRub = round2(salDto.reduce((s, e) => s + e.amount, 0));
    const salaryEditedRub = round2(
      salDto.filter((e) => e.editedManually).reduce((s, e) => s + e.amount, 0),
    );
    const daysOnShift = countUniqueDatesArr(shifts.map((s) => s.startedAt));

    return {
      employee: {
        employeeId: employee.id,
        fullName: employee.fullName,
        login: employee.login,
        role: employee.role,
        compensationType: employee.compensationType,
        salaryPerShift: employee.salaryPerShift
          ? Number(employee.salaryPerShift)
          : null,
        active: employee.active,
        companyDivisionId: employee.companyDivision?.id ?? null,
        companyDivision: employee.companyDivision ?? null,
      },
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      summary: {
        pieceworkApprovedRub,
        pieceworkPendingRub,
        salaryRub,
        salaryEditedRub,
        totalApprovedRub: round2(pieceworkApprovedRub + salaryRub),
        totalPendingRub: pieceworkPendingRub,
        totalRub: round2(
          pieceworkApprovedRub + salaryRub + pieceworkPendingRub,
        ),
        daysOnShift,
        entriesCount: opsDto.length,
      },
      shifts: shiftsDto,
      operationEntries: opsDto,
      salaryEntries: salDto,
    };
  }

  // ===========================================================================
  // READ: debts report (PHASE 3 STEP 7)
  // ===========================================================================

  /**
   * Управленческий отчёт задолженности по сотрудникам (`/api/payroll/debts`).
   *
   * Показывает: кому сколько должны на выбранную дату (по умолчанию — сегодня).
   *
   * Алгоритм:
   *   1. Находим сотрудников с `OperationEntry(APPROVED).createdAt <= asOfDate`
   *      или `SalaryEntry.date <= asOfDate` (с учётом фильтров).
   *   2. Для каждого агрегируем начисления и покрытие выплатами.
   *   3. `debtRub = max(0, accruedGrossRub − payoutCoveredRub)` — базовый долг.
   *   4. `cashBalanceRub = accruedGrossRub − paidTotalRub` — с корректировками.
   *   5. Pending entries попадают только в `pendingPieceworkRub` (не в debtRub).
   *   6. `CANCELLED` выплаты не учитываются.
   */
  async debts(query: PayrollDebtsQuery): Promise<PayrollDebtsPageDto> {
    const today = new Date();
    const asOfDateStr =
      query.asOfDate ?? toDateOnly(today);
    const asOf = new Date(`${asOfDateStr}T23:59:59.999Z`);
    const asOfDay = new Date(`${asOfDateStr}T00:00:00.000Z`);

    // Base where clauses (scoped later with employeeId filter)
    const earningsApprovedWhere: Prisma.OperationEntryWhereInput = {
      status: EntryStatus.APPROVED,
      createdAt: { lte: asOf },
    };
    const salaryWhere: Prisma.SalaryEntryWhereInput = {
      date: { lte: asOfDay },
    };
    const pendingWhere: Prisma.OperationEntryWhereInput = {
      status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
      createdAt: { lte: asOf },
    };

    if (query.employeeId) {
      earningsApprovedWhere.employeeId = query.employeeId;
      salaryWhere.employeeId = query.employeeId;
      pendingWhere.employeeId = query.employeeId;
    }
    if (query.role) {
      const role = query.role as Role;
      earningsApprovedWhere.employee = { role };
      salaryWhere.employee = { role };
      pendingWhere.employee = { role };
    }
    if (query.divisionCode) {
      earningsApprovedWhere.passport = {
        order: { companyDivision: { code: query.divisionCode } },
      };
      pendingWhere.passport = {
        order: { companyDivision: { code: query.divisionCode } },
      };
      salaryWhere.employee = {
        ...(salaryWhere.employee as Prisma.EmployeeWhereInput | undefined),
        companyDivision: { code: query.divisionCode },
      };
    }

    // 1. Relevant employee IDs.
    const [approvedEmps, salaryEmps] = await Promise.all([
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: earningsApprovedWhere,
      }),
      this.prisma.salaryEntry.groupBy({
        by: ['employeeId'],
        where: salaryWhere,
      }),
    ]);

    const relevantIds = new Set<string>();
    for (const r of approvedEmps) relevantIds.add(r.employeeId);
    for (const r of salaryEmps) relevantIds.add(r.employeeId);

    if (relevantIds.size === 0) {
      return {
        items: [],
        summary: emptyDebtsSummary(),
        asOfDate: asOfDateStr,
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    }

    const ids = Array.from(relevantIds);

    // 2. Employee profiles.
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        fullName: true,
        role: true,
        companyDivision: { select: { id: true, code: true, name: true } },
      },
    });
    const empById = new Map(employees.map((e) => [e.id, e]));

    // 3. Parallel aggregates.
    const [
      pieceworkApproved,
      pieceworkPending,
      salaryAgg,
      payoutCoverageRows,
      payoutAdjustRows,
      lastPayoutRows,
      divisionRows,
    ] = await Promise.all([
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: { ...earningsApprovedWhere, employeeId: { in: ids } },
        _sum: { amount: true },
      }),
      this.prisma.operationEntry.groupBy({
        by: ['employeeId'],
        where: { ...pendingWhere, employeeId: { in: ids } },
        _sum: { amount: true },
      }),
      this.prisma.salaryEntry.groupBy({
        by: ['employeeId'],
        where: { ...salaryWhere, employeeId: { in: ids } },
        _sum: { amount: true },
      }),
      // Покрытие выплатами: PIECEWORK/SALARY lines, ссылающихся на начисления
      // до asOfDate по активным выплатам (DRAFT/ISSUED/ACKNOWLEDGED).
      this.prisma.$queryRaw<
        Array<{ employeeId: string; kind: string; coveredRub: string }>
      >`
        SELECT
          COALESCE(oe."employeeId", se."employeeId") AS "employeeId",
          ppl."kind"                                  AS "kind",
          SUM(ppl."amountRub")::text                  AS "coveredRub"
        FROM "PayrollPayoutLine" ppl
        JOIN "PayrollPayout" pp ON pp."id" = ppl."payoutId"
        LEFT JOIN "OperationEntry" oe ON oe."id" = ppl."operationEntryId"
        LEFT JOIN "SalaryEntry"    se ON se."id" = ppl."salaryEntryId"
        WHERE pp."status" IN ('DRAFT', 'ISSUED', 'ACKNOWLEDGED')
          AND ppl."kind" IN ('PIECEWORK', 'SALARY')
          AND (
            (
              ppl."operationEntryId" IS NOT NULL
              AND oe."createdAt" <= ${asOf}
              AND oe."employeeId" IN (${Prisma.join(ids)})
            )
            OR
            (
              ppl."salaryEntryId" IS NOT NULL
              AND se."date" <= ${asOfDay}
              AND se."employeeId" IN (${Prisma.join(ids)})
            )
          )
        GROUP BY COALESCE(oe."employeeId", se."employeeId"), ppl."kind"
      `,
      // Manual-kind корректировки (BONUS/DEDUCTION/ADVANCE/ADJUSTMENT) без FK.
      // Дата: payout.periodTo <= asOfDate.
      this.prisma.$queryRaw<
        Array<{ employeeId: string; adjustRub: string }>
      >`
        SELECT
          pp."employeeId"            AS "employeeId",
          SUM(ppl."amountRub")::text AS "adjustRub"
        FROM "PayrollPayoutLine" ppl
        JOIN "PayrollPayout" pp ON pp."id" = ppl."payoutId"
        WHERE pp."status" IN ('DRAFT', 'ISSUED', 'ACKNOWLEDGED')
          AND ppl."kind" IN ('ADJUSTMENT', 'BONUS', 'DEDUCTION', 'ADVANCE')
          AND ppl."operationEntryId" IS NULL
          AND ppl."salaryEntryId"    IS NULL
          AND pp."periodTo" <= ${asOfDay}
          AND pp."employeeId" IN (${Prisma.join(ids)})
        GROUP BY pp."employeeId"
      `,
      // Даты последних выплат per employee (для колонок "последняя выплата").
      this.prisma.$queryRaw<
        Array<{
          employeeId: string;
          lastPayoutAt: Date | null;
          lastAcknowledgedAt: Date | null;
        }>
      >`
        SELECT
          pp."employeeId"          AS "employeeId",
          MAX(pp."issuedAt")       AS "lastPayoutAt",
          MAX(pp."acknowledgedAt") AS "lastAcknowledgedAt"
        FROM "PayrollPayout" pp
        WHERE pp."status" IN ('DRAFT', 'ISSUED', 'ACKNOWLEDGED')
          AND pp."employeeId" IN (${Prisma.join(ids)})
        GROUP BY pp."employeeId"
      `,
      // Подразделение по большинству строк сдельщины (для отображения).
      this.prisma.$queryRaw<
        Array<{
          employeeId: string;
          companyDivisionId: string | null;
          companyDivisionName: string | null;
          rows: bigint;
        }>
      >`
        SELECT oe."employeeId"    AS "employeeId",
               cd."id"           AS "companyDivisionId",
               cd."name"         AS "companyDivisionName",
               COUNT(*)::bigint  AS "rows"
          FROM "OperationEntry" oe
          JOIN "Passport" p ON p."id" = oe."passportId"
          JOIN "Order"    o ON o."id" = p."orderId"
          LEFT JOIN "CompanyDivision" cd ON cd."id" = o."companyDivisionId"
         WHERE oe."createdAt" <= ${asOf}
           AND oe."status" = 'APPROVED'
           AND oe."employeeId" IN (${Prisma.join(ids)})
         GROUP BY oe."employeeId", cd."id", cd."name"
      `,
    ]);

    // 4. Build lookup maps.
    const piApproved = byId(pieceworkApproved);
    const piPending = byId(pieceworkPending);
    const sal = byId(salaryAgg);

    const payoutPieceworkCovered = new Map<string, number>();
    const payoutSalaryCovered = new Map<string, number>();
    for (const r of payoutCoverageRows) {
      const amount = round2(Number(r.coveredRub));
      if (r.kind === 'PIECEWORK') {
        payoutPieceworkCovered.set(
          r.employeeId,
          (payoutPieceworkCovered.get(r.employeeId) ?? 0) + amount,
        );
      } else {
        payoutSalaryCovered.set(
          r.employeeId,
          (payoutSalaryCovered.get(r.employeeId) ?? 0) + amount,
        );
      }
    }

    const payoutAdjustMap = new Map<string, number>();
    for (const r of payoutAdjustRows) {
      payoutAdjustMap.set(r.employeeId, round2(Number(r.adjustRub)));
    }

    const lastPayoutMap = new Map<
      string,
      { lastPayoutAt: Date | null; lastAcknowledgedAt: Date | null }
    >();
    for (const r of lastPayoutRows) {
      lastPayoutMap.set(r.employeeId, {
        lastPayoutAt: r.lastPayoutAt,
        lastAcknowledgedAt: r.lastAcknowledgedAt,
      });
    }

    const divisionByEmp = new Map<
      string,
      { id: string | null; name: string | null }
    >();
    for (const r of divisionRows) {
      const prev = divisionByEmp.get(r.employeeId);
      const rows = Number(r.rows);
      if (!prev || rows > (prev as { _rows?: number })._rows!) {
        divisionByEmp.set(r.employeeId, {
          id: r.companyDivisionId,
          name: r.companyDivisionName,
          // @ts-expect-error — служебное поле, наружу не уезжает
          _rows: rows,
        });
      }
    }

    // 5. Assemble rows.
    const items: PayrollDebtEmployeeRowDto[] = [];
    for (const id of relevantIds) {
      const emp = empById.get(id);
      if (!emp) continue;

      const accruedPieceworkRub = roundMoneyNumber(
        piApproved.get(id)?._sum?.amount ?? 0,
      );
      const accruedSalaryRub = roundMoneyNumber(sal.get(id)?._sum?.amount ?? 0);
      const accruedGrossRub = round2(accruedPieceworkRub + accruedSalaryRub);
      const pendingPieceworkRub = roundMoneyNumber(
        piPending.get(id)?._sum?.amount ?? 0,
      );

      const payoutCoveredPiecework = round2(
        payoutPieceworkCovered.get(id) ?? 0,
      );
      const payoutCoveredSalary = round2(payoutSalaryCovered.get(id) ?? 0);
      const payoutCoveredRub = round2(
        payoutCoveredPiecework + payoutCoveredSalary,
      );
      const payoutAdjustRub = round2(payoutAdjustMap.get(id) ?? 0);
      const paidTotalRub = round2(payoutCoveredRub + payoutAdjustRub);
      const debtRub = round2(Math.max(0, accruedGrossRub - payoutCoveredRub));
      const cashBalanceRub = round2(accruedGrossRub - paidTotalRub);

      const lastPayout = lastPayoutMap.get(id);
      const div = divisionByEmp.get(id);
      const empDiv = emp.companyDivision ?? null;
      const divId = div?.id ?? empDiv?.id ?? null;
      const divName = div?.name ?? empDiv?.name ?? null;

      items.push({
        employeeId: emp.id,
        fullName: emp.fullName,
        role: emp.role,
        companyDivisionId: divId,
        companyDivisionName: divName,
        accruedPieceworkRub,
        accruedSalaryRub,
        accruedGrossRub,
        payoutCoveredPieceworkRub: payoutCoveredPiecework,
        payoutCoveredSalaryRub: payoutCoveredSalary,
        payoutCoveredRub,
        payoutAdjustRub,
        paidTotalRub,
        debtRub,
        cashBalanceRub,
        pendingPieceworkRub,
        lastPayoutAt: lastPayout?.lastPayoutAt?.toISOString() ?? null,
        lastAcknowledgedAt:
          lastPayout?.lastAcknowledgedAt?.toISOString() ?? null,
      });
    }

    // Sort: сначала с долгом, по убыванию долга, потом по имени.
    items.sort((a, b) => {
      if (b.debtRub !== a.debtRub) return b.debtRub - a.debtRub;
      return a.fullName.localeCompare(b.fullName, 'ru');
    });

    const summary = computeDebtsSummary(items);
    const total = items.length;
    const offset = Math.max(0, (query.page - 1) * query.pageSize);
    const paged = items.slice(offset, offset + query.pageSize);

    return {
      items: paged,
      summary,
      asOfDate: asOfDateStr,
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Разворачивает `dateFrom`/`dateTo` (`YYYY-MM-DD`) в окно
 * `[startOfDay(from), endOfDay(to)]` в UTC. Используется для фильтра
 * `OperationEntry.createdAt` (datetime). Параллельно отдаёт «дневные»
 * границы для `SalaryEntry.date` (DATE) — Prisma при сравнении
 * `DateTime → DATE` конвертирует, и `dayFrom`/`dayTo` совпадают с
 * полуночью UTC, что и хранится в БД.
 */
function parsePeriodWindow(
  dateFrom: string,
  dateTo: string,
): { from: Date; to: Date; dayFrom: Date; dayTo: Date } {
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T23:59:59.999Z`);
  const dayFrom = new Date(`${dateFrom}T00:00:00.000Z`);
  const dayTo = new Date(`${dateTo}T00:00:00.000Z`);
  return { from, to, dayFrom, dayTo };
}

function parseDayWindow(date: string): { from: Date; to: Date; day: Date } {
  return {
    from: new Date(`${date}T00:00:00.000Z`),
    to: new Date(`${date}T23:59:59.999Z`),
    day: new Date(`${date}T00:00:00.000Z`),
  };
}

function byId<
  T extends { employeeId: string },
>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) out.set(r.employeeId, r);
  return out;
}

function countUniqueDates(
  rows: Array<{ employeeId: string; startedAt: Date }>,
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.startedAt.toISOString().slice(0, 10);
    let bucket = seen.get(r.employeeId);
    if (!bucket) {
      bucket = new Set<string>();
      seen.set(r.employeeId, bucket);
    }
    bucket.add(key);
  }
  const out = new Map<string, number>();
  for (const [id, dates] of seen) out.set(id, dates.size);
  return out;
}

function countUniqueDatesArr(dates: Date[]): number {
  const set = new Set<string>();
  for (const d of dates) set.add(d.toISOString().slice(0, 10));
  return set.size;
}

function sumCounts(rows: Map<string, { _count?: { _all: number } }>): number {
  let total = 0;
  for (const r of rows.values()) total += r._count?._all ?? 0;
  return total;
}

function emptyPeriodSummary(): PayrollPeriodSummaryDto {
  return {
    totalApprovedRub: 0,
    totalPendingRub: 0,
    totalRub: 0,
    pieceworkRub: 0,
    salaryRub: 0,
    salaryEditedRub: 0,
    employeesCount: 0,
    pieceworkEntriesCount: 0,
    pieceworkPendingCount: 0,
    salaryEntriesCount: 0,
    salaryEditedCount: 0,
    totalPayoutCoveredRub: 0,
    totalNetToPayRub: 0,
  };
}

function computePeriodSummary(
  rows: PayrollPeriodEmployeeRowDto[],
  counts: {
    pieceworkPendingCount: number;
    salaryCount: number;
    salaryEditedCount: number;
  },
): PayrollPeriodSummaryDto {
  let approved = 0;
  let pending = 0;
  let total = 0;
  let piecework = 0;
  let salary = 0;
  let salaryEdited = 0;
  let entries = 0;
  let payoutCovered = 0;
  let netToPay = 0;
  for (const r of rows) {
    approved += r.totalApprovedRub;
    pending += r.totalPendingRub;
    total += r.totalRub;
    piecework += r.pieceworkApprovedRub + r.pieceworkPendingRub;
    salary += r.salaryRub;
    salaryEdited += r.salaryEditedRub;
    entries += r.entriesCount;
    payoutCovered += r.payoutCoveredRub;
    netToPay += r.netToPayRub;
  }
  return {
    totalApprovedRub: round2(approved),
    totalPendingRub: round2(pending),
    totalRub: round2(total),
    pieceworkRub: round2(piecework),
    salaryRub: round2(salary),
    salaryEditedRub: round2(salaryEdited),
    employeesCount: rows.length,
    pieceworkEntriesCount: entries,
    pieceworkPendingCount: counts.pieceworkPendingCount,
    salaryEntriesCount: counts.salaryCount,
    salaryEditedCount: counts.salaryEditedCount,
    totalPayoutCoveredRub: round2(payoutCovered),
    totalNetToPayRub: round2(netToPay),
  };
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function roundMoneyNumber(
  value: Prisma.Decimal | number | string | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return round2(value);
  if (typeof value === 'string') return round2(Number(value));
  return Number(value.toFixed(2));
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function emptyDebtsSummary(): PayrollDebtsSummaryDto {
  return {
    totalAccruedGrossRub: 0,
    totalPayoutCoveredRub: 0,
    totalPayoutAdjustRub: 0,
    totalPaidRub: 0,
    totalDebtRub: 0,
    totalCashBalanceRub: 0,
    totalPendingPieceworkRub: 0,
    employeesWithDebt: 0,
  };
}

function computeDebtsSummary(
  rows: PayrollDebtEmployeeRowDto[],
): PayrollDebtsSummaryDto {
  let accrued = 0;
  let covered = 0;
  let adjust = 0;
  let paid = 0;
  let debt = 0;
  let cash = 0;
  let pending = 0;
  let withDebt = 0;
  for (const r of rows) {
    accrued += r.accruedGrossRub;
    covered += r.payoutCoveredRub;
    adjust += r.payoutAdjustRub;
    paid += r.paidTotalRub;
    debt += r.debtRub;
    cash += r.cashBalanceRub;
    pending += r.pendingPieceworkRub;
    if (r.debtRub > 0) withDebt++;
  }
  return {
    totalAccruedGrossRub: round2(accrued),
    totalPayoutCoveredRub: round2(covered),
    totalPayoutAdjustRub: round2(adjust),
    totalPaidRub: round2(paid),
    totalDebtRub: round2(debt),
    totalCashBalanceRub: round2(cash),
    totalPendingPieceworkRub: round2(pending),
    employeesWithDebt: withDebt,
  };
}
