/**
 * AdminPagination — лёгкая URL-based пагинация для admin-списков.
 *
 * Намеренно server-friendly:
 *   - состояние живёт в query-params (`?page=2&pageSize=50`);
 *   - кнопки — обычные `<Link>`, без client-state;
 *   - смена pageSize — крошечный client-only `<select>` с submit'ом
 *     на `onChange` (см. `PageSizeSelect` ниже).
 *
 * Backend не трогаем — всё считается клиентом по `total`.
 * Если в списке ≤ pageSize — рендерим только `range`-строку, без
 * кнопок/select'а: «Показано 1–N из N».
 */
import Link from 'next/link';
import { PageSizeSelect } from './admin-pagination.client';

interface AdminPaginationProps {
  /** Текущая страница (1-based). */
  page: number;
  /** Размер страницы. */
  pageSize: number;
  /** Всего элементов (после фильтров). */
  total: number;
  /** Префикс пути, к которому склеиваем query (например, `/admin/employees`). */
  basePath: string;
  /**
   * Доп. query-параметры, которые надо сохранять при переключении
   * страницы (например, `?role=SEAMSTRESS`).
   */
  preserveParams?: Record<string, string | undefined>;
  /** Возможные размеры страницы. */
  pageSizeOptions?: number[];
  /** Подпись справа от количества (например, «сотрудников»). */
  label?: string;
}

const DEFAULT_SIZES = [20, 50, 100];

function buildHref(
  basePath: string,
  page: number,
  pageSize: number,
  preserve: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(preserve)) {
    if (v !== undefined && v !== '') params.set(k, v);
  }
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return `${basePath}?${params.toString()}`;
}

export function AdminPagination({
  page,
  pageSize,
  total,
  basePath,
  preserveParams = {},
  pageSizeOptions = DEFAULT_SIZES,
  label,
}: AdminPaginationProps) {
  if (total === 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const from = (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);
  const labelStr = label ? ` ${label}` : '';

  // Если всё помещается на одну страницу — без кнопок и без size-select.
  if (totalPages <= 1) {
    return (
      <div className="admin-pagination" aria-label="Итог">
        <span className="admin-pagination__range">
          Показано {from}–{to} из {total}
          {labelStr}
        </span>
      </div>
    );
  }

  const prev = safePage > 1 ? safePage - 1 : null;
  const next = safePage < totalPages ? safePage + 1 : null;
  const prevHref =
    prev !== null ? buildHref(basePath, prev, pageSize, preserveParams) : '#';
  const nextHref =
    next !== null ? buildHref(basePath, next, pageSize, preserveParams) : '#';

  return (
    <nav className="admin-pagination" aria-label="Пагинация">
      <span className="admin-pagination__range">
        Показано {from}–{to} из {total}
        {labelStr}
      </span>
      <div className="admin-pagination__nav">
        {prev !== null ? (
          <Link href={prevHref} className="admin-pagination__btn">
            ← Назад
          </Link>
        ) : (
          <span className="admin-pagination__btn" aria-disabled="true">
            ← Назад
          </span>
        )}
        <span className="admin-pagination__range">
          {safePage} / {totalPages}
        </span>
        {next !== null ? (
          <Link href={nextHref} className="admin-pagination__btn">
            Вперёд →
          </Link>
        ) : (
          <span className="admin-pagination__btn" aria-disabled="true">
            Вперёд →
          </span>
        )}
      </div>
      <PageSizeSelect
        basePath={basePath}
        pageSize={pageSize}
        options={pageSizeOptions}
        preserveParams={preserveParams}
      />
    </nav>
  );
}

/**
 * Хелпер для server-pages: распарсить `page` и `pageSize` из
 * `searchParams`, ограничить разумным диапазоном, и вернуть срез.
 */
export function paginate<T>(
  items: readonly T[],
  searchParams: { page?: string; pageSize?: string } | undefined,
  defaults: { page?: number; pageSize?: number; allowed?: number[] } = {},
): {
  pageItems: T[];
  page: number;
  pageSize: number;
  total: number;
} {
  const allowed = defaults.allowed ?? DEFAULT_SIZES;
  const fallbackSize = defaults.pageSize ?? 20;
  const fallbackPage = defaults.page ?? 1;
  let pageSize = Number(searchParams?.pageSize ?? fallbackSize);
  if (!Number.isInteger(pageSize) || pageSize <= 0) pageSize = fallbackSize;
  if (!allowed.includes(pageSize)) pageSize = fallbackSize;
  let page = Number(searchParams?.page ?? fallbackPage);
  if (!Number.isInteger(page) || page < 1) page = 1;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) page = totalPages;
  const from = (page - 1) * pageSize;
  const pageItems = items.slice(from, from + pageSize);
  return { pageItems, page, pageSize, total };
}
