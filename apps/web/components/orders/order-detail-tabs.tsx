/**
 * `OrderDetailTabs` — единый ряд вкладок мастера/карточки заказа.
 *
 * Используется и на `/admin/orders/new` (create-mode), и на
 * `/admin/orders/[id]` (view-mode), и на `/admin/orders/[id]/edit`
 * (edit-mode). Источник правды по списку вкладок и их лейблам —
 * `ORDER_DETAIL_TABS` в `order-detail-tabs-config.ts`. Этот файл
 * только рендерит линейку.
 *
 * Поведение:
 *   - view-mode (есть `orderId`): вкладки — обычные `<Link>` на
 *     `/admin/orders/<id>?tab=<id>`. `prefetch={false}` — нам не
 *     нужно eager-prefetch-ить все вкладки сразу, это server pages
 *     с тяжёлыми fetch-ами.
 *   - edit-mode (есть `orderId` + `editHref`): «Продукция» —
 *     активный edit-href; остальные ведут на просмотр
 *     `/admin/orders/<id>?tab=<id>`, чтобы переключение из edit
 *     по любой другой вкладке возвращало менеджера в обычный
 *     просмотр (мы не делаем edit для materials/operations/etc.).
 *   - create-mode (`orderId === null`): «Продукция» — активная и
 *     не-кликабельная (это активная вкладка); остальные — `disabled`
 *     с tooltip «Доступно после создания заказа.». Никаких href —
 *     до submit-а заказа просто не существует.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import Link from 'next/link';
import { Lock } from 'lucide-react';
import {
  ORDER_DETAIL_TABS,
  type OrderDetailTabId,
} from './order-detail-tabs-config';

interface Props {
  /** id заказа для построения href; `null` в create-mode. */
  orderId: string | null;
  /** Активная вкладка (по умолчанию `'product'`). */
  activeTab: OrderDetailTabId;
  /** Какие вкладки должны рендериться как `disabled` (с tooltip). */
  disabledTabs?: OrderDetailTabId[];
  /**
   * Опциональный href для активной «Продукции» в edit-mode.
   * В create-mode игнорируется (вкладка уже активная без перехода).
   */
  productEditHref?: string;
  /**
   * Подсказка-тултип для disabled-вкладок. Если не указано —
   * стандартный «Доступно после создания заказа.».
   */
  disabledHint?: string;
}

export function OrderDetailTabs({
  orderId,
  activeTab,
  disabledTabs,
  productEditHref,
  disabledHint,
}: Props) {
  const disabledSet = new Set(disabledTabs ?? []);
  const tooltip = disabledHint ?? 'Доступно после создания заказа.';

  return (
    <nav
      className="order-detail-tabs"
      aria-label="Разделы заказа"
      role="tablist"
      data-active-tab={activeTab}
    >
      {ORDER_DETAIL_TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        const isDisabled = disabledSet.has(tab.id);
        const className = [
          'order-detail-tabs__link',
          isActive ? 'order-detail-tabs__link--active' : null,
          isDisabled ? 'order-detail-tabs__link--disabled' : null,
        ]
          .filter(Boolean)
          .join(' ');

        // Disabled-вкладка: рендерим как `<button disabled>` —
        // чтобы клик не приводил никуда и было понятно, что это
        // «replanned for after submit». `aria-disabled` дублирует
        // визуальное состояние для скринридера.
        if (isDisabled) {
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={false}
              aria-disabled
              disabled
              className={className}
              title={tooltip}
              data-tab={tab.id}
            >
              <span className="order-detail-tabs__label">{tab.label}</span>
              <Lock
                size={12}
                strokeWidth={1.6}
                aria-hidden
                className="order-detail-tabs__icon"
              />
            </button>
          );
        }

        // Active product-tab в edit-mode (productEditHref задан) —
        // рендерим Link, чтобы менеджер мог перейти обратно «в edit»
        // даже из view-режима. В create-mode productEditHref не
        // используется и активная вкладка не кликабельна.
        if (orderId === null) {
          return (
            <span
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className={className}
              data-tab={tab.id}
            >
              <span className="order-detail-tabs__label">{tab.label}</span>
            </span>
          );
        }

        const href =
          isActive && productEditHref
            ? productEditHref
            : `/admin/orders/${orderId}?tab=${tab.id}`;
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
