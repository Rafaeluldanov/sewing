/**
 * Управленческое форматирование дат для админки.
 *
 * Используется в управленческом слое «Контроль сроков заказа»
 * (см. `@sewing/shared/order-deadlines`):
 *   - `formatDateRu`     — короткая дата `25.04.2026` для бейджа/колонки;
 *   - `formatDaysLeft`   — человекочитаемое «осталось N дн.» / «просрочено
 *     N дн.» / «сегодня» по `daysLeft` из `evaluateOrderDeadline`;
 *   - `formatProgressPercent` — компактный «45%» или «—», когда план не
 *     задан (`progressPercent === null`).
 *
 * Pure-функции: ничего не дёргают из network/IO. Локаль 'ru-RU' жёстко
 * захардкожена — админка локализуется только на русский.
 *
 * Помощник намеренно живёт отдельным файлом в `apps/web/lib`, а не в
 * `@sewing/shared`: формат «25.04.2026» это UI-решение веба и в API/
 * shared-DTO ему места нет (там даты — ISO-string).
 */

/**
 * Пытается распарсить дату-вход (Date | ISO-string | null/undefined).
 * Возвращает `null` на пустое или мусорное значение — без исключений,
 * чтобы UI-рендер не валился из-за плохо сформированной даты.
 */
function parseDateLike(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Короткая русская дата `25.04.2026`. Для пустого значения возвращает
 * `'—'` — это безопасный fallback, который заодно отличает «нет данных»
 * от «дата 01.01.1970». Время в формате намеренно не показываем —
 * в админке это шум.
 */
export function formatDateRu(value: Date | string | null | undefined): string {
  const d = parseDateLike(value);
  if (!d) return '—';
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Человекочитаемое описание `daysLeft` (см. `evaluateOrderDeadline`):
 *   - `null` → `'—'` (срок не задан или невалиден);
 *   - `0`    → `'сегодня'`;
 *   - `> 0`  → `'осталось N дн.'`;
 *   - `< 0`  → `'просрочено N дн.'`.
 *
 * Окончание `'дн.'` упрощено сознательно: «1 день / 2 дня / 5 дней» в
 * рамках MVP избыточно, инфо-плотность колонки списка важнее.
 */
export function formatDaysLeft(daysLeft: number | null | undefined): string {
  if (daysLeft == null) return '—';
  if (daysLeft === 0) return 'сегодня';
  if (daysLeft > 0) return `осталось ${daysLeft} дн.`;
  return `просрочено ${Math.abs(daysLeft)} дн.`;
}

/**
 * Компактный процент `45%`. `null` → `'—'`. Используется в колонке
 * списка и в карточке «Контроль срока».
 */
export function formatProgressPercent(
  percent: number | null | undefined,
): string {
  if (percent == null) return '—';
  return `${percent}%`;
}
