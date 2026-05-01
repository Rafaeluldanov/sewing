/**
 * Helpers для UI плановой нормы времени операций (см.
 * `docs/operation-time-norms-recon.md §10`, форма
 * `apps/web/app/admin/operations/[id]/edit-form.tsx`).
 *
 * В БД и DTO норма хранится в **секундах** (целое); пользователь в UI
 * вводит «минуты + секунды». Здесь живёт двусторонняя нормализация и
 * человекочитаемое форматирование. Backend / DTO не меняем — только
 * presentation layer.
 */

/**
 * Разобрать секунды на пару «минуты + секунды». `null`/`undefined` →
 * пустые поля. Отрицательные числа клемим в `0` (защита от мусора в
 * данных).
 */
export function splitSeconds(
  total: number | null | undefined,
): { minutes: number; seconds: number } {
  if (total == null || !Number.isFinite(total) || total <= 0) {
    return { minutes: 0, seconds: 0 };
  }
  const safe = Math.max(0, Math.floor(total));
  return { minutes: Math.floor(safe / 60), seconds: safe % 60 };
}

/**
 * Собрать «минуты + секунды» в одно целое число секунд. Возвращает
 * `null`, если оба значения пустые/нулевые/невалидные — UI трактует
 * это как «норма не задана» и не передаёт значение в DTO.
 *
 * Контракты валидации:
 *   - минуты ≥ 0 (целое);
 *   - секунды 0..59 (целое);
 *   - итог > 0; иначе `null`.
 */
export function toSeconds(
  minutes: number | string | null | undefined,
  seconds: number | string | null | undefined,
): number | null {
  const m = parseNonNegativeInt(minutes);
  const s = parseNonNegativeInt(seconds);
  if (m === null && s === null) return null;
  const safeM = m ?? 0;
  const safeS = s ?? 0;
  if (safeS > 59) return null;
  const total = safeM * 60 + safeS;
  return total > 0 ? total : null;
}

/**
 * Человекочитаемое представление нормы времени.
 *
 * Поддерживает три уровня:
 *   - `null` / `0` / некорректное значение → `'—'`;
 *   - до 60 секунд → `'40 сек'`;
 *   - до 60 минут → `'1 мин 40 сек'` / `'2 мин'`;
 *   - 1 час и более → `'1 ч'` / `'1 ч 16 мин 40 сек'`.
 *
 * Используется и в списке операций (одна-две минуты), и в карточке
 * заказа для блока «План операций» (этап 2 из
 * `docs/operation-time-norms-recon.md §10`), где значения могут быть
 * многочасовыми. Поэтому helper един — UI везде читает время одной
 * и той же формулой.
 */
export function formatDuration(
  total: number | null | undefined,
): string {
  if (total == null || !Number.isFinite(total) || total <= 0) return '—';
  const safe = Math.max(0, Math.floor(total));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0) parts.push(`${minutes} мин`);
  if (seconds > 0) parts.push(`${seconds} сек`);
  return parts.length > 0 ? parts.join(' ') : '0 сек';
}

/**
 * Алиас `formatDuration` под именем, явно подчёркивающим, что вход —
 * целое число секунд. Используется в новом блоке «План операций» на
 * `/admin/orders/[id]` (этап 2 «Расчёт плана на заказе»). Контракт
 * 1:1 совпадает с `formatDuration`, чтобы карточка операции и
 * карточка заказа никогда не разъезжались по форматированию.
 */
export function formatDurationSec(
  total: number | null | undefined,
): string {
  return formatDuration(total);
}

function parseNonNegativeInt(
  v: number | string | null | undefined,
): number | null {
  if (v === null || v === undefined) return null;
  const str = typeof v === 'string' ? v.trim() : String(v);
  if (str.length === 0) return null;
  const num = Number(str.replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.floor(num);
}
