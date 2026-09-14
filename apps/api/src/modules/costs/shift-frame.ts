/**
 * Рамка смены для хронометража окладника (решение владельца 14.09.2026).
 *
 * Зачем. Интервал «взяла крой → сдала» у швеи-окладницы на проде в 43%
 * случаев длиннее часа, p90 = 26 часов: паспорт берут вечером и закрывают
 * назавтра. Прежний потолок в 60 минут на интервал (`MAX_STAGE_MINUTES_PER_
 * PASSPORT`) спасал от ночи в себестоимости, но заодно резал любую честно
 * длинную операцию, а остаток автоматически превращал в «простой».
 *
 * Правило вместо потолка: работа над паспортом может идти только ВНУТРИ
 * смены сотрудника. Интервал пересекается с его закрытыми/открытыми
 * `ShiftSession` — ночь, обед и время вне смены на изделие не попадают, а
 * оплаченные минуты дня (`shift-presence.ts`: те же смены) сходятся с
 * «разнесено + простой» без константы 480.
 *
 * Границы смены — те же, что в деньгах ведомости: одна смена не длиннее
 * предохранителя `shift-worked-cap.ts` (забытую смену закрывают через
 * сутки), открытая смена тянется до серверного `now`.
 *
 * Чистые функции + один загрузчик; покрыто `tests/unit/shift-frame.test.ts`.
 */
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { WorkInterval } from './time-apportionment.js';

/** Отрезок смены, мс от epoch, `[startMs..endMs)`. */
export interface ShiftFrame {
  startMs: number;
  endMs: number;
}

/** Кусок интервала работы внутри одних UTC-суток. */
export interface DayWorkInterval extends WorkInterval {
  /** `YYYY-MM-DD` (UTC) суток, в которых лежит кусок. */
  dayKey: string;
}

/**
 * Объединяет отрезки смен одного сотрудника: сортирует и склеивает
 * пересекающиеся/соприкасающиеся, чтобы пересечение ниже не считало
 * минуту дважды при двух открытых сменах (перекрытие невозможно по
 * гейтам, но данные бывают всякие).
 */
export function mergeShiftFrames(frames: ShiftFrame[]): ShiftFrame[] {
  const sorted = frames
    .filter((f) => f.endMs > f.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: ShiftFrame[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f.startMs <= last.endMs) {
      if (f.endMs > last.endMs) last.endMs = f.endMs;
    } else {
      out.push({ startMs: f.startMs, endMs: f.endMs });
    }
  }
  return out;
}

/**
 * Пересекает интервалы работы с отрезками смен: каждый интервал режется
 * на куски, лежащие внутри смен; всё вне смен отбрасывается. Без смен
 * результат пустой — работа вне оплаченного времени себестоимостью не
 * является (и в простой не попадает: простой считается от тех же смен).
 *
 * `frames` — уже слитые (`mergeShiftFrames`).
 */
export function clipToShiftFrames(
  intervals: WorkInterval[],
  frames: ShiftFrame[],
): WorkInterval[] {
  if (frames.length === 0) return [];
  const out: WorkInterval[] = [];
  for (const iv of intervals) {
    if (iv.endMs <= iv.startMs) continue;
    for (const f of frames) {
      if (f.endMs <= iv.startMs) continue;
      if (f.startMs >= iv.endMs) break;
      const startMs = Math.max(iv.startMs, f.startMs);
      const endMs = Math.min(iv.endMs, f.endMs);
      if (endMs > startMs) {
        out.push({
          passportId: iv.passportId,
          operationId: iv.operationId,
          startMs,
          endMs,
        });
      }
    }
  }
  return out;
}

/**
 * Режет интервалы границами UTC-суток — простой считается по дню, и
 * ночная смена обязана попасть в оба своих дня своей частью (как
 * `splitSegmentByMoscowDays` в табеле, только ось здесь UTC — как у
 * всех отчётов себестоимости).
 */
export function splitByUtcDay(intervals: WorkInterval[]): DayWorkInterval[] {
  const out: DayWorkInterval[] = [];
  for (const iv of intervals) {
    let cursor = iv.startMs;
    // Страховка от кривых данных: интервал длиннее года не бывает.
    for (let guard = 0; cursor < iv.endMs && guard < 400; guard += 1) {
      const dayEnd = startOfNextUtcDayMs(cursor);
      const endMs = Math.min(dayEnd, iv.endMs);
      if (endMs > cursor) {
        out.push({
          passportId: iv.passportId,
          operationId: iv.operationId,
          startMs: cursor,
          endMs,
          dayKey: new Date(cursor).toISOString().slice(0, 10),
        });
      }
      cursor = endMs;
    }
  }
  return out;
}

function startOfNextUtcDayMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Смены сотрудников, пересекающие окно `[from..to]`, по сотруднику —
 * уже слитые. Открытая смена тянется до `now`; любая смена не длиннее
 * `capSeconds` (предохранитель ведомости, `resolveShiftWorkedCapSeconds`).
 */
export async function loadShiftFrames(
  prisma: PrismaService,
  employeeIds: string[],
  from: Date,
  to: Date,
  capSeconds: number,
  now: Date = new Date(),
): Promise<Map<string, ShiftFrame[]>> {
  const out = new Map<string, ShiftFrame[]>();
  if (employeeIds.length === 0) return out;
  const sessions = await prisma.shiftSession.findMany({
    where: {
      employeeId: { in: employeeIds },
      startedAt: { lte: to },
      OR: [{ endedAt: null }, { endedAt: { gte: from } }],
    },
    select: { employeeId: true, startedAt: true, endedAt: true },
  });
  const raw = new Map<string, ShiftFrame[]>();
  for (const s of sessions) {
    const startMs = s.startedAt.getTime();
    const rawEnd = (s.endedAt ?? now).getTime();
    const endMs = Math.min(rawEnd, startMs + capSeconds * 1000);
    if (endMs <= startMs) continue;
    const arr = raw.get(s.employeeId) ?? [];
    arr.push({ startMs, endMs });
    raw.set(s.employeeId, arr);
  }
  for (const [id, frames] of raw) out.set(id, mergeShiftFrames(frames));
  return out;
}
