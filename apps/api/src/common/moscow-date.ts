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
