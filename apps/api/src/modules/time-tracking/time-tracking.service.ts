import { Injectable, NotFoundException } from '@nestjs/common';
import { PassportEventType } from '@prisma/client';
import type {
  TimeTrackingDayDto,
  TimeTrackingDto,
  TimeTrackingEventDto,
  TimeTrackingQuery,
  TimeTrackingSessionDto,
  TimeTrackingSummaryDto,
  TimeTrackingSummaryRowDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MasterEmployeeStatsService } from '../master-employee-stats/master-employee-stats.service.js';

/**
 * «Тайм-трекер сотрудника» — вкладка на карточке сотрудника (read-only).
 *
 * Строит рабочий день во времени из уже пишущихся данных: сеансы —
 * `ShiftSession`, содержимое сеанса — собственные `PassportEvent`
 * сотрудника (`OPERATION_FINISHED` / `ISSUED_TO_EMPLOYEE`). Ничего не
 * мутирует. Контракт и семантика — `packages/shared/src/time-tracking.ts`.
 *
 * Брак не считаем заново — переиспользуем finisher-attribution из
 * `MasterEmployeeStatsService.getDrill` (та же UTC-day семантика окна),
 * чтобы «Тайм-трекер» и «Статистика по сотрудникам» показывали
 * одинаковые цифры брака.
 */
@Injectable()
export class TimeTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterStats: MasterEmployeeStatsService,
  ) {}

  /** [from, to] окно по UTC-дням, `to` — конец дня (включительно). */
  private window(from: string, to: string): { from: Date; to: Date } {
    return {
      from: new Date(`${from}T00:00:00.000Z`),
      to: new Date(`${to}T23:59:59.999Z`),
    };
  }

  /** UTC-`YYYY-MM-DD` из Date (день сеанса/брака). */
  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Обзор ВСЕХ активных сотрудников за период (список-уровень вкладки).
   * Строка = сотрудник + его часы/сеансы/выработка/брак + «на смене
   * сейчас». Провал в строку → `getTimeTracking` (таймлайн сеансов).
   *
   * Объёмы небольшие (десятки сотрудников, сотни сеансов/событий за
   * неделю) — тянем плоские срезы и сворачиваем в памяти, без N+1.
   */
  async getSummary(query: TimeTrackingQuery): Promise<TimeTrackingSummaryDto> {
    const win = this.window(query.from, query.to);
    const now = new Date();

    const employees = await this.prisma.employee.findMany({
      where: { active: true },
      select: { id: true, fullName: true, role: true },
      orderBy: { fullName: 'asc' },
    });
    const empIds = employees.map((e) => e.id);
    if (empIds.length === 0) {
      return { from: query.from, to: query.to, rows: [] };
    }

    // Сеансы в окне (для часов/счётчика), открытые сеансы СЕЙЧАС
    // (для «на смене»), завершения в окне (выработка), и брак — из
    // проверенной агрегации master-stats.
    const [sessions, openNow, finished, stats] = await Promise.all([
      this.prisma.shiftSession.findMany({
        where: { employeeId: { in: empIds }, startedAt: { gte: win.from, lte: win.to } },
        select: { employeeId: true, startedAt: true, endedAt: true },
      }),
      this.prisma.shiftSession.findMany({
        where: { employeeId: { in: empIds }, endedAt: null },
        select: {
          employeeId: true,
          startedAt: true,
          equipment: { select: { code: true } },
          operation: { select: { name: true } },
        },
      }),
      this.prisma.passportEvent.findMany({
        where: {
          employeeId: { in: empIds },
          type: PassportEventType.OPERATION_FINISHED,
          createdAt: { gte: win.from, lte: win.to },
        },
        select: { employeeId: true, qty: true, createdAt: true },
      }),
      this.masterStats.getStats({ from: query.from, to: query.to }),
    ]);

    const defectsByEmp = new Map(
      stats.rows.map((r) => [r.employeeId, r.totalDefects]),
    );

    // Сворачиваем сеансы: минуты + счётчик + последняя активность.
    const sessAgg = new Map<
      string,
      { minutes: number; count: number; lastAt: number }
    >();
    for (const s of sessions) {
      const end = s.endedAt ?? now;
      const minutes = Math.max(
        0,
        Math.round((end.getTime() - s.startedAt.getTime()) / 60000),
      );
      const a = sessAgg.get(s.employeeId) ?? { minutes: 0, count: 0, lastAt: 0 };
      a.minutes += minutes;
      a.count += 1;
      a.lastAt = Math.max(a.lastAt, s.startedAt.getTime());
      sessAgg.set(s.employeeId, a);
    }

    // Открытые сеансы «сейчас» → на смене + текущий станок/операция.
    const openByEmp = new Map<
      string,
      { equipmentCode: string | null; operationName: string | null }
    >();
    for (const o of openNow) {
      // Один активный сеанс на сотрудника (инвариант), но на всякий
      // случай не перетираем уже найденный.
      if (!openByEmp.has(o.employeeId)) {
        openByEmp.set(o.employeeId, {
          equipmentCode: o.equipment?.code ?? null,
          operationName: o.operation?.name ?? null,
        });
      }
    }

    // Завершения: операции + штуки + последняя активность.
    const finAgg = new Map<
      string,
      { ops: number; qty: number; lastAt: number }
    >();
    for (const f of finished) {
      const a = finAgg.get(f.employeeId ?? '') ?? { ops: 0, qty: 0, lastAt: 0 };
      a.ops += 1;
      a.qty += f.qty ?? 0;
      a.lastAt = Math.max(a.lastAt, f.createdAt.getTime());
      if (f.employeeId) finAgg.set(f.employeeId, a);
    }

    const rows: TimeTrackingSummaryRowDto[] = employees.map((e) => {
      const s = sessAgg.get(e.id);
      const f = finAgg.get(e.id);
      const open = openByEmp.get(e.id);
      const minutes = s?.minutes ?? 0;
      const qty = f?.qty ?? 0;
      const lastAt = Math.max(s?.lastAt ?? 0, f?.lastAt ?? 0);
      return {
        employeeId: e.id,
        employeeName: e.fullName,
        role: e.role,
        onShift: !!open,
        currentEquipmentCode: open?.equipmentCode ?? null,
        currentOperationName: open?.operationName ?? null,
        totalMinutes: minutes,
        sessionsCount: s?.count ?? 0,
        operationsCount: f?.ops ?? 0,
        qtyGood: qty,
        defects: defectsByEmp.get(e.id) ?? 0,
        perHour: minutes > 0 ? Math.round(qty / (minutes / 60)) : 0,
        lastActivityAt: lastAt > 0 ? new Date(lastAt).toISOString() : null,
      };
    });

    // На смене — сверху; затем по отработанному времени, затем по выработке.
    rows.sort(
      (a, b) =>
        Number(b.onShift) - Number(a.onShift) ||
        b.totalMinutes - a.totalMinutes ||
        b.qtyGood - a.qtyGood,
    );

    return { from: query.from, to: query.to, rows };
  }

  async getTimeTracking(
    employeeId: string,
    query: TimeTrackingQuery,
  ): Promise<TimeTrackingDto> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, role: true, roles: true },
    });
    if (!employee) throw new NotFoundException('EMPLOYEE_NOT_FOUND');

    const win = this.window(query.from, query.to);
    const now = new Date();

    // Сеансы сотрудника, начавшиеся в окне. Открытые (`endedAt = null`)
    // считаем до текущего момента — часы «идут».
    const sessions = await this.prisma.shiftSession.findMany({
      where: { employeeId, startedAt: { gte: win.from, lte: win.to } },
      include: {
        equipment: { select: { id: true, code: true, name: true } },
        operation: { select: { id: true, code: true, name: true } },
      },
      orderBy: { startedAt: 'asc' },
    });

    // Собственные события сотрудника за окно: завершения операций и
    // выдачи кроя. Это материал для таймлайна и per-session агрегатов.
    const events = await this.prisma.passportEvent.findMany({
      where: {
        employeeId,
        type: {
          in: [
            PassportEventType.OPERATION_FINISHED,
            PassportEventType.ISSUED_TO_EMPLOYEE,
          ],
        },
        createdAt: { gte: win.from, lte: win.to },
      },
      select: {
        type: true,
        qty: true,
        createdAt: true,
        operation: { select: { code: true, name: true } },
        passport: {
          select: {
            id: true,
            number: true,
            color: true,
            size: { select: { code: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Брак за период — переиспользуем проверенную атрибуцию финишёру.
    const drill = await this.masterStats.getDrill({
      employeeId,
      from: query.from,
      to: query.to,
    });
    const defectsByDay = new Map<string, number>();
    for (const d of drill.byDay) defectsByDay.set(d.day, d.defects);

    // --- раскладываем события по сеансам и собираем агрегаты ---
    const sessionDtos: TimeTrackingSessionDto[] = [];
    const byDayAgg = new Map<
      string,
      { minutes: number; sessions: number; ops: number; qty: number }
    >();
    let totalMinutes = 0;
    let totalOps = 0;
    let totalQty = 0;
    let openSessionsCount = 0;

    for (const s of sessions) {
      const start = s.startedAt;
      const end = s.endedAt ?? now;
      const open = s.endedAt === null;
      if (open) openSessionsCount += 1;

      const durationMinutes = Math.max(
        0,
        Math.round((end.getTime() - start.getTime()) / 60000),
      );

      // События внутри окна сеанса [start; end].
      const inWindow = events.filter(
        (e) => e.createdAt >= start && e.createdAt <= end,
      );

      const evDtos: TimeTrackingEventDto[] = [];
      evDtos.push({
        type: 'SESSION_START',
        at: start.toISOString(),
        operationCode: s.operation.code,
        operationName: s.operation.name,
        passportId: null,
        passportNumber: null,
        passportColor: null,
        passportSizeCode: null,
        qty: null,
      });

      let ops = 0;
      let qty = 0;
      for (const e of inWindow) {
        const isFinish = e.type === PassportEventType.OPERATION_FINISHED;
        if (isFinish) {
          ops += 1;
          qty += e.qty ?? 0;
        }
        evDtos.push({
          type: isFinish ? 'OPERATION_FINISHED' : 'ISSUED_TO_EMPLOYEE',
          at: e.createdAt.toISOString(),
          operationCode: e.operation?.code ?? null,
          operationName: e.operation?.name ?? null,
          passportId: e.passport?.id ?? null,
          passportNumber: e.passport?.number ?? null,
          passportColor: e.passport?.color ?? null,
          passportSizeCode: e.passport?.size?.code ?? null,
          qty: isFinish ? e.qty ?? 0 : null,
        });
      }

      if (open) {
        evDtos.push({
          type: 'IN_PROGRESS',
          at: now.toISOString(),
          operationCode: s.operation.code,
          operationName: s.operation.name,
          passportId: null,
          passportNumber: null,
          passportColor: null,
          passportSizeCode: null,
          qty: null,
        });
      } else {
        evDtos.push({
          type: 'SESSION_END',
          at: end.toISOString(),
          operationCode: null,
          operationName: null,
          passportId: null,
          passportNumber: null,
          passportColor: null,
          passportSizeCode: null,
          qty: null,
        });
      }

      sessionDtos.push({
        id: s.id,
        startedAt: start.toISOString(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
        open,
        equipmentId: s.equipment.id,
        equipmentCode: s.equipment.code,
        equipmentName: s.equipment.name,
        operationId: s.operation.id,
        operationCode: s.operation.code,
        operationName: s.operation.name,
        durationMinutes,
        operationsCount: ops,
        qtyGood: qty,
        events: evDtos,
      });

      totalMinutes += durationMinutes;
      totalOps += ops;
      totalQty += qty;

      const key = this.dayKey(start);
      const agg = byDayAgg.get(key) ?? {
        minutes: 0,
        sessions: 0,
        ops: 0,
        qty: 0,
      };
      agg.minutes += durationMinutes;
      agg.sessions += 1;
      agg.ops += ops;
      agg.qty += qty;
      byDayAgg.set(key, agg);
    }

    // Дни = объединение дней с сеансами и дней с браком (чтобы итоги
    // сходились, даже если брак «упал» на день без сеанса).
    const dayKeys = new Set<string>([
      ...byDayAgg.keys(),
      ...defectsByDay.keys(),
    ]);
    const byDay: TimeTrackingDayDto[] = Array.from(dayKeys)
      .map((day) => {
        const a = byDayAgg.get(day);
        return {
          day,
          minutes: a?.minutes ?? 0,
          sessionsCount: a?.sessions ?? 0,
          operationsCount: a?.ops ?? 0,
          qtyGood: a?.qty ?? 0,
          defects: defectsByDay.get(day) ?? 0,
        };
      })
      // Отбрасываем «фантомные» дни: пришли только из union по браку
      // (в getDrill есть выработка за день, но у нас нет ни сеанса, ни
      // брака в этот день) — иначе в разбивке появлялась бы строка с
      // нулями. День с браком-без-сеанса (`defects > 0`) сохраняем.
      .filter((d) => d.minutes > 0 || d.sessionsCount > 0 || d.defects > 0)
      // Новые сверху.
      .sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : 0));

    return {
      employeeId: employee.id,
      employeeName: employee.fullName,
      role: employee.role,
      roles: employee.roles,
      from: query.from,
      to: query.to,
      totalMinutes,
      sessionsCount: sessionDtos.length,
      openSessionsCount,
      operationsCount: totalOps,
      qtyGood: totalQty,
      defects: drill.totalDefects,
      byDay,
      // Новые сеансы сверху; события внутри остаются по возрастанию.
      sessions: sessionDtos.slice().reverse(),
    };
  }
}
