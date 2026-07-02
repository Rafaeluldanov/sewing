/**
 * Общие помощники периода/форматирования для вкладки «Тайм-трекер»
 * (обзор всех сотрудников и провал в одного). Держим в одном месте,
 * чтобы список и карточка считали дни одинаково.
 *
 * Московский день (см. допущение в `packages/shared/src/time-tracking.ts`:
 * на дневных сменах цеха московский день совпадает с UTC-днём окна на
 * бэке). Время событий форматируется в `Europe/Moscow`
 * (см. memory feedback про hydration/timezone).
 */

export type TtPeriod = 'day' | 'week' | 'month';

export const MSK = 'Europe/Moscow';
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Сегодняшний московский день как `YYYY-MM-DD`. */
export function moscowToday(): string {
  const msk = new Date(Date.now() + MSK_OFFSET_MS);
  return `${msk.getUTCFullYear()}-${pad2(msk.getUTCMonth() + 1)}-${pad2(
    msk.getUTCDate(),
  )}`;
}

/** Полдень UTC выбранного дня — безопасный «якорь» для арифметики дат. */
export function noon(dayStr: string): Date {
  return new Date(`${dayStr}T12:00:00.000Z`);
}

export function addDays(dayStr: string, delta: number): string {
  const d = noon(dayStr);
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate(),
  )}`;
}

/** Диапазон `[from; to]` под период и якорный день. */
export function computeRange(
  period: TtPeriod,
  anchor: string,
): { from: string; to: string } {
  if (period === 'day') return { from: anchor, to: anchor };
  if (period === 'week') {
    const wd = noon(anchor).getUTCDay(); // 0=вс..6=сб
    const backToMonday = (wd + 6) % 7;
    const from = addDays(anchor, -backToMonday);
    return { from, to: addDays(from, 6) };
  }
  // month
  const a = noon(anchor);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth();
  const from = `${y}-${pad2(m + 1)}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from, to: `${y}-${pad2(m + 1)}-${pad2(lastDay)}` };
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < 400 && cur <= to; i += 1) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function normalizePeriod(v: string | undefined): TtPeriod {
  return v === 'day' || v === 'month' ? v : 'week';
}

export function normalizeAnchor(v: string | undefined): string {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : moscowToday();
}

// ---- форматирование ----

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    timeZone: MSK,
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtHM(totalMinutes: number): { h: number; m: number } {
  return { h: Math.floor(totalMinutes / 60), m: totalMinutes % 60 };
}

export function fmtDurLabel(totalMinutes: number): string {
  const { h, m } = fmtHM(totalMinutes);
  return h > 0 ? `${h} ч ${pad2(m)} м` : `${m} м`;
}

export function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export function fmtDayTitle(dayStr: string): string {
  return cap(
    noon(dayStr).toLocaleDateString('ru-RU', {
      timeZone: MSK,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }),
  );
}

export function fmtShort(dayStr: string): string {
  return noon(dayStr).toLocaleDateString('ru-RU', {
    timeZone: MSK,
    day: 'numeric',
    month: 'short',
  });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: MSK,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtRangeLabel(period: TtPeriod, from: string, to: string): string {
  if (period === 'day') return fmtDayTitle(from);
  const year = noon(to).toLocaleDateString('ru-RU', {
    timeZone: MSK,
    year: 'numeric',
  });
  return `${fmtShort(from)} — ${fmtShort(to)} ${year}`;
}

export function ru(n: number): string {
  return n.toLocaleString('ru-RU');
}
