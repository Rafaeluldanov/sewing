'use client';

/**
 * `AdminSidebarHideToggle` — кнопка «Скрыть меню / Показать меню» для
 * страниц `/admin/*`, которые хочется смотреть на всю ширину окна
 * (первый потребитель — «Схема стенда» по заказу на экране у стенда).
 *
 * Как работает. Layout `/admin` (`app/admin/layout.tsx`) — серверный, и
 * состояние «меню спрятано» в нём не живёт. Поэтому кнопка не трогает
 * DOM layout-а руками, а просто НЕСЁТ на себе маркер
 * `data-admin-sidebar-hidden`, когда меню скрыто; CSS в `globals.css`
 * (блок «Admin UI 2.0 — sidebar layout») через
 * `.admin-layout:has([data-admin-sidebar-hidden])` переводит раскладку в
 * одну колонку и прячет `.admin-sidebar`. Тот же приём `:has()`, что и
 * `body:has(.admin-layout)` там же.
 *
 * Плюс такого маркера: уходишь со страницы (soft-навигация внутри
 * `/admin`) — кнопка размонтируется, маркер исчезает, меню возвращается
 * само. Никакого cleanup-а, который можно забыть.
 *
 * Выбор запоминается в `localStorage` под `storageKey` (по умолчанию —
 * общий ключ; странице лучше дать свой, чтобы «спрятал на стенде» не
 * значило «спрятал везде»). Инициализация — «показано», чтобы SSR и
 * первый клиентский рендер совпадали; сохранённое «скрыто» применяется
 * после mount (как `useCollapsedGroups` в `admin-sidebar.tsx`).
 *
 * На ≤ 900 px сайдбара нет (там мобильный drawer) — кнопка прячется
 * стилями `.admin-sidebar-hide-toggle`.
 */
import { useCallback, useEffect, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

const DEFAULT_KEY = 'admin-sidebar-hidden-v1';

interface Props {
  /** Ключ localStorage. Давать свой на страницу. */
  storageKey?: string;
  className?: string;
}

export function AdminSidebarHideToggle({ storageKey = DEFAULT_KEY, className }: Props) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(storageKey) === '1') setHidden(true);
    } catch {
      /* localStorage недоступен — работаем «меню показано» */
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setHidden((prev) => {
      const next = !prev;
      try {
        if (next) window.localStorage.setItem(storageKey, '1');
        else window.localStorage.removeItem(storageKey);
      } catch {
        /* persist необязателен — игнорируем */
      }
      return next;
    });
  }, [storageKey]);

  return (
    <button
      type="button"
      className={`admin-btn admin-btn--ghost admin-sidebar-hide-toggle${className ? ` ${className}` : ''}`}
      onClick={toggle}
      aria-pressed={hidden}
      title={hidden ? 'Показать боковое меню' : 'Скрыть боковое меню'}
      {...(hidden ? { 'data-admin-sidebar-hidden': '' } : {})}
    >
      {hidden ? (
        <PanelLeftOpen size={16} strokeWidth={1.6} aria-hidden />
      ) : (
        <PanelLeftClose size={16} strokeWidth={1.6} aria-hidden />
      )}
      {hidden ? 'Показать меню' : 'Скрыть меню'}
    </button>
  );
}
