import { Injectable } from '@nestjs/common';
import { PassportEventType, PassportStatus } from '@prisma/client';
import type {
  ForceCloseShiftDto,
  MasterActiveShiftDto,
  MasterActiveShiftsDto,
  MasterCloseShiftResultDto,
  MasterEmployeeDrillDto,
  MasterEmployeeOpStatDto,
  MasterEmployeeStatsDto,
  MasterEmployeeStatsDrillQuery,
  MasterEmployeeStatsQuery,
  MasterEmployeeStatRowDto,
} from '@sewing/shared';
import {
  MasterShiftHasActivePassportsException,
  ShiftNotActiveException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ShiftsService } from '../shifts/shifts.service.js';

/** Накопитель статистики по одной операции сотрудника. */
interface OpAcc {
  operationId: string;
  operationCode: string;
  operationName: string;
  qty: number;
  defects: number;
  passportIds: Set<string>;
}

/**
 * «Статистика по сотрудникам» для кабинета мастера (read-only).
 *
 * Считает «кто сколько сделал» по событиям `OPERATION_FINISHED` за
 * период `[from; to]` (UTC, включительно), а брак атрибутирует
 * исполнителю операции. Источник и семантика — см.
 * `packages/shared/src/master-employee-stats.ts`. Сервис только
 * агрегирует, ничего не мутирует.
 *
 * Объёмы: число `OPERATION_FINISHED` за пару недель на масштабе цеха —
 * сотни-тысячи строк, поэтому тянем плоский срез событий и сворачиваем
 * в памяти (нужен distinct-count паспортов, которого нет в `groupBy`) —
 * тот же подход, что у `ProductionBoardService`.
 *
 * Помимо статистики модуль ведёт режим «Активные»: список открытых смен
 * (`getActiveShifts`) и единственную мутацию — принудительное завершение
 * смены мастером (`closeActiveShift`, аудит `MASTER_SHIFT_FORCE_CLOSED`).
 */
@Injectable()
export class MasterEmployeeStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftsService,
    private readonly audit: AuditService,
  ) {}

  /** UTC-`YYYY-MM-DD` из Date. */
  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** [from, to] окно по UTC-дням, `to` — конец дня (включительно). */
  private window(from: string, to: string): { from: Date; to: Date } {
    return {
      from: new Date(`${from}T00:00:00.000Z`),
      to: new Date(`${to}T23:59:59.999Z`),
    };
  }

  /**
   * Тянет события `OPERATION_FINISHED` за окно с привязкой к сотруднику
   * и операции. Фильтруем по непустому `employeeId`/`operationId` —
   * акты без исполнителя (миграции/служебные) в выработку не идут.
   */
  private async loadFinishedEvents(window: { from: Date; to: Date }) {
    return this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.OPERATION_FINISHED,
        employeeId: { not: null },
        operationId: { not: null },
        createdAt: { gte: window.from, lte: window.to },
      },
      select: {
        passportId: true,
        employeeId: true,
        operationId: true,
        qty: true,
        createdAt: true,
        employee: { select: { id: true, fullName: true, role: true } },
        operation: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Брак за окно, атрибутированный исполнителю операции.
   *
   * 1. Грузим `DEFECT_RECORDED` за `[from; to]` (день фиксации брака).
   * 2. Для каждой задетой пары `(passportId, operationId)` находим
   *    последний `OPERATION_FINISHED` (без окна — операция могла быть
   *    закрыта раньше периода) → это владелец брака.
   * 3. Возвращаем строки `{ employeeId, operationId, qty, createdAt }`
   *    только для тех, у кого нашёлся финишёр (иначе брак «ничей» — на
   *    операцию без зафиксированного исполнителя не вешаем).
   */
  private async loadAttributedDefects(window: {
    from: Date;
    to: Date;
  }): Promise<
    Array<{
      employeeId: string;
      operationId: string;
      passportId: string;
      qty: number;
      createdAt: Date;
    }>
  > {
    const defects = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.DEFECT_RECORDED,
        operationId: { not: null },
        qty: { gt: 0 },
        createdAt: { gte: window.from, lte: window.to },
      },
      select: {
        passportId: true,
        operationId: true,
        qty: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (defects.length === 0) return [];

    const passportIds = Array.from(new Set(defects.map((d) => d.passportId)));
    const operationIds = Array.from(
      new Set(defects.map((d) => d.operationId).filter((x): x is string => !!x)),
    );

    // Финишёры задетых пар (без окна): последний OPERATION_FINISHED на
    // (passport, operation) определяет владельца. `orderBy createdAt asc`
    // + перезапись в Map оставляет именно последний.
    const finishes = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.OPERATION_FINISHED,
        employeeId: { not: null },
        passportId: { in: passportIds },
        operationId: { in: operationIds },
      },
      select: { passportId: true, operationId: true, employeeId: true },
      orderBy: { createdAt: 'asc' },
    });
    const finisherByPair = new Map<string, string>();
    for (const f of finishes) {
      if (!f.operationId || !f.employeeId) continue;
      finisherByPair.set(`${f.passportId}:${f.operationId}`, f.employeeId);
    }

    const out: Array<{
      employeeId: string;
      operationId: string;
      passportId: string;
      qty: number;
      createdAt: Date;
    }> = [];
    for (const d of defects) {
      if (!d.operationId) continue;
      const employeeId = finisherByPair.get(`${d.passportId}:${d.operationId}`);
      if (!employeeId) continue;
      out.push({
        employeeId,
        operationId: d.operationId,
        passportId: d.passportId,
        qty: d.qty ?? 0,
        createdAt: d.createdAt,
      });
    }
    return out;
  }

  // ===========================================================================
  // LIST: таблица сотрудников
  // ===========================================================================

  async getStats(
    query: MasterEmployeeStatsQuery,
  ): Promise<MasterEmployeeStatsDto> {
    const window = this.window(query.from, query.to);
    const [events, defects] = await Promise.all([
      this.loadFinishedEvents(window),
      this.loadAttributedDefects(window),
    ]);

    interface Acc {
      employeeId: string;
      employeeName: string;
      role: string;
      totalOperations: number;
      totalQty: number;
      totalDefects: number;
      passportIds: Set<string>;
      ops: Map<string, OpAcc>;
    }
    const byEmployee = new Map<string, Acc>();

    const ensureEmployee = (
      employeeId: string,
      employeeName: string,
      role: string,
    ): Acc => {
      let acc = byEmployee.get(employeeId);
      if (!acc) {
        acc = {
          employeeId,
          employeeName,
          role,
          totalOperations: 0,
          totalQty: 0,
          totalDefects: 0,
          passportIds: new Set(),
          ops: new Map(),
        };
        byEmployee.set(employeeId, acc);
      }
      return acc;
    };

    const ensureOp = (
      acc: Acc,
      op: { id: string; code: string; name: string },
    ): OpAcc => {
      let o = acc.ops.get(op.id);
      if (!o) {
        o = {
          operationId: op.id,
          operationCode: op.code,
          operationName: op.name,
          qty: 0,
          defects: 0,
          passportIds: new Set(),
        };
        acc.ops.set(op.id, o);
      }
      return o;
    };

    for (const e of events) {
      if (!e.employee || !e.operation) continue;
      const qty = e.qty ?? 0;
      const acc = ensureEmployee(e.employee.id, e.employee.fullName, e.employee.role);
      acc.totalOperations += 1;
      acc.totalQty += qty;
      acc.passportIds.add(e.passportId);
      const op = ensureOp(acc, e.operation);
      op.qty += qty;
      op.passportIds.add(e.passportId);
    }

    // Имена/операции для брака могут относиться к сотрудникам без
    // выработки в окне — добираем справочник одним запросом.
    const missingEmployeeIds = defects
      .map((d) => d.employeeId)
      .filter((id) => !byEmployee.has(id));
    const missingOpIds = defects.map((d) => d.operationId);
    const [empMeta, opMeta] = await Promise.all([
      this.loadEmployeeMeta(missingEmployeeIds),
      this.loadOperationMeta(missingOpIds),
    ]);

    for (const d of defects) {
      const meta = empMeta.get(d.employeeId);
      const acc = ensureEmployee(
        d.employeeId,
        meta?.fullName ?? '—',
        meta?.role ?? '',
      );
      acc.totalDefects += d.qty;
      const op = opMeta.get(d.operationId);
      if (op) {
        const o = ensureOp(acc, op);
        o.defects += d.qty;
      }
    }

    const rows: MasterEmployeeStatRowDto[] = Array.from(byEmployee.values()).map(
      (acc) => ({
        employeeId: acc.employeeId,
        employeeName: acc.employeeName,
        role: acc.role,
        totalPassports: acc.passportIds.size,
        totalQty: acc.totalQty,
        totalDefects: acc.totalDefects,
        totalOperations: acc.totalOperations,
        operations: this.sortOps(acc.ops),
      }),
    );

    // Сортировка таблицы: больше всего штук — сверху.
    rows.sort(
      (a, b) => b.totalQty - a.totalQty || b.totalPassports - a.totalPassports,
    );

    return { from: query.from, to: query.to, rows };
  }

  // ===========================================================================
  // DRILL: один сотрудник
  // ===========================================================================

  async getDrill(
    query: MasterEmployeeStatsDrillQuery,
  ): Promise<MasterEmployeeDrillDto> {
    const window = this.window(query.from, query.to);
    const [allEvents, allDefects] = await Promise.all([
      this.loadFinishedEvents(window),
      this.loadAttributedDefects(window),
    ]);
    const events = allEvents.filter((e) => e.employeeId === query.employeeId);
    const defects = allDefects.filter((d) => d.employeeId === query.employeeId);

    // Шапка сотрудника берём из первого события, иначе — из справочника
    // (сотрудник без выработки в периоде: показываем нули, а не 404).
    let employeeName = '';
    let role = '';
    const first = events[0];
    if (first?.employee) {
      employeeName = first.employee.fullName;
      role = first.employee.role;
    } else {
      const emp = await this.prisma.employee.findUnique({
        where: { id: query.employeeId },
        select: { fullName: true, role: true },
      });
      employeeName = emp?.fullName ?? '—';
      role = emp?.role ?? '';
    }

    const ops = new Map<string, OpAcc>();
    const byDay = new Map<
      string,
      {
        day: string;
        qty: number;
        defects: number;
        operations: number;
        passportIds: Set<string>;
      }
    >();
    const allPassports = new Set<string>();
    let totalQty = 0;
    let totalDefects = 0;
    let totalOperations = 0;

    const ensureOp = (op: { id: string; code: string; name: string }): OpAcc => {
      let o = ops.get(op.id);
      if (!o) {
        o = {
          operationId: op.id,
          operationCode: op.code,
          operationName: op.name,
          qty: 0,
          defects: 0,
          passportIds: new Set(),
        };
        ops.set(op.id, o);
      }
      return o;
    };

    const ensureDay = (dayKey: string) => {
      let day = byDay.get(dayKey);
      if (!day) {
        day = {
          day: dayKey,
          qty: 0,
          defects: 0,
          operations: 0,
          passportIds: new Set(),
        };
        byDay.set(dayKey, day);
      }
      return day;
    };

    for (const e of events) {
      if (!e.operation) continue;
      const qty = e.qty ?? 0;
      totalQty += qty;
      totalOperations += 1;
      allPassports.add(e.passportId);

      const op = ensureOp(e.operation);
      op.qty += qty;
      op.passportIds.add(e.passportId);

      const day = ensureDay(this.dayKey(e.createdAt));
      day.qty += qty;
      day.operations += 1;
      day.passportIds.add(e.passportId);
    }

    const opMeta = await this.loadOperationMeta(
      defects.map((d) => d.operationId).filter((id) => !ops.has(id)),
    );
    for (const d of defects) {
      totalDefects += d.qty;
      const opInfo = ops.has(d.operationId)
        ? {
            id: d.operationId,
            code: ops.get(d.operationId)!.operationCode,
            name: ops.get(d.operationId)!.operationName,
          }
        : opMeta.get(d.operationId);
      if (opInfo) {
        ensureOp(opInfo).defects += d.qty;
      }
      const day = ensureDay(this.dayKey(d.createdAt));
      day.defects += d.qty;
    }

    const days = Array.from(byDay.values())
      .map((d) => ({
        day: d.day,
        passports: d.passportIds.size,
        qty: d.qty,
        defects: d.defects,
        operations: d.operations,
      }))
      // Новые сверху.
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

    return {
      employeeId: query.employeeId,
      employeeName,
      role,
      from: query.from,
      to: query.to,
      totalPassports: allPassports.size,
      totalQty,
      totalDefects,
      totalOperations,
      operations: this.sortOps(ops),
      byDay: days,
    };
  }

  // ===========================================================================
  // ACTIVE SHIFTS: режим «Активные» (открытые смены прямо сейчас)
  // ===========================================================================

  /**
   * Открытые смены (`ShiftSession.endedAt = null`) с контекстом для
   * мастера: паспорта на руках и активный подкрой. Выборка — тот же
   * запрос, что у `AdminService` (дашборд «Смены»), но без лимита:
   * список нужен целиком, а активных смен на цех — десятки, не тысячи.
   *
   * `startedAt` ASC — самые давние (то есть забытые) сверху. `now`
   * считаем один раз на бэке: длительности в UI идут от серверного
   * времени, а не от часов клиента.
   */
  async getActiveShifts(): Promise<MasterActiveShiftsDto> {
    const now = new Date();
    const rows = await this.prisma.shiftSession.findMany({
      where: { endedAt: null },
      include: {
        employee: { select: { id: true, fullName: true, role: true } },
        equipment: {
          select: { id: true, code: true, name: true, displayNumber: true },
        },
        operation: { select: { id: true, name: true } },
      },
      orderBy: { startedAt: 'asc' },
    });
    const empIds = Array.from(new Set(rows.map((r) => r.employeeId)));

    // Контекст одним батчем на всех: паспорта IN_PROGRESS на руках
    // (groupBy по владельцу) + активные подкрои (`RecutSession.status =
    // 'ACTIVE'` — свободная строка по образцу `CuttingTask.status`).
    const [passportGroups, recuts] =
      empIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.passport.groupBy({
              by: ['currentEmployeeId'],
              where: {
                currentEmployeeId: { in: empIds },
                status: PassportStatus.IN_PROGRESS,
              },
              _count: { _all: true },
            }),
            this.prisma.recutSession.findMany({
              where: { employeeId: { in: empIds }, status: 'ACTIVE' },
              select: { employeeId: true },
            }),
          ]);
    const passportsByEmployee = new Map<string, number>();
    for (const g of passportGroups) {
      if (g.currentEmployeeId) {
        passportsByEmployee.set(g.currentEmployeeId, g._count._all);
      }
    }
    const recutEmployees = new Set(recuts.map((r) => r.employeeId));

    const dtoRows: MasterActiveShiftDto[] = rows.map((r) => ({
      shiftId: r.id,
      employeeId: r.employeeId,
      employeeName: r.employee.fullName,
      role: r.employee.role,
      equipmentId: r.equipment.id,
      equipmentCode: r.equipment.code,
      equipmentName: r.equipment.name,
      equipmentDisplayNumber: r.equipment.displayNumber,
      operationId: r.operation.id,
      operationName: r.operation.name,
      startedAt: r.startedAt.toISOString(),
      passportsInProgress: passportsByEmployee.get(r.employeeId) ?? 0,
      hasActiveRecut: recutEmployees.has(r.employeeId),
    }));

    return { now: now.toISOString(), rows: dtoRows };
  }

  /**
   * Принудительное завершение смены мастером.
   *
   * Правила:
   *   - смены нет или она уже закрыта → успех-noop `{ closed: false }`
   *     (сотрудник мог закрыться сам между GET и POST — это не ошибка,
   *     список у мастера просто обновится);
   *   - без `force` при паспортах `IN_PROGRESS` на руках →
   *     `409 SHIFT_HAS_ACTIVE_PASSPORTS` (UI показывает инлайн-
   *     подтверждение и повторяет с `force: true`) — тот же паттерн,
   *     что у `MeService.switchWorkplace`;
   *   - закрытие идёт через `ShiftsService.stop` — тем же путём, что
   *     самозакрытие (в т.ч. `safeSyncSalary`, оклад выравнивается сам);
   *   - активный подкрой НЕ трогаем: `RecutSession` — отдельная
   *     активность раскройщика, мастер видит только флаг в DTO.
   *
   * Аудит — `MASTER_SHIFT_FORCE_CLOSED` (`entityType = SHIFT_SESSION`,
   * `employeeId` = мастер-актор, закрываемый сотрудник в payload).
   */
  async closeActiveShift(
    actor: AuthPrincipal,
    shiftId: string,
    dto: ForceCloseShiftDto,
  ): Promise<MasterCloseShiftResultDto> {
    const shift = await this.prisma.shiftSession.findUnique({
      where: { id: shiftId },
      select: {
        id: true,
        employeeId: true,
        startedAt: true,
        endedAt: true,
        employee: { select: { fullName: true } },
      },
    });
    if (!shift || shift.endedAt !== null) {
      return { closed: false };
    }

    const passportsInProgress = await this.prisma.passport.count({
      where: {
        currentEmployeeId: shift.employeeId,
        status: PassportStatus.IN_PROGRESS,
      },
    });
    if (!dto.force && passportsInProgress > 0) {
      throw new MasterShiftHasActivePassportsException(passportsInProgress);
    }

    // `stop` закрывает АКТИВНУЮ смену сотрудника — по инварианту «не
    // более одной активной на сотрудника» (partial unique index) это
    // ровно найденная выше. Гонка «сотрудник закрылся сам между check
    // и stop» отдаёт `SHIFT_NOT_ACTIVE` — для мастера это тот же noop.
    try {
      await this.shifts.stop({ employeeId: shift.employeeId });
    } catch (e) {
      if (e instanceof ShiftNotActiveException) {
        return { closed: false };
      }
      throw e;
    }

    // Вне транзакции (как и сам stop) — fail-soft внутри AuditService.
    await this.audit.log({
      event: 'MASTER_SHIFT_FORCE_CLOSED',
      entityType: 'SHIFT_SESSION',
      entityId: shift.id,
      employeeId: actor.employeeId,
      payload: {
        targetEmployeeId: shift.employeeId,
        targetEmployeeName: shift.employee.fullName,
        startedAt: shift.startedAt.toISOString(),
        passportsInProgress,
        force: dto.force,
      },
    });

    return { closed: true };
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private async loadEmployeeMeta(
    ids: string[],
  ): Promise<Map<string, { fullName: string; role: string }>> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.employee.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true, role: true },
    });
    return new Map(rows.map((r) => [r.id, { fullName: r.fullName, role: r.role }]));
  }

  private async loadOperationMeta(
    ids: string[],
  ): Promise<Map<string, { id: string; code: string; name: string }>> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.operation.findMany({
      where: { id: { in: unique } },
      select: { id: true, code: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, { id: r.id, code: r.code, name: r.name }]));
  }

  /** Map операций → отсортированный по `qty` убыв. массив DTO. */
  private sortOps(ops: Map<string, OpAcc>): MasterEmployeeOpStatDto[] {
    return Array.from(ops.values())
      .map((o) => ({
        operationId: o.operationId,
        operationCode: o.operationCode,
        operationName: o.operationName,
        passports: o.passportIds.size,
        qty: o.qty,
        defects: o.defects,
      }))
      .sort((a, b) => b.qty - a.qty || b.passports - a.passports);
  }
}
