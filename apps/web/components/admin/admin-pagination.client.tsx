'use client';

/**
 * PageSizeSelect — крошечный client-компонент для смены `pageSize`
 * без явной кнопки «Применить». Меняет `?pageSize=…` через
 * `router.push`, сбрасывая `page` в 1, и сохраняет остальные query-
 * параметры (фильтры списка, и т.п.).
 */
import { useRouter } from 'next/navigation';

interface Props {
  basePath: string;
  pageSize: number;
  options: number[];
  preserveParams: Record<string, string | undefined>;
}

export function PageSizeSelect({
  basePath,
  pageSize,
  options,
  preserveParams,
}: Props) {
  const router = useRouter();
  return (
    <div className="admin-pagination__size">
      <label htmlFor="admin-page-size">На странице:</label>
      <select
        id="admin-page-size"
        defaultValue={pageSize}
        onChange={(e) => {
          const next = e.currentTarget.value;
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(preserveParams)) {
            if (v !== undefined && v !== '') params.set(k, v);
          }
          params.set('page', '1');
          params.set('pageSize', next);
          router.push(`${basePath}?${params.toString()}`);
        }}
      >
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}
