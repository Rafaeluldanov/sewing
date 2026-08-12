import { Injectable } from '@nestjs/common';
import { PassportEventType, PassportStatus } from '@prisma/client';
import type {
  ForceCloseShiftDto,
  MasterActiveShiftDto,
  MasterActiveShiftsDto,
  MasterCloseShiftResultDto,
  MasterEmployeeAccessDto,
  MasterEmployeeAccessListDto,
  MasterEmployeeDayDto,
  MasterEmployeeDayOperationDto,
  MasterEmployeeDayPlaceDto,
  MasterEmployeeDayQuery,
  MasterEmployeeDaySegmentDto,
  MasterEmployeeDrillDto,
  MasterEmployeeOpStatDto,
  MasterEmployeeRibbonPartDto,
  MasterEmployeeStatsDto,
  MasterEmployeeStatsDrillQuery,
  MasterEmployeeStatsQuery,
  MasterEmployeeStatRowDto,
  MasterUpdateEmployeeAccessDto,
} from '@sewing/shared';
import { isMasterAssignableRole } from '@sewing/shared';
import { normalizeAssignedRoles } from '@sewing/shared/employees';
import {
  EmployeeNotFoundException,
  MasterEmployeeNotEditableException,
  MasterRoleNotAssignableException,
  MasterRolePairRedundantException,
  MasterShiftHasActivePassportsException,
  ShiftNotActiveException,
} from '../../common/errors.js';
import { moscowDayKey, moscowDayWindow } from '../../common/moscow-date.js';
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

  /** `YYYY-MM-DD` по Москве из Date. */
  private dayKey(d: Date): string {
    return moscowDayKey(d);
  }

  /**
   * Окно `[from; to)` по МОСКОВСКИМ суткам (`to` — начало следующих за
   * `to` суток).
   *
   * Раньше окно строилось по UTC, и вся вкладка ехала на 3 часа: работа
   * с 00:00 до 03:00 МСК попадала в предыдущий день, а «Сегодня» её не
   * показывало. Цех живёт по Москве — и нумерация паспортов
   * (`moscowDateParts`), и табель дня считаются одинаково.
   */
  private window(from: string, to: string): { from: Date; to: Date } {
    return {
      from: moscowDayWindow(from).from,
      to: moscowDayWindow(to).to,
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
        createdAt: { gte: window.from, lt: window.to },
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
        createdAt: { gte: window.from, lt: window.to },
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

  /**
   * Отрезки смен (`ShiftSegment`), пересекающие окно, с их рабочим
   * местом и операцией.
   *
   * Условие пересечения, а не «начались внутри»: вечерняя смена,
   * доработавшая до утра, обязана попасть в оба дня своей частью —
   * иначе у одного дня пропадут часы, а у другого появятся чужие.
   * Обрезка по границам окна — на вызывающей стороне (`clampSegment`).
   */
  private async loadSegments(window: { from: Date; to: Date }) {
    return this.prisma.shiftSegment.findMany({
      where: {
        startedAt: { lt: window.to },
        OR: [{ endedAt: null }, { endedAt: { gt: window.from } }],
      },
      select: {
        id: true,
        employeeId: true,
        startedAt: true,
        endedAt: true,
        equipment: {
          select: { id: true, name: true, displayNumber: true },
        },
        operation: {
          select: { id: true, code: true, name: true, category: true },
        },
        employee: { select: { id: true, fullName: true, role: true } },
      },
      orderBy: { startedAt: 'asc' },
    });
  }

  /**
   * Обрезка отрезка границами окна. Открытый отрезок тянется до
   * серверного `now` (но не дальше конца окна — вчерашний день не
   * должен «расти» вместе с текущей смной).
   */
  private clampSegment(
    seg: { startedAt: Date; endedAt: Date | null },
    window: { from: Date; to: Date },
    now: Date,
  ): { start: Date; end: Date; minutes: number } {
    const rawEnd = seg.endedAt ?? now;
    const start = seg.startedAt < window.from ? window.from : seg.startedAt;
    const end = rawEnd > window.to ? window.to : rawEnd;
    const minutes = Math.max(
      0,
      Math.round((end.getTime() - start.getTime()) / 60_000),
    );
    return { start, end, minutes };
  }

  // ===========================================================================
  // LIST: таблица сотрудников
  // ===========================================================================

  async getStats(
    query: MasterEmployeeStatsQuery,
  ): Promise<MasterEmployeeStatsDto> {
    const window = this.window(query.from, query.to);
    const now = new Date();
    const [events, defects, segments] = await Promise.all([
      this.loadFinishedEvents(window),
      this.loadAttributedDefects(window),
      this.loadSegments(window),
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

    // Время в смене + мини-лента дня. Сотрудник, который был на смене,
    // но не закрыл ни одной операции, ПОЯВЛЯЕТСЯ в списке нулевой
    // строкой: «отработал 8 часов и ничего не сдал» — как раз то, что
    // мастеру важно увидеть, а раньше такой человек просто отсутствовал.
    const singleDay = query.from === query.to;
    const dayStart = window.from.getTime();
    interface TimeAcc {
      workedMinutes: number;
      hasOpenSegment: boolean;
      staleShift: boolean;
      ribbon: MasterEmployeeRibbonPartDto[];
    }
    const timeByEmployee = new Map<string, TimeAcc>();
    for (const seg of segments) {
      const { start, minutes } = this.clampSegment(seg, window, now);
      let t = timeByEmployee.get(seg.employeeId);
      if (!t) {
        t = {
          workedMinutes: 0,
          hasOpenSegment: false,
          staleShift: false,
          ribbon: [],
        };
        timeByEmployee.set(seg.employeeId, t);
      }
      t.workedMinutes += minutes;
      if (seg.endedAt === null) {
        t.hasOpenSegment = true;
        // Открытый отрезок, начавшийся ДО этого окна, — смена висит с
        // прошлых суток (сотрудник забыл закрыться).
        if (seg.startedAt < window.from) t.staleShift = true;
      }
      // Отрезок нулевой длины (смену открыли только что) тоже кладём в
      // ленту: UI рисует ему минимальную ширину — засечку «здесь
      // началось». Иначе только что вышедший сотрудник выглядел бы как
      // не выходивший вовсе.
      if (singleDay) {
        t.ribbon.push({
          startMinute: Math.round((start.getTime() - dayStart) / 60_000),
          minutes,
          category: seg.operation.category,
        });
      }
      // Строка для тех, у кого есть время, но нет ни выработки, ни брака.
      ensureEmployee(
        seg.employeeId,
        seg.employee.fullName,
        seg.employee.role,
      );
    }

    const rows: MasterEmployeeStatRowDto[] = Array.from(byEmployee.values()).map(
      (acc) => {
        const t = timeByEmployee.get(acc.employeeId);
        return {
          employeeId: acc.employeeId,
          employeeName: acc.employeeName,
          role: acc.role,
          totalPassports: acc.passportIds.size,
          totalQty: acc.totalQty,
          totalDefects: acc.totalDefects,
          totalOperations: acc.totalOperations,
          operations: this.sortOps(acc.ops),
          workedMinutes: t?.workedMinutes ?? 0,
          hasOpenSegment: t?.hasOpenSegment ?? false,
          staleShift: t?.staleShift ?? false,
          ribbon: t?.ribbon ?? [],
        };
      },
    );

    // Сортировка таблицы: больше всего штук — сверху. Нулевые строки
    // (был на смене, ничего не закрыл) падают вниз, но сортируются
    // между собой по отработанному времени — «просидел 8 часов» должно
    // стоять выше, чем «зашёл на 10 минут».
    rows.sort(
      (a, b) =>
        b.totalQty - a.totalQty ||
        b.totalPassports - a.totalPassports ||
        b.workedMinutes - a.workedMinutes,
    );

    return {
      from: query.from,
      to: query.to,
      rows,
      now: now.toISOString(),
    };
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
  // DAY: табель дня (где был, сколько работал, сколько сделал)
  // ===========================================================================

  /**
   * Табель одного сотрудника за одни МОСКОВСКИЕ сутки — см. семантику в
   * `packages/shared/src/master-employee-stats.ts`
   * (`MasterEmployeeDayQuerySchema` и ниже).
   *
   * Схема расчёта:
   *   1. отрезки смен (`ShiftSegment`), пересекающие сутки, обрезаются
   *      по границам дня → «где был» и время;
   *   2. `OPERATION_FINISHED` сотрудника за сутки раскладываются по
   *      отрезкам (по времени) и по операциям (по операции события);
   *   3. брак приходит с двух сторон: атрибутированный сотруднику как
   *      исполнителю (`loadAttributedDefects`) и зафиксированный им
   *      самим (`DEFECT_RECORDED.employeeId` — работа ОТК).
   *
   * Сотрудник без единого отрезка и события отдаётся нулевым табелем, а
   * не 404: мастер открывает карточку из списка, и «пусто» — валидный
   * ответ («сегодня не выходил»).
   */
  async getDay(query: MasterEmployeeDayQuery): Promise<MasterEmployeeDayDto> {
    const window = moscowDayWindow(query.date);
    const now = new Date();

    const [allSegments, events, allDefects, defectsFound, employee] =
      await Promise.all([
        this.loadSegments(window),
        this.loadFinishedEvents(window),
        this.loadAttributedDefects(window),
        this.prisma.passportEvent.findMany({
          where: {
            type: PassportEventType.DEFECT_RECORDED,
            employeeId: query.employeeId,
            operationId: { not: null },
            qty: { gt: 0 },
            createdAt: { gte: window.from, lt: window.to },
          },
          select: { operationId: true, qty: true },
        }),
        this.prisma.employee.findUnique({
          where: { id: query.employeeId },
          select: { fullName: true, role: true },
        }),
      ]);

    const segments = allSegments.filter(
      (s) => s.employeeId === query.employeeId,
    );
    const myEvents = events.filter((e) => e.employeeId === query.employeeId);
    const myDefects = allDefects.filter(
      (d) => d.employeeId === query.employeeId,
    );

    // ---- отрезки + штуки внутри них ------------------------------------
    const segmentDtos: MasterEmployeeDaySegmentDto[] = [];
    /** operationId → минуты (время «по операциям» = время их отрезков). */
    const minutesByOp = new Map<string, number>();
    /** `category:equipmentId` → накопитель «где был». */
    const places = new Map<
      string,
      {
        category: string;
        equipmentName: string;
        equipmentDisplayNumber: string | null;
        minutes: number;
        operations: Set<string>;
      }
    >();

    for (const seg of segments) {
      const { start, end, minutes } = this.clampSegment(seg, window, now);
      const qty = myEvents.reduce(
        (sum, e) =>
          e.createdAt >= start && e.createdAt <= end ? sum + (e.qty ?? 0) : sum,
        0,
      );
      segmentDtos.push({
        segmentId: seg.id,
        startedAt: start.toISOString(),
        endedAt: seg.endedAt ? seg.endedAt.toISOString() : null,
        minutes,
        equipmentId: seg.equipment.id,
        equipmentName: seg.equipment.name,
        equipmentDisplayNumber: seg.equipment.displayNumber,
        operationId: seg.operation.id,
        operationName: seg.operation.name,
        category: seg.operation.category,
        qty,
        isOpen: seg.endedAt === null,
      });

      minutesByOp.set(
        seg.operation.id,
        (minutesByOp.get(seg.operation.id) ?? 0) + minutes,
      );

      const placeKey = `${seg.operation.category}:${seg.equipment.id}`;
      let place = places.get(placeKey);
      if (!place) {
        place = {
          category: seg.operation.category,
          equipmentName: seg.equipment.name,
          equipmentDisplayNumber: seg.equipment.displayNumber,
          minutes: 0,
          operations: new Set(),
        };
        places.set(placeKey, place);
      }
      place.minutes += minutes;
      place.operations.add(seg.operation.id);
    }

    // ---- итоги времени --------------------------------------------------
    const workedMinutes = segmentDtos.reduce((s, x) => s + x.minutes, 0);
    let presenceMinutes = 0;
    let breaks = 0;
    if (segmentDtos.length > 0) {
      const first = new Date(segmentDtos[0]!.startedAt).getTime();
      const lastSeg = segments[segments.length - 1]!;
      const last = this.clampSegment(lastSeg, window, now).end.getTime();
      presenceMinutes = Math.max(0, Math.round((last - first) / 60_000));
      // Пауза = зазор между соседними отрезками от минуты и больше.
      // Меньше минуты — это переключение операции, а не перерыв.
      for (let i = 1; i < segments.length; i += 1) {
        const prevEnd = this.clampSegment(
          segments[i - 1]!,
          window,
          now,
        ).end.getTime();
        const currStart = this.clampSegment(
          segments[i]!,
          window,
          now,
        ).start.getTime();
        if (currStart - prevEnd >= 60_000) breaks += 1;
      }
    }
    const idleMinutes = Math.max(0, presenceMinutes - workedMinutes);

    // ---- разбивка по операциям ------------------------------------------
    interface DayOpAcc {
      operationId: string;
      operationCode: string;
      operationName: string;
      category: string;
      qty: number;
      defects: number;
      defectsFound: number;
    }
    const opAcc = new Map<string, DayOpAcc>();
    const ensureDayOp = (op: {
      id: string;
      code: string;
      name: string;
      category: string;
    }): DayOpAcc => {
      let o = opAcc.get(op.id);
      if (!o) {
        o = {
          operationId: op.id,
          operationCode: op.code,
          operationName: op.name,
          category: op.category,
          qty: 0,
          defects: 0,
          defectsFound: 0,
        };
        opAcc.set(op.id, o);
      }
      return o;
    };

    // Операции отрезков — даже без выработки: «стояла на ВТО два часа и
    // ничего не закрыла» должно быть видно строкой, а не пропасть.
    for (const seg of segments) {
      ensureDayOp({
        id: seg.operation.id,
        code: seg.operation.code,
        name: seg.operation.name,
        category: seg.operation.category,
      });
    }

    const opIdsFromEvents = myEvents
      .map((e) => e.operationId)
      .filter((id): id is string => !!id);
    const opIdsFromDefects = [
      ...myDefects.map((d) => d.operationId),
      ...defectsFound
        .map((d) => d.operationId)
        .filter((id): id is string => !!id),
    ];
    const opMeta = await this.loadOperationMetaFull([
      ...opIdsFromEvents,
      ...opIdsFromDefects,
    ]);

    for (const e of myEvents) {
      if (!e.operation) continue;
      const meta = opMeta.get(e.operation.id);
      ensureDayOp({
        id: e.operation.id,
        code: e.operation.code,
        name: e.operation.name,
        category: meta?.category ?? '',
      }).qty += e.qty ?? 0;
    }
    for (const d of myDefects) {
      const meta = opMeta.get(d.operationId);
      if (!meta) continue;
      ensureDayOp(meta).defects += d.qty;
    }
    for (const d of defectsFound) {
      if (!d.operationId) continue;
      const meta = opMeta.get(d.operationId);
      if (!meta) continue;
      ensureDayOp(meta).defectsFound += d.qty ?? 0;
    }

    const norms = await this.loadTimeNorms(Array.from(opAcc.keys()));
    const operations: MasterEmployeeDayOperationDto[] = Array.from(
      opAcc.values(),
    )
      .map((o) => {
        const minutes = minutesByOp.get(o.operationId) ?? 0;
        const normSec = norms.get(o.operationId) ?? null;
        // План (норма × штуки) к факту (время отрезков). >100% — быстрее
        // нормы. Без нормы, без штук или без времени — «—», а не 0%.
        const normPercent =
          normSec !== null && minutes > 0 && o.qty > 0
            ? Math.round(((normSec * o.qty) / 60 / minutes) * 100)
            : null;
        return {
          operationId: o.operationId,
          operationCode: o.operationCode,
          operationName: o.operationName,
          category: o.category,
          minutes,
          qty: o.qty,
          defects: o.defects,
          defectsFound: o.defectsFound,
          normSec,
          normPercent,
        };
      })
      .sort((a, b) => b.minutes - a.minutes || b.qty - a.qty);

    const placeRows: MasterEmployeeDayPlaceDto[] = Array.from(places.entries())
      .map(([key, p]) => ({
        key,
        category: p.category,
        equipmentName: p.equipmentName,
        equipmentDisplayNumber: p.equipmentDisplayNumber,
        minutes: p.minutes,
        share:
          workedMinutes > 0 ? Math.round((p.minutes / workedMinutes) * 100) : 0,
        operations: p.operations.size,
      }))
      .sort((a, b) => b.minutes - a.minutes);

    const first = myEvents[0]?.employee;
    return {
      employeeId: query.employeeId,
      employeeName: employee?.fullName ?? first?.fullName ?? '—',
      role: employee?.role ?? first?.role ?? '',
      date: query.date,
      now: now.toISOString(),
      presenceMinutes,
      workedMinutes,
      idleMinutes,
      breaks,
      utilization:
        presenceMinutes > 0
          ? Math.round((workedMinutes / presenceMinutes) * 100)
          : null,
      totalQty: myEvents.reduce((s, e) => s + (e.qty ?? 0), 0),
      totalDefects: myDefects.reduce((s, d) => s + d.qty, 0),
      totalDefectsFound: defectsFound.reduce((s, d) => s + (d.qty ?? 0), 0),
      transitions: Math.max(0, segmentDtos.length - 1),
      hasOpenSegment: segmentDtos.some((s) => s.isOpen),
      segments: segmentDtos,
      places: placeRows,
      operations,
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
  // ACCESS: режим «Доступы» (участки сотрудников)
  // ===========================================================================

  /**
   * Все активные сотрудники с их назначенными участками — источник
   * списка режима «Доступы».
   *
   * Почему не переиспользуем `transfer-candidates`: тот список
   * отсортирован под передачу паспорта (сверху те, чья смена стоит на
   * нужной операции) и привязан к паспорту. Здесь нужен просто цех
   * по алфавиту.
   *
   * `editable = false` у тех, у кого есть роль вне белого списка
   * мастера: такую карточку мастер видит (полезно понимать, кто есть
   * кто), но не редактирует — иначе сохранение набора без «чужой» роли
   * тихо отобрало бы человеку доступ.
   */
  async listAccess(): Promise<MasterEmployeeAccessListDto> {
    const employees = await this.prisma.employee.findMany({
      where: { active: true },
      select: {
        id: true,
        fullName: true,
        login: true,
        role: true,
        roles: true,
        activeRole: true,
        shiftSessions: {
          where: { endedAt: null },
          take: 1,
          select: {
            equipment: { select: { name: true, displayNumber: true } },
            operation: { select: { name: true } },
          },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    return {
      rows: employees.map((e) => {
        const roles = normalizeAssignedRoles(e.role, e.roles);
        const shift = e.shiftSessions[0];
        return {
          employeeId: e.id,
          employeeName: e.fullName,
          login: e.login,
          primaryRole: e.role,
          roles,
          activeRole: e.activeRole ?? e.role,
          editable: roles.every((r) => isMasterAssignableRole(r)),
          activeShift: shift
            ? {
                equipmentName: shift.equipment.name,
                equipmentDisplayNumber: shift.equipment.displayNumber,
                operationName: shift.operation.name,
              }
            : null,
        };
      }),
    };
  }

  /**
   * Мастер меняет набор участков сотрудника.
   *
   * Намеренно НЕ переиспользуем `PATCH /api/employees/:id`: тот же
   * контроллер правит зарплату, PIN и архив, и открывать его мастеру
   * ради ролей — расширять доступ на всё сразу. Здесь узкий контракт:
   * только `roles` + `primaryRole`, только из белого списка
   * (`MASTER_ASSIGNABLE_ROLES`), с обеих сторон — и в новом наборе, и
   * в текущем (нельзя «уронить» админа до швеи).
   *
   * Побочный эффект, повторяющий `EmployeesService.update`: если
   * активный участок выпал из набора, `activeRole` сбрасывается —
   * иначе сотрудник остался бы залипшим на терминале, куда его больше
   * не пускают.
   */
  async updateAccess(
    actor: AuthPrincipal,
    employeeId: string,
    dto: MasterUpdateEmployeeAccessDto,
  ): Promise<MasterEmployeeAccessDto> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        login: true,
        role: true,
        roles: true,
        activeRole: true,
      },
    });
    if (!employee) throw new EmployeeNotFoundException();

    const current = normalizeAssignedRoles(employee.role, employee.roles);
    if (!current.every((r) => isMasterAssignableRole(r))) {
      throw new MasterEmployeeNotEditableException();
    }

    const next = normalizeAssignedRoles(dto.primaryRole, dto.roles);
    const forbidden = next.find((r) => !isMasterAssignableRole(r));
    if (forbidden) throw new MasterRoleNotAssignableException(forbidden);
    if (next.includes('CUTTER') && next.includes('CUTTER_ASSISTANT')) {
      throw new MasterRolePairRedundantException();
    }

    const sameSet =
      next.length === current.length && next.every((r) => current.includes(r));
    if (sameSet && dto.primaryRole === employee.role) {
      return this.buildAccessRow(employee, next);
    }

    const activeRole =
      employee.activeRole && next.includes(employee.activeRole)
        ? employee.activeRole
        : null;

    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: { role: dto.primaryRole, roles: next, activeRole },
      select: {
        id: true,
        fullName: true,
        login: true,
        role: true,
        roles: true,
        activeRole: true,
      },
    });

    await this.audit.log({
      event: 'MASTER_EMPLOYEE_ROLES_UPDATED',
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      employeeId: actor.employeeId,
      payload: {
        targetEmployeeName: employee.fullName,
        before: { role: employee.role, roles: current },
        after: { role: updated.role, roles: next },
      },
    });

    return this.buildAccessRow(updated, next);
  }

  /** Строка ответа `updateAccess` — без смены (её мастер видит в списке). */
  private buildAccessRow(
    employee: {
      id: string;
      fullName: string;
      login: string;
      role: string;
      activeRole: string | null;
    },
    roles: string[],
  ): MasterEmployeeAccessDto {
    return {
      employeeId: employee.id,
      employeeName: employee.fullName,
      login: employee.login,
      primaryRole: employee.role,
      roles,
      activeRole: employee.activeRole ?? employee.role,
      editable: roles.every((r) => isMasterAssignableRole(r)),
      activeShift: null,
    };
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

  /** То же, что `loadOperationMeta`, но с категорией (цвет участка). */
  private async loadOperationMetaFull(
    ids: string[],
  ): Promise<
    Map<string, { id: string; code: string; name: string; category: string }>
  > {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.operation.findMany({
      where: { id: { in: unique } },
      select: { id: true, code: true, name: true, category: true },
    });
    return new Map(rows.map((r) => [r.id, { ...r, category: r.category }]));
  }

  /**
   * Нормы времени операций (сек/шт) для «% выполнения нормы».
   *
   * Только `timeNormMode = "FIXED"`: поразмерная норма
   * (`OperationTimeNormBySize`) к дню не сводится — в дне перемешаны
   * размеры, а событие `OPERATION_FINISHED` размер не несёт. Для таких
   * операций отдаём `null`, и UI честно рисует «—» вместо
   * правдоподобного, но выдуманного процента.
   */
  private async loadTimeNorms(ids: string[]): Promise<Map<string, number>> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.operation.findMany({
      where: { id: { in: unique }, timeNormMode: 'FIXED' },
      select: { id: true, timeNormSec: true },
    });
    const out = new Map<string, number>();
    for (const r of rows) {
      if (r.timeNormSec !== null && r.timeNormSec > 0) {
        out.set(r.id, r.timeNormSec);
      }
    }
    return out;
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
