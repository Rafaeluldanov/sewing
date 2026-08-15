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

/**
 * Дополнительная вкладка между «Активными» и «Архивом». Заведена под
 * «Черновики» базы знаний: там у записи три состояния, а не два.
 * Опциональна — девять существующих разделов её не передают и не
 * меняются.
 */
export interface AdminArchiveTabsExtra {
  /** Значение `?tab=` для этой вкладки. */
  key: string;
  label: string;
  count: number;
}

export interface AdminArchiveTabsProps {
  /** Базовый путь списка, например `/admin/routes`. */
  basePath: string;
  /**
   * Текущая вкладка. `'active' | 'archive'` у большинства разделов;
   * строка — потому что раздел может добавить свои через `extraTabs`.
   */
  tab: string;
  /** Счётчик активных записей. */
  activeCount: number;
  /** Счётчик записей в архиве. */
  archiveCount: number;
  /** Подпись активной вкладки (по умолчанию «Активные»). */
  activeLabel?: string;
  /** Вкладки раздела между «Активными» и «Архивом». */
  extraTabs?: AdminArchiveTabsExtra[];
  /** Фильтры, которые надо сохранить при переключении вкладки. */
  preserveParams?: Record<string, string | undefined>;
}

export function AdminArchiveTabs({
  basePath,
  tab,
  activeCount,
  archiveCount,
  activeLabel = 'Активные',
  extraTabs = [],
  preserveParams = {},
}: AdminArchiveTabsProps) {
  const href = (target: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(preserveParams)) {
      if (v !== undefined && v !== '') sp.set(k, v);
    }
    if (target !== 'active') sp.set('tab', target);
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
      {extraTabs.map((extra) => (
        <Link
          key={extra.key}
          href={href(extra.key)}
          className={`admin-tab ${tab === extra.key ? 'admin-tab--active' : ''}`}
          aria-current={tab === extra.key ? 'page' : undefined}
        >
          {extra.label} ({extra.count})
        </Link>
      ))}
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
