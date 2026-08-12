/**
 * Расчёт отработанного времени по отрезкам смен (`ShiftSegment`) —
 * ЕДИНОЕ ядро для всех, кто показывает часы сотрудника.
 *
 * Потребители:
 *   - «Табель дня» и список вкладки «Сотрудники» в кабинете мастера
 *     (`master-employee-stats`);
 *   - «Тайм-трекер сотрудника» в админке (`time-tracking`).
 *
 * Почему ядро общее, а не «у каждого свой расчёт». Эти две вкладки
 * обещают показывать одни и те же цифры (тайм-трекер даже берёт брак
 * прямо из `MasterEmployeeStatsService`), но считали время каждая сама —
 * и 12.08.2026 разъехались на три часа, когда одна перешла на
 * московские сутки, а вторая осталась на UTC. Пока формула живёт в
 * одном месте, такой рассинхрон невозможен по построению.
 *
 * Функции, а не сервис: два запроса и чистая арифметика, ради которых
 * тащить DI-зависимость в каждый модуль дороже, чем передать `prisma`
 * аргументом. Тот же приём, что у `route-work-permits.ts` и
 * `shift-segments.ts`.
 */
import type { PrismaClient } from '@prisma/client';
import { moscowDayKey, moscowDayWindow } from '../../common/moscow-date.js';

/** Минимальный клиент: подходит и `PrismaService`, и `tx`. */
type Db = Pick<PrismaClient, 'shiftSegment'>;

/** Полуоткрытое окно `[from; to)`. */
export interface TimeWindow {
  from: Date;
  to: Date;
}

/** Отрезок смены со связанными рабочим местом, операцией и сотрудником. */
export interface LoadedShiftSegment {
  id: string;
  employeeId: string;
  startedAt: Date;
  endedAt: Date | null;
  shiftSessionId: string;
  equipment: { id: string; code: string; name: string; displayNumber: string | null };
  operation: { id: string; code: string; name: string; category: string };
  employee: { id: string; fullName: string; role: string };
}

/**
 * Отрезки, ПЕРЕСЕКАЮЩИЕ окно (не «начавшиеся внутри»).
 *
 * Вечерняя смена, доработавшая до утра, обязана попасть в оба дня своей
 * частью — иначе у одного дня пропадут часы, а у другого появятся
 * чужие. Обрезка по границам — `clampSegment`.
 *
 * `employeeIds` сужает выборку, когда потребитель знает список заранее
 * (обзор тайм-трекера); без него берём весь цех (список мастера).
 */
export async function loadShiftSegments(
  db: Db,
  window: TimeWindow,
  employeeIds?: string[],
): Promise<LoadedShiftSegment[]> {
  return db.shiftSegment.findMany({
    where: {
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      startedAt: { lt: window.to },
      OR: [{ endedAt: null }, { endedAt: { gt: window.from } }],
    },
    select: {
      id: true,
      employeeId: true,
      startedAt: true,
      endedAt: true,
      shiftSessionId: true,
      equipment: {
        select: { id: true, code: true, name: true, displayNumber: true },
      },
      operation: {
        select: { id: true, code: true, name: true, category: true },
      },
      employee: { select: { id: true, fullName: true, role: true } },
    },
    orderBy: { startedAt: 'asc' },
  });
}

export interface ClampedSegment {
  start: Date;
  end: Date;
  minutes: number;
}

/**
 * Обрезка отрезка границами окна.
 *
 * Открытый отрезок (`endedAt = null`) тянется до серверного `now`, но не
 * дальше конца окна: вчерашний день не должен «расти» вместе с текущей
 * смной.
 */
export function clampSegment(
  seg: { startedAt: Date; endedAt: Date | null },
  window: TimeWindow,
  now: Date,
): ClampedSegment {
  const rawEnd = seg.endedAt ?? now;
  const start = seg.startedAt < window.from ? window.from : seg.startedAt;
  const end = rawEnd > window.to ? window.to : rawEnd;
  const minutes = Math.max(
    0,
    Math.round((end.getTime() - start.getTime()) / 60_000),
  );
  return { start, end, minutes };
}

/** Итоги времени сотрудника за окно. */
export interface EmployeeTimeTotals {
  /** Сумма отрезков, минут («в смене»). */
  workedMinutes: number;
  /**
   * От начала первого отрезка до конца последнего, минут («на работе»).
   * Не сумма отрезков — включает паузы между ними.
   */
  presenceMinutes: number;
  /** `presenceMinutes − workedMinutes` («вне смены»). */
  idleMinutes: number;
  /** Пауз между отрезками (зазор от минуты и больше). */
  breaks: number;
  /** Загрузка, %: `worked / presence`. `null` при нулевом присутствии. */
  utilization: number | null;
  /** Есть незакрытый отрезок — сотрудник на смене прямо сейчас. */
  hasOpenSegment: boolean;
  /**
   * Открытый отрезок начался ДО окна — смена висит с прошлых суток
   * (сотрудник забыл закрыться).
   */
  staleShift: boolean;
  /** Число отрезков в окне. */
  segmentsCount: number;
}

/**
 * Сводит отрезки ОДНОГО сотрудника в итоги времени.
 *
 * Ожидает отрезки по возрастанию `startedAt` (как их отдаёт
 * `loadShiftSegments`).
 *
 * Пауза = зазор между соседними отрезками от минуты и больше: меньше
 * минуты — это переключение операции внутри смены, а не перерыв.
 */
export function summarizeSegments(
  segments: Array<{ startedAt: Date; endedAt: Date | null }>,
  window: TimeWindow,
  now: Date,
): EmployeeTimeTotals {
  if (segments.length === 0) {
    return {
      workedMinutes: 0,
      presenceMinutes: 0,
      idleMinutes: 0,
      breaks: 0,
      utilization: null,
      hasOpenSegment: false,
      staleShift: false,
      segmentsCount: 0,
    };
  }

  const clamped = segments.map((s) => clampSegment(s, window, now));
  const workedMinutes = clamped.reduce((sum, c) => sum + c.minutes, 0);

  const first = clamped[0]!.start.getTime();
  const last = clamped[clamped.length - 1]!.end.getTime();
  const presenceMinutes = Math.max(0, Math.round((last - first) / 60_000));

  let breaks = 0;
  for (let i = 1; i < clamped.length; i += 1) {
    if (clamped[i]!.start.getTime() - clamped[i - 1]!.end.getTime() >= 60_000) {
      breaks += 1;
    }
  }

  const hasOpenSegment = segments.some((s) => s.endedAt === null);
  const staleShift = segments.some(
    (s) => s.endedAt === null && s.startedAt < window.from,
  );

  return {
    workedMinutes,
    presenceMinutes,
    idleMinutes: Math.max(0, presenceMinutes - workedMinutes),
    breaks,
    utilization:
      presenceMinutes > 0
        ? Math.round((workedMinutes / presenceMinutes) * 100)
        : null,
    hasOpenSegment,
    staleShift,
    segmentsCount: segments.length,
  };
}

/**
 * Раскладывает отрезок по МОСКОВСКИМ суткам: `[{ day, minutes }]`.
 *
 * Нужна там, где часы показываются подневно («Часы по дням» в
 * тайм-трекере). Без неё ночная смена 22:00–02:00 целиком падала бы в
 * день своего начала — четыре часа в первых сутках вместо двух и двух,
 * — и подневная разбивка расходилась бы с табелем мастера, который
 * режет отрезки границами суток.
 *
 * Отрезок сначала обрезается окном, потом делится по полуночам.
 */
export function splitSegmentByMoscowDays(
  seg: { startedAt: Date; endedAt: Date | null },
  window: TimeWindow,
  now: Date,
): Array<{ day: string; minutes: number }> {
  const { start, end } = clampSegment(seg, window, now);
  if (end <= start) return [];

  const out: Array<{ day: string; minutes: number }> = [];
  let cursor = start;
  // Страховка от бесконечного цикла на кривых данных: отрезок длиннее
  // года не бывает, а если появится — лучше усечь, чем повесить запрос.
  for (let guard = 0; cursor < end && guard < 400; guard += 1) {
    const day = moscowDayKey(cursor);
    const dayEnd = moscowDayWindow(day).to;
    const chunkEnd = dayEnd < end ? dayEnd : end;
    const minutes = Math.max(
      0,
      Math.round((chunkEnd.getTime() - cursor.getTime()) / 60_000),
    );
    if (minutes > 0) out.push({ day, minutes });
    cursor = chunkEnd;
  }
  return out;
}

/** Группировка отрезков по сотруднику (порядок внутри сохраняется). */
export function groupSegmentsByEmployee<T extends { employeeId: string }>(
  segments: T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const s of segments) {
    const list = out.get(s.employeeId);
    if (list) list.push(s);
    else out.set(s.employeeId, [s]);
  }
  return out;
}
