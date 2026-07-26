/**
 * Вкладки «Активные» / «Архив» над списком раздела админки.
 *
 * Серверный компонент — просто две ссылки со счётчиками; активная
 * вкладка приходит из `searchParams.tab`. Вынесено в общий компонент,
 * потому что раздела девять и в каждом это один и тот же кусок разметки
 * (`.admin-tabs` / `.admin-tab`, см. `globals.css`).
 *
 * Договорённость по URL: активная вкладка — без параметра
 * (`/admin/routes`), архив — `?tab=archive`. Так старые ссылки и
 * закладки продолжают открывать активный список.
 */
import Link from 'next/link';

export interface AdminArchiveTabsProps {
  /** Базовый путь списка, например `/admin/routes`. */
  basePath: string;
  /** Текущая вкладка. */
  tab: 'active' | 'archive';
  /** Счётчик активных записей. */
  activeCount: number;
  /** Счётчик записей в архиве. */
  archiveCount: number;
  /** Подпись активной вкладки (по умолчанию «Активные»). */
  activeLabel?: string;
  /** Фильтры, которые надо сохранить при переключении вкладки. */
  preserveParams?: Record<string, string | undefined>;
}

export function AdminArchiveTabs({
  basePath,
  tab,
  activeCount,
  archiveCount,
  activeLabel = 'Активные',
  preserveParams = {},
}: AdminArchiveTabsProps) {
  const href = (target: 'active' | 'archive') => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(preserveParams)) {
      if (v !== undefined && v !== '') sp.set(k, v);
    }
    if (target === 'archive') sp.set('tab', 'archive');
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="admin-tabs">
      <Link
        href={href('active')}
        className={`admin-tab ${tab === 'active' ? 'admin-tab--active' : ''}`}
        aria-current={tab === 'active' ? 'page' : undefined}
      >
        {activeLabel} ({activeCount})
      </Link>
      <Link
        href={href('archive')}
        className={`admin-tab ${tab === 'archive' ? 'admin-tab--active' : ''}`}
        aria-current={tab === 'archive' ? 'page' : undefined}
      >
        Архив ({archiveCount})
      </Link>
    </div>
  );
}
