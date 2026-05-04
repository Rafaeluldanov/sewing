/**
 * `StockPagination` — пагинация Назад/Вперёд для read-only API
 * склада (`limit` / `offset`).
 *
 * Отличие от общего `<AdminPagination>`: backend складского API
 * принимает `limit` / `offset`, а не `page` / `pageSize`. Делаем
 * лёгкий собственный компонент, чтобы не мешать общую страничную
 * семантику с offset-based, и не переписывать общий компонент
 * (его уже использует ~весь /admin).
 *
 * Поведение:
 *   - state живёт в URL (`?tab=...&limit=50&offset=100`);
 *   - кнопки — обычные `<Link>`; на disabled-краях — `aria-disabled`
 *     `<span>`, как в `AdminPagination`;
 *   - дополнительные query-параметры (например, `q`) сохраняем
 *     через `preserveParams`.
 */
import Link from 'next/link';

interface Props {
  total: number;
  limit: number;
  offset: number;
  basePath: string;
  /**
   * Параметры, которые надо сохранять при переключении страницы
   * (например, `tab`, `q`, `direction`, `type`).
   */
  preserveParams?: Record<string, string | undefined>;
  /** Подпись справа от диапазона, например «остатков» / «движений». */
  label?: string;
}

function buildHref(
  basePath: string,
  limit: number,
  offset: number,
  preserve: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(preserve)) {
    if (v !== undefined && v !== '') params.set(k, v);
  }
  params.set('limit', String(limit));
  params.set('offset', String(Math.max(0, offset)));
  return `${basePath}?${params.toString()}`;
}

export function StockPagination({
  total,
  limit,
  offset,
  basePath,
  preserveParams = {},
  label,
}: Props) {
  if (total === 0) return null;
  const safeLimit = Math.max(1, limit);
  const safeOffset = Math.max(0, Math.min(offset, total));
  const from = safeOffset + 1;
  const to = Math.min(safeOffset + safeLimit, total);
  const labelStr = label ? ` ${label}` : '';

  // Если всё помещается на одну страницу — без кнопок.
  if (total <= safeLimit) {
    return (
      <div className="admin-pagination" aria-label="Итог">
        <span className="admin-pagination__range">
          Показано {from}–{to} из {total}
          {labelStr}
        </span>
      </div>
    );
  }

  const prevOffset = safeOffset > 0 ? Math.max(0, safeOffset - safeLimit) : null;
  const nextOffset = to < total ? safeOffset + safeLimit : null;
  const prevHref =
    prevOffset !== null
      ? buildHref(basePath, safeLimit, prevOffset, preserveParams)
      : '#';
  const nextHref =
    nextOffset !== null
      ? buildHref(basePath, safeLimit, nextOffset, preserveParams)
      : '#';

  return (
    <nav className="admin-pagination" aria-label="Пагинация">
      <span className="admin-pagination__range">
        Показано {from}–{to} из {total}
        {labelStr}
      </span>
      <div className="admin-pagination__nav">
        {prevOffset !== null ? (
          <Link href={prevHref} className="admin-pagination__btn">
            ← Назад
          </Link>
        ) : (
          <span className="admin-pagination__btn" aria-disabled="true">
            ← Назад
          </span>
        )}
        {nextOffset !== null ? (
          <Link href={nextHref} className="admin-pagination__btn">
            Вперёд →
          </Link>
        ) : (
          <span className="admin-pagination__btn" aria-disabled="true">
            Вперёд →
          </span>
        )}
      </div>
    </nav>
  );
}
