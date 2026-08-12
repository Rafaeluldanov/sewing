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
import { moscowDayKey, moscowDayWindow } from '../../common/moscow-date.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MasterEmployeeStatsService } from '../master-employee-stats/master-employee-stats.service.js';
import {
  clampSegment,
  loadShiftSegments,
  splitSegmentByMoscowDays,
} from '../shifts/shift-time.js';

/**
 * «Тайм-трекер сотрудника» — вкладка на карточке сотрудника (read-only).
 *
 * Строит рабочий день во времени из уже пишущихся данных: сеанс —
 * `ShiftSession`, ЧАСЫ — его отрезки `ShiftSegment` (общее ядро
 * `shifts/shift-time.ts`), содержимое сеанса — собственные
 * `PassportEvent` сотрудника (`OPERATION_FINISHED` /
 * `ISSUED_TO_EMPLOYEE`). Ничего не мутирует. Контракт и семантика —
 * `packages/shared/src/time-tracking.ts`.
 *
 * Часы считает НЕ сам: и здесь, и в кабинете мастера время приходит из
 * одного ядра. Пока расчётов было два, они разъехались на три часа
 * (12.08.2026) — вкладки обещают одинаковые цифры, поэтому и формула
 * обязана быть одна.
 *
 * Брак не считаем заново — переиспользуем finisher-attribution из
 * `MasterEmployeeStatsService.getDrill` (окно там и здесь — одни и те
 * же МОСКОВСКИЕ сутки), чтобы «Тайм-трекер» и «Статистика по
 * сотрудникам» показывали одинаковые цифры брака.
 */
@Injectable()
export class TimeTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterStats: MasterEmployeeStatsService,
  ) {}

  /**
   * Окно `[from; to)` по МОСКОВСКИМ суткам (`to` — начало следующих за
   * `to` суток).
   *
   * Строго тот же расчёт, что у `MasterEmployeeStatsService.window`, и
   * это ОБЯЗАТЕЛЬНО: брак сюда приезжает из `masterStats.getStats` /
   * `getDrill`, и разные окна означали бы разные цифры в двух вкладках,
   * которые обещают показывать одно и то же (см. шапку файла). Заодно
   * уходит трёхчасовой сдвиг: сеанс, начатый в 01:00 МСК, больше не
   * падает в предыдущий день.
   */
  private window(from: string, to: string): { from: Date; to: Date } {
    return {
      from: moscowDayWindow(from).from,
      to: moscowDayWindow(to).to,
    };
  }

  /** `YYYY-MM-DD` по Москве из Date (день сеанса/брака). */
  private dayKey(d: Date): string {
    return moscowDayKey(d);
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

    // Часы — по ОТРЕЗКАМ смен (`ShiftSegment`, общее ядро
    // `shifts/shift-time.ts`), а не по сеансам целиком: тем же расчётом
    // живёт вкладка мастера, и разъехаться цифрам больше негде. Побочно
    // это чинит две ошибки прежней выборки «сеансы, начавшиеся в окне»:
    // смена, начатая до периода, не пропадает, а смена, ушедшая за его
    // конец, не засчитывается периоду целиком.
    const [segments, openNow, finished, stats] = await Promise.all([
      loadShiftSegments(this.prisma, win, empIds),
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
          createdAt: { gte: win.from, lt: win.to },
        },
        select: { employeeId: true, qty: true, createdAt: true },
      }),
      this.masterStats.getStats({ from: query.from, to: query.to }),
    ]);

    const defectsByEmp = new Map(
      stats.rows.map((r) => [r.employeeId, r.totalDefects]),
    );

    // Сворачиваем отрезки: минуты + счётчик сеансов + последняя
    // активность. «Сеансов» считаем по РАЗНЫМ `shiftSessionId`, а не по
    // числу отрезков: для пользователя сеанс — это смена, а не её
    // внутренние переключения операции.
    const sessAgg = new Map<
      string,
      { minutes: number; sessionIds: Set<string>; lastAt: number }
    >();
    for (const seg of segments) {
      const { start, minutes } = clampSegment(seg, win, now);
      const a = sessAgg.get(seg.employeeId) ?? {
        minutes: 0,
        sessionIds: new Set<string>(),
        lastAt: 0,
      };
      a.minutes += minutes;
      a.sessionIds.add(seg.shiftSessionId);
      a.lastAt = Math.max(a.lastAt, start.getTime());
      sessAgg.set(seg.employeeId, a);
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
        sessionsCount: s?.sessionIds.size ?? 0,
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

    // Отрезки смен сотрудника за окно (общее ядро `shift-time.ts`) —
    // источник ВСЕХ часов на этом экране, включая длительность сеанса.
    const segments = await loadShiftSegments(this.prisma, win, [employeeId]);
    /** shiftSessionId → минуты его отрезков внутри окна. */
    const minutesBySession = new Map<string, number>();
    for (const seg of segments) {
      const { minutes } = clampSegment(seg, win, now);
      minutesBySession.set(
        seg.shiftSessionId,
        (minutesBySession.get(seg.shiftSessionId) ?? 0) + minutes,
      );
    }

    // Сами сеансы (шапка карточки: станок, операция, границы). Берём те,
    // у которых есть отрезки в окне, — так сеанс, начатый вчера и
    // продолжающийся сегодня, не пропадает из сегодняшнего дня.
    const sessions = await this.prisma.shiftSession.findMany({
      where: {
        employeeId,
        OR: [
          { id: { in: Array.from(minutesBySession.keys()) } },
          // Подстраховка для смен, заведённых до появления отрезков и не
          // попавших в бэкфилл: старое условие «начались в окне».
          { startedAt: { gte: win.from, lt: win.to } },
        ],
      },
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
        createdAt: { gte: win.from, lt: win.to },
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
    const ensureDayAgg = (day: string) => {
      let agg = byDayAgg.get(day);
      if (!agg) {
        agg = { minutes: 0, sessions: 0, ops: 0, qty: 0 };
        byDayAgg.set(day, agg);
      }
      return agg;
    };
    let totalMinutes = 0;
    let totalOps = 0;
    let totalQty = 0;
    let openSessionsCount = 0;

    for (const s of sessions) {
      const start = s.startedAt;
      const end = s.endedAt ?? now;
      const open = s.endedAt === null;
      if (open) openSessionsCount += 1;

      // Длительность — сумма отрезков сеанса, попавших в окно. Fallback
      // на «конец минус начало» нужен смене без отрезков (заведена до
      // появления `ShiftSegment` и мимо бэкфилла).
      const durationMinutes =
        minutesBySession.get(s.id) ??
        Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));

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

      // В подневную разбивку кладём только счётчик сеансов: минуты
      // раскладываются отдельно, по границам суток (ниже), а операции и
      // штуки — по дню самого события. Иначе ночная смена целиком
      // ложилась бы в день своего начала.
      const key = this.dayKey(start);
      const agg = ensureDayAgg(key);
      agg.sessions += 1;
    }

    // Минуты по суткам — из отрезков (общее ядро): отрезок, пересекающий
    // полночь, делится между днями ровно так же, как в табеле мастера.
    for (const seg of segments) {
      for (const part of splitSegmentByMoscowDays(seg, win, now)) {
        ensureDayAgg(part.day).minutes += part.minutes;
      }
    }
    // Операции и штуки — по дню самого события.
    for (const e of events) {
      if (e.type !== PassportEventType.OPERATION_FINISHED) continue;
      const agg = ensureDayAgg(this.dayKey(e.createdAt));
      agg.ops += 1;
      agg.qty += e.qty ?? 0;
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
