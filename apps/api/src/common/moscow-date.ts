/**
 * Дата в часовом поясе Europe/Moscow как `{ yyyy, mm, dd }` — для суточных
 * счётчиков номеров документов вида `ПРЕФИКС-YYYYMMDD-NNNN`.
 *
 * Иначе (при `getUTC*`) и дата в номере, и суточный счётчик катятся по
 * UTC-полуночи = 03:00 МСК: документ, созданный 00:00–03:00 МСК, уезжает на
 * ПРОШЛЫЙ календарный день и попадает в его счётчик (T6). Весь домен работает
 * по Москве, поэтому нумерацию тоже ведём по московской дате.
 *
 * `mm`/`dd` — уже двузначные (padStart не нужен); `yyyy` — число (совместимо с
 * прежним `now.getUTCFullYear()`).
 */
export function moscowDateParts(now: Date = new Date()): {
  yyyy: number;
  mm: string;
  dd: string;
} {
  // en-CA даёт ISO-подобный `YYYY-MM-DD` в заданной зоне.
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = iso.split('-');
  return { yyyy: Number(y), mm: m, dd: d };
}

/** `YYYY-MM-DD` по Москве (тот же формат, что шлёт UI). */
export function moscowDayKey(now: Date = new Date()): string {
  const { yyyy, mm, dd } = moscowDateParts(now);
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Границы московских суток для `YYYY-MM-DD`: `[from; to)`.
 *
 * Смещение зашито как `+03:00`: Москва живёт без перехода на летнее
 * время с 2014 года, поэтому вычислять его через `Intl` не нужно
 * (и нечем — обратного преобразования «локальное время зоны → UTC» в
 * стандартном `Intl` нет).
 *
 * Полуоткрытый интервал, а не «конец дня 23:59:59.999»: смена,
 * начавшаяся ровно в полночь, должна попасть в новый день ровно один
 * раз. Сравнения на бэке — `gte: from, lt: to`.
 */
export function moscowDayWindow(day: string): { from: Date; to: Date } {
  const from = new Date(`${day}T00:00:00.000+03:00`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}
