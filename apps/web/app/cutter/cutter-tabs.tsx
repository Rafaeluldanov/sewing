'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Вкладки верхнего уровня кабинета раскройщика: **Раскрой · Выпуск ·
 * Стеллаж**.
 *
 * Это три режима работы за раскройным столом, а не блоки одной простыни:
 *   - «Раскрой» (`/cutter`) — подкрой и очередь задач; внутри задачи
 *     раскройщик закрывает расклады кнопкой «Расклад готов»;
 *   - «Выпуск» (`/cutter/release`) — очередь заказов, по которым закрыт
 *     хотя бы один расклад, и печать паспортов по раскладу;
 *   - «Стеллаж» (`/cutter/shelf`) — размещение выпущенного кроя в ячейку.
 *
 * Счётчик на «Выпуске» — прямая связь между вкладками: каждый закрытый
 * расклад увеличивает число паспортов, ожидающих печати, и раскройщик
 * видит это, не переключаясь. Считается на сервере в `cutter/layout.tsx`
 * (`listOrdersReadyForRelease` → строки со `status = 'NEW'`).
 *
 * Ссылки, а не клиентские табы-состояния: каждая вкладка — самостоятельный
 * RSC-роут со своей загрузкой данных, работают «назад/вперёд» и закладки.
 * Все пути лежат под `/cutter/*`, потому что чистая учётка `CUTTER` заперта
 * middleware на этот префикс (см. `apps/web/middleware.ts`).
 *
 * Клиентский компонент нужен ровно для одного: layout в App Router не знает
 * текущий путь, а `usePathname()` знает. Данные (счётчик) по-прежнему
 * считает сервер и передаёт пропом — никакого фетча на клиенте.
 */
export type CutterTab = 'cut' | 'release' | 'shelf';

const TABS: Array<{ key: CutterTab; href: string; label: string }> = [
  { key: 'cut', href: '/cutter', label: 'Раскрой' },
  { key: 'release', href: '/cutter/release', label: 'Выпуск' },
  { key: 'shelf', href: '/cutter/shelf', label: 'Стеллаж' },
];

/** Определяем активную вкладку по пути: `/cutter/[id]` — это тоже «Раскрой». */
function tabFromPath(pathname: string): CutterTab {
  if (pathname.startsWith('/cutter/release')) return 'release';
  if (pathname.startsWith('/cutter/shelf')) return 'shelf';
  return 'cut';
}

export function CutterTabs({
  active,
  releaseCount = 0,
}: {
  /** Явно заданная активная вкладка; по умолчанию — из текущего пути. */
  active?: CutterTab;
  /**
   * Сколько заказов ждут выпуска паспортов (строки очереди со статусом
   * `NEW`). 0 — бейдж не рисуем: пустой счётчик на вкладке только шумит.
   */
  releaseCount?: number;
}) {
  const pathname = usePathname();
  const activeTab = active ?? tabFromPath(pathname ?? '/cutter');
  return (
    <nav className="cutter-tabs" aria-label="Режим работы">
      {TABS.map((t) => {
        const isActive = t.key === activeTab;
        return (
          <Link
            key={t.key}
            href={t.href}
            prefetch={false}
            className={'cutter-tabs__tab' + (isActive ? ' is-active' : '')}
            aria-current={isActive ? 'page' : undefined}
          >
            {t.label}
            {t.key === 'release' && releaseCount > 0 ? (
              <span
                className="cutter-tabs__count"
                title="Заказы, по которым можно выпускать паспорта"
              >
                {releaseCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
