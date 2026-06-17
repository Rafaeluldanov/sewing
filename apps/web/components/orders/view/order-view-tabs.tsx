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
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import Link from 'next/link';
import {
  ORDER_VIEW_TABS,
  type OrderViewTabId,
} from './order-view-tabs-config';

interface Props {
  orderId: string;
  activeTab: OrderViewTabId;
}

export function OrderViewTabs({ orderId, activeTab }: Props) {
  return (
    <nav
      className="order-detail-tabs"
      aria-label="Разделы заказа"
      role="tablist"
      data-active-tab={activeTab}
      data-mode="view"
    >
      {ORDER_VIEW_TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        const className = [
          'order-detail-tabs__link',
          isActive ? 'order-detail-tabs__link--active' : null,
        ]
          .filter(Boolean)
          .join(' ');
        const href = `/admin/orders/${orderId}?tab=${tab.id}`;
        return (
          <Link
            key={tab.id}
            href={href}
            prefetch={false}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
            className={className}
            data-tab={tab.id}
          >
            <span className="order-detail-tabs__label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
