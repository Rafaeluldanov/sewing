/**
 * Автозавершение смен, забытых открытыми — арифметика правила.
 *
 * Проблема. `ShiftSession` не связана с сессией и не закрывается сама:
 * человек уходит домой, не нажав «Завершить смену», и часы продолжают
 * идти. На проде на 31.08.2026 из 755 закрытых смен 429 длиннее 10
 * часов, 269 длиннее 16, 194 — дольше суток; рекорд 1643 часа (68
 * суток). Всё, что считается от времени в смене — загрузка, «часы по
 * дням», выработка в час — после такого недостоверно.
 *
 * Правило состоит из двух независимых порогов, и берётся ближайший:
 *   - ВРЕМЯ СУТОК по Москве (`shiftAutoCloseTime`, «в 22:00 цех пуст»);
 *   - ПРЕДЕЛЬНАЯ ДЛИТЕЛЬНОСТЬ (`shiftMaxDurationHours`) — предохранитель
 *     для смен, начатых сразу ПОСЛЕ времени суток: у них ближайший порог
 *     почти через сутки.
 *
 * Отдельно от порога стоит вопрос, что записать в `endedAt` — это
 * `ShiftAutoCloseMode`. Порог решает, КОГДА закрывать; режим решает,
 * каким временем. `LAST_ACTIVITY` (по умолчанию) ставит последнюю
 * отметку сотрудника: иначе в часы попадают вечер и ночь, когда в цехе
 * никого не было, и аналитика остаётся такой же кривой, только с
 * закрытыми сменами.
 *
 * Функции чистые (без БД и без DI) — так правило можно проверить
 * тестами на границах суток, а не вылавливать на живом цехе.
 */

/**
 * Москва — UTC+3 без перехода на летнее время (с 2014 года). Смещение
 * зашито тем же приёмом, что в `common/moscow-date.ts::moscowDayWindow`.
 */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ShiftAutoClosePolicy {
  /**
   * Время суток по Москве в минутах от полуночи (`22:00` → 1320) или
   * `null` — порог по времени выключен.
   */
  closeAtMinutes: number | null;
  /** Предельная длительность смены в часах; `0` — выключено. */
  maxDurationHours: number;
  /** Чем считать конец смены. */
  mode: 'AT_DEADLINE' | 'LAST_ACTIVITY';
}

/** Правило выключено целиком — ни одного порога. */
export function isAutoClosePolicyEnabled(policy: ShiftAutoClosePolicy): boolean {
  return policy.closeAtMinutes !== null || policy.maxDurationHours > 0;
}

/**
 * Ближайший момент `HH:MM` по Москве СТРОГО ПОСЛЕ `after`.
 *
 * «Строго после» принципиально: смена, начатая ровно в 22:00 при пороге
 * 22:00, должна жить до следующего вечера, а не закрыться в ту же
 * секунду, в которую открылась.
 */
export function nextMoscowTimeAfter(after: Date, minutesOfDay: number): Date {
  // Переводим в «московское время, представленное как UTC» — тогда
  // полночь считается обычным делением на сутки.
  const shifted = after.getTime() + MSK_OFFSET_MS;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  let candidate = dayStart + minutesOfDay * 60_000;
  if (candidate <= shifted) candidate += DAY_MS;
  return new Date(candidate - MSK_OFFSET_MS);
}

/**
 * Момент, в который смена должна быть закрыта, или `null`, если правило
 * выключено. Берём РАННИЙ из порогов: они ограничивают смену с разных
 * сторон и должны работать вместе, а не по очереди.
 */
export function resolveShiftDeadline(
  startedAt: Date,
  policy: ShiftAutoClosePolicy,
): Date | null {
  const candidates: Date[] = [];
  if (policy.closeAtMinutes !== null) {
    candidates.push(nextMoscowTimeAfter(startedAt, policy.closeAtMinutes));
  }
  if (policy.maxDurationHours > 0) {
    candidates.push(
      new Date(startedAt.getTime() + policy.maxDurationHours * 60 * 60 * 1000),
    );
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((min, d) => (d < min ? d : min));
}

/**
 * Каким временем закрыть смену.
 *
 * `AT_DEADLINE` — самим порогом.
 * `LAST_ACTIVITY` — последней отметкой сотрудника, но:
 *   - не раньше начала смены (защита от событий, попавших в выборку по
 *     кривым данным);
 *   - не позже порога — иначе правило можно было бы обойти, продолжая
 *     работать: смена закрылась бы задним числом «в будущем».
 *
 * Если отметок не было вовсе, `lastActivityAt = null` ⇒ конец = начало,
 * то есть смена нулевой длины. Это сознательно: система не видела ни
 * одного действия человека, и записывать ему часы не за что. Именно
 * такие смены — «открыл терминал и ушёл» — и портят аналитику сильнее
 * всего.
 */
export function resolveShiftEndedAt(args: {
  startedAt: Date;
  deadline: Date;
  lastActivityAt: Date | null;
  mode: ShiftAutoClosePolicy['mode'];
}): Date {
  if (args.mode === 'AT_DEADLINE') return args.deadline;
  const activity = args.lastActivityAt ?? args.startedAt;
  const notBeforeStart =
    activity < args.startedAt ? args.startedAt : activity;
  return notBeforeStart > args.deadline ? args.deadline : notBeforeStart;
}
