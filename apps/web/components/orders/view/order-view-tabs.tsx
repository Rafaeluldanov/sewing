/**
 * `OrderViewTabs` — линейка вкладок управленческой карточки заказа
 * (`/admin/orders/[id]`, view-mode).
 *
 * Аналог `OrderDetailTabs`, но завязан на новый
 * `ORDER_VIEW_TABS` (Производство / Паспорта / Операции / Сводно по
 * заказу / Потребности / Сигнальный образец / История). Реализация
 * сознательно простая: переиспользуем
 * существующий CSS `.order-detail-tabs*` (см. `globals.css §«Order
 * workspace v2 — tabs»`), чтобы стилистика не разъезжалась с
 * create- и edit-режимами карточки.
 *
 * Почему client-компонент (раньше был серверный со «голым» `<Link>`):
 * вкладка живёт в `?tab=…`, то есть переключение — это обычная
 * навигация Next. По умолчанию она (а) скроллит страницу в самый верх
 * и (б) не даёт никакой обратной связи, пока сервер рендерит новую
 * вкладку — карточка заказа тяжёлая, и менеджер видел «клик → прыжок
 * наверх → секунда пустоты». Поэтому здесь:
 *
 *   - `router.push(href, { scroll: false })` — позиция прокрутки не
 *     сбрасывается; если линейку вкладок уже увели вверх за экран,
 *     мягко возвращаем её в поле зрения (`scrollIntoView`), чтобы
 *     пользователь не оказался посреди чужой вкладки;
 *   - оптимистичная подсветка: активной сразу становится нажатая
 *     вкладка (`useTransition` + `pendingTab`), а не та, что пришла с
 *     сервера. Как только транзишен завершился, снова показываем
 *     серверный `activeTab` — отдельного стейта-«зеркала» и
 *     синхронизирующего `useEffect` тут нет специально (такой
 *     `useEffect` уже ронял списки админки, см.
 *     `AdminTableView`).
 *
 * Сам `<Link>` остаётся на месте: href настоящий, поэтому работают
 * средняя кнопка / Ctrl+клик / «открыть в новой вкладке» — мы
 * перехватываем только обычный левый клик.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type MouseEvent } from 'react';
import {
  ORDER_VIEW_TABS,
  type OrderViewTabId,
} from './order-view-tabs-config';

interface Props {
  orderId: string;
  activeTab: OrderViewTabId;
}

export function OrderViewTabs({ orderId, activeTab }: Props) {
  const router = useRouter();
  const navRef = useRef<HTMLElement | null>(null);
  const [pendingTab, setPendingTab] = useState<OrderViewTabId | null>(null);
  const [isPending, startTransition] = useTransition();

  // Пока идёт навигация — показываем нажатую вкладку, после — то, что
  // отдал сервер. Никакого состояния «догоняющего» пропс: как только
  // `isPending` спал, выражение само возвращается к `activeTab`.
  const shownTab = isPending && pendingTab ? pendingTab : activeTab;

  function handleClick(
    event: MouseEvent<HTMLAnchorElement>,
    tabId: OrderViewTabId,
    href: string,
  ) {
    // Ctrl/Cmd/Shift/Alt-клик и не-левая кнопка — отдаём браузеру
    // (открыть в новой вкладке / окне).
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    if (tabId === activeTab) return;

    setPendingTab(tabId);
    startTransition(() => {
      router.push(href, { scroll: false });
    });

    // Прокрутку не сбрасываем, но если линейка вкладок уже ушла вверх
    // за экран — подтягиваем её к верху вьюпорта, иначе новая вкладка
    // откроется «где-то посередине».
    const nav = navRef.current;
    if (nav && nav.getBoundingClientRect().top < 0) {
      nav.scrollIntoView({ block: 'start' });
    }
  }

  return (
    <nav
      ref={navRef}
      className="order-detail-tabs"
      aria-label="Разделы заказа"
      role="tablist"
      data-active-tab={shownTab}
      data-mode="view"
      aria-busy={isPending || undefined}
    >
      {ORDER_VIEW_TABS.map((tab) => {
        const isActive = tab.id === shownTab;
        const isTabPending = isPending && pendingTab === tab.id;
        const className = [
          'order-detail-tabs__link',
          isActive ? 'order-detail-tabs__link--active' : null,
          isTabPending ? 'order-detail-tabs__link--pending' : null,
        ]
          .filter(Boolean)
          .join(' ');
        const href = `/admin/orders/${orderId}?tab=${tab.id}`;
        return (
          <Link
            key={tab.id}
            href={href}
            prefetch={false}
            scroll={false}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
            className={className}
            data-tab={tab.id}
            onClick={(event) => handleClick(event, tab.id, href)}
          >
            <span className="order-detail-tabs__label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
