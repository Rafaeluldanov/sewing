'use client';

/**
 * AdminSidebar — левая навигация админки (Admin UI 2.6).
 *
 * Структура колонки:
 *   - brand сверху;
 *   - nav (ссылки разделов) — flex: 1;
 *   - footer с кнопкой «Выйти» (server action `logoutAction`),
 *     прижатой к низу через `margin-top: auto` контейнера nav.
 *
 * Sidebar — это:
 *   - фиксированная колонка ~240 px слева (только в `/admin/*`);
 *   - человекочитаемые названия (без кодов и id);
 *   - подсветка активного раздела через `--admin-primary-soft`;
 *   - кнопка «Меню» на ≤ 900 px (collapsible через `<details>` —
 *     никакого client-state, чтобы оставаться compatible с RSC).
 *
 * Иконки строго `lucide-react`. Logout — `LogOut` из lucide-react,
 * без агрессивного красного: muted hover, чтобы не пугать менеджеров.
 *
 * Этот компонент сознательно client-only (`'use client'`) — нужен
 * `usePathname()` для подсветки активного пункта. Кнопка «Выйти» —
 * `<form action={logoutAction}>` внутри client-компонента: server
 * action прокидывается как ссылка на функцию, Next.js сам построит
 * корректный POST-эндпоинт.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Box,
  Building2,
  ClipboardCheck,
  ClipboardList,
  Factory,
  Home,
  LogOut,
  Menu,
  MonitorSmartphone,
  Package,
  PackageSearch,
  Printer,
  Scissors,
  Search,
  ShoppingCart,
  Truck,
  Users,
  Warehouse,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { logoutAction } from '@/app/(auth)/logout-action';
import { isFeatureEnabled } from '@/lib/feature-flags';

interface SidebarItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Дополнительные префиксы, которые тоже должны подсвечивать пункт. */
  match?: string[];
}

/**
 * Feature-flag для модуля «Лекала» (Patterns MVP-1, см.
 * `apps/api/src/modules/patterns/*` и
 * `docs/recon-soft-integration.md`).
 *
 * `process.env.NEXT_PUBLIC_*` инлайнится Next.js-ом во время сборки и
 * доступен в client-компонентах (`'use client'`) — в отличие от
 * server-only `process.env.FEATURE_PATTERNS`. Логика гейта:
 * `isFeatureEnabled` (см. `@/lib/feature-flags`) — модуль виден по
 * умолчанию (если переменная не задана), скрыт только при явном
 * `NEXT_PUBLIC_FEATURE_PATTERNS=0` / `false` / `off` / `no` /
 * `disabled`. Backend это никак не затрагивает — API остаётся
 * доступным под `ADMIN`/`SHOP_MANAGER`, чтобы можно было дёргать его
 * напрямую (curl / интеграционные тесты), пока UI прячется за флагом.
 */
const FEATURE_PATTERNS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_PATTERNS,
);

/**
 * Feature-flag для модуля «Потребность цеха» (Workshop Needs, Этап 4А,
 * см. `apps/api/src/modules/workshop-needs/*`,
 * `docs/recon-soft-integration.md §«Этап 4А»`). Та же логика, что у
 * `FEATURE_PATTERNS_ENABLED`: backend `/api/workshop-needs` доступен
 * под `ADMIN`/`SHOP_MANAGER` всегда, флаг гейтит только пункт в
 * sidebar (и блок в карточке заказа), чтобы выкатывать модуль
 * закупщика постепенно. Default-on (см. `isFeatureEnabled`).
 */
const FEATURE_WORKSHOP_NEEDS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS,
);

/**
 * Feature-flag для модуля «Поставщики» (Suppliers, Этап 5, см.
 * `apps/api/src/modules/suppliers/*`,
 * `docs/recon-soft-integration.md §«Этап 5»`). Та же логика, что у
 * `FEATURE_PATTERNS_ENABLED`/`FEATURE_WORKSHOP_NEEDS_ENABLED`:
 * backend `/api/suppliers` доступен под `ADMIN`/`SHOP_MANAGER`
 * всегда, флаг гейтит только пункт в sidebar (и selectы поставщика
 * в `WorkshopNeed`-форме). Default-on (см. `isFeatureEnabled`).
 */
const FEATURE_SUPPLIERS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_SUPPLIERS,
);

/**
 * Feature-flag для модуля «Заказы поставщикам» (Purchase Orders,
 * Этап 6А, см. `apps/api/src/modules/purchase-orders/*`,
 * `docs/recon-soft-integration.md §«Этап 6А»`). Та же логика, что у
 * `FEATURE_SUPPLIERS_ENABLED`: backend `/api/purchase-orders`
 * доступен под `ADMIN`/`SHOP_MANAGER` всегда, флаг гейтит только
 * пункт в sidebar и блоки в карточках workshop-need / order.
 * Default-on (см. `isFeatureEnabled`).
 */
const FEATURE_PURCHASE_ORDERS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_PURCHASE_ORDERS,
);

/**
 * Feature-flag для модуля «Приёмка поставок» (Purchase Receipts,
 * Этап 7А, см. `apps/api/src/modules/purchase-receipts/*`,
 * `docs/recon-soft-integration.md §«Этап 7А»`). Та же логика, что у
 * `FEATURE_PURCHASE_ORDERS_ENABLED`: backend
 * `/api/purchase-receipts` доступен под `ADMIN`/`SHOP_MANAGER`
 * всегда, флаг гейтит только пункт в sidebar и блоки в карточках
 * заказа покупателя / заказа поставщику. Default-on (см.
 * `isFeatureEnabled`).
 *
 * Сознательная граница MVP: PR — это фиксация факта поступления и
 * места хранения, не складская бухгалтерия. CellContent /
 * MaterialStock / FabricRoll этим модулем НЕ создаются.
 */
const FEATURE_PURCHASE_RECEIPTS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS,
);

function buildSections(): SidebarItem[] {
  const items: SidebarItem[] = [
    { href: '/admin', label: 'Обзор', Icon: Home, match: ['/admin/overview'] },
    {
      href: '/admin/orders',
      label: 'Заказы',
      Icon: Package,
      match: ['/orders'],
    },
    { href: '/admin/clients', label: 'Клиенты', Icon: Building2 },
    {
      href: '/admin/display-screens',
      label: 'Цеховой монитор',
      Icon: MonitorSmartphone,
      match: ['/admin/display-screens'],
    },
    { href: '/admin/employees', label: 'Сотрудники', Icon: Users },
    { href: '/admin/equipment', label: 'Оборудование', Icon: Factory },
    { href: '/admin/operations', label: 'Операции', Icon: Scissors },
    { href: '/admin/routes', label: 'Маршруты', Icon: Activity },
    { href: '/admin/tech-cards', label: 'Техкарты', Icon: ClipboardList },
    { href: '/admin/warehouses', label: 'Склады', Icon: Warehouse },
    { href: '/admin/printers', label: 'Принтеры', Icon: Printer },
    { href: '/admin/diagnostics', label: 'Диагностика', Icon: Search },
    {
      href: '/admin/production-cost',
      label: 'Себестоимость',
      Icon: Box,
      match: ['/production-cost'],
    },
  ];
  if (FEATURE_PATTERNS_ENABLED) {
    // Вставляем рядом с «Техкартами» — менеджеру так легче найти:
    // лекало семантически близко к техкарте, обе сущности про
    // «как устроено изделие».
    const techCardsIdx = items.findIndex(
      (i) => i.href === '/admin/tech-cards',
    );
    const insertAt = techCardsIdx >= 0 ? techCardsIdx + 1 : items.length;
    items.splice(insertAt, 0, {
      href: '/admin/patterns',
      label: 'Номенклатура',
      Icon: Scissors,
    });
  }
  if (FEATURE_WORKSHOP_NEEDS_ENABLED) {
    // «Потребность цеха» — рабочее место закупщика (Этап 4А). Кладём
    // следом за «Складами»: семантически это про «материалы», и
    // менеджеру логично искать пункт в нижней «логистической»
    // группе sidebar.
    const warehousesIdx = items.findIndex(
      (i) => i.href === '/admin/warehouses',
    );
    const insertAt = warehousesIdx >= 0 ? warehousesIdx + 1 : items.length;
    items.splice(insertAt, 0, {
      href: '/admin/workshop-needs',
      label: 'Потребность цеха',
      Icon: PackageSearch,
    });
  }
  if (FEATURE_SUPPLIERS_ENABLED) {
    // «Поставщики» — справочник контрагентов (Этап 5). Кладём
    // следом за «Потребностью цеха», чтобы оба «закупочных» пункта
    // были рядом. Если флаг workshop-needs выключен — встаём после
    // «Складов».
    const wnIdx = items.findIndex((i) => i.href === '/admin/workshop-needs');
    const fallbackIdx = items.findIndex((i) => i.href === '/admin/warehouses');
    const insertAt =
      wnIdx >= 0
        ? wnIdx + 1
        : fallbackIdx >= 0
          ? fallbackIdx + 1
          : items.length;
    items.splice(insertAt, 0, {
      href: '/admin/suppliers',
      label: 'Поставщики',
      Icon: Truck,
    });
  }
  if (FEATURE_PURCHASE_ORDERS_ENABLED) {
    // «Заказы поставщикам» — Этап 6А, закупочный документ. Кладём
    // следом за «Поставщиками», чтобы все «закупочные» пункты
    // (потребности → поставщики → заказы поставщикам) шли подряд.
    // Fallback-каскад: после «Поставщиков» → после «Потребностей» →
    // после «Складов» → в конец.
    const supIdx = items.findIndex((i) => i.href === '/admin/suppliers');
    const wnIdx = items.findIndex((i) => i.href === '/admin/workshop-needs');
    const whIdx = items.findIndex((i) => i.href === '/admin/warehouses');
    const insertAt =
      supIdx >= 0
        ? supIdx + 1
        : wnIdx >= 0
          ? wnIdx + 1
          : whIdx >= 0
            ? whIdx + 1
            : items.length;
    items.splice(insertAt, 0, {
      href: '/admin/purchase-orders',
      label: 'Заказы поставщикам',
      Icon: ShoppingCart,
    });
  }
  if (FEATURE_PURCHASE_RECEIPTS_ENABLED) {
    // «Приёмка поставок» — Этап 7А, документ фактической приёмки.
    // Кладём сразу за «Заказами поставщикам», чтобы цепочка
    // «потребности → поставщики → заказы поставщикам → приёмка»
    // читалась как естественная последовательность шагов закупа.
    // Fallback-каскад: после PO → после поставщиков → после
    // потребностей → после складов → в конец.
    const poIdx = items.findIndex(
      (i) => i.href === '/admin/purchase-orders',
    );
    const supIdx = items.findIndex((i) => i.href === '/admin/suppliers');
    const wnIdx = items.findIndex((i) => i.href === '/admin/workshop-needs');
    const whIdx = items.findIndex((i) => i.href === '/admin/warehouses');
    const insertAt =
      poIdx >= 0
        ? poIdx + 1
        : supIdx >= 0
          ? supIdx + 1
          : wnIdx >= 0
            ? wnIdx + 1
            : whIdx >= 0
              ? whIdx + 1
              : items.length;
    items.splice(insertAt, 0, {
      href: '/admin/purchase-receipts',
      label: 'Приёмка поставок',
      Icon: ClipboardCheck,
    });
  }
  return items;
}

const SECTIONS: SidebarItem[] = buildSections();

function isActive(item: SidebarItem, pathname: string): boolean {
  if (item.href === '/admin') {
    if (pathname === '/admin') return true;
    return item.match?.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ?? false;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function SidebarLogout() {
  return (
    <form action={logoutAction} className="admin-sidebar__logout-form">
      <button type="submit" className="admin-sidebar__logout">
        <span className="admin-sidebar__icon" aria-hidden>
          <LogOut size={18} strokeWidth={1.6} />
        </span>
        <span className="admin-sidebar__label">Выйти</span>
      </button>
    </form>
  );
}

export function AdminSidebar() {
  const pathname = usePathname() ?? '/admin';
  return (
    <aside className="admin-sidebar" aria-label="Разделы админки">
      <div className="admin-sidebar__brand">
        <span className="admin-sidebar__brand-mark" aria-hidden>
          <Factory size={18} strokeWidth={1.6} />
        </span>
        <span className="admin-sidebar__brand-text">Админка</span>
      </div>
      <nav className="admin-sidebar__nav" aria-label="Навигация">
        <ul>
          {SECTIONS.map((item) => {
            const active = isActive(item, pathname);
            const Icon = item.Icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={
                    'admin-sidebar__link' +
                    (active ? ' admin-sidebar__link--active' : '')
                  }
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="admin-sidebar__icon" aria-hidden>
                    <Icon size={18} strokeWidth={1.6} />
                  </span>
                  <span className="admin-sidebar__label">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="admin-sidebar__footer">
        <SidebarLogout />
      </div>
    </aside>
  );
}

/**
 * Мобильная «открывалка» sidebar. `<details>` — без client-state,
 * без портала. Внутри лежит копия nav-ссылок плюс «Выйти» внизу.
 * Десктопный sidebar и mobile drawer — два разных DOM-узла, которые
 * прячутся друг от друга через CSS (`@media (max-width: 900px)`).
 */
export function AdminSidebarMobileToggle() {
  const pathname = usePathname() ?? '/admin';
  return (
    <details className="admin-sidebar-mobile">
      <summary className="admin-sidebar-mobile__summary" aria-label="Открыть меню">
        <Menu size={18} strokeWidth={1.6} aria-hidden />
        <span>Меню</span>
      </summary>
      <nav className="admin-sidebar-mobile__panel" aria-label="Разделы админки">
        <ul>
          {SECTIONS.map((item) => {
            const active = isActive(item, pathname);
            const Icon = item.Icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={
                    'admin-sidebar__link' +
                    (active ? ' admin-sidebar__link--active' : '')
                  }
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="admin-sidebar__icon" aria-hidden>
                    <Icon size={18} strokeWidth={1.6} />
                  </span>
                  <span className="admin-sidebar__label">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="admin-sidebar-mobile__footer">
          <SidebarLogout />
        </div>
      </nav>
    </details>
  );
}
