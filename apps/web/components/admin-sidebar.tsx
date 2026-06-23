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
  BadgeRussianRuble,
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
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { logoutAction } from '@/app/(auth)/logout-action';
import type { ModuleFlags } from '@sewing/shared/auth';

interface SidebarItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Дополнительные префиксы, которые тоже должны подсвечивать пункт. */
  match?: string[];
}

/**
 * Раньше тут жили `const FEATURE_*_ENABLED = isFeatureEnabled(process.env
 * .NEXT_PUBLIC_FEATURE_*)` — флаги зашивались в web-билд на этапе сборки.
 * Под мультитенантность (Фаза 1 дорожной карты) набор модулей приходит в
 * РАНТАЙМЕ с сервера (`GET /api/auth/me` → `modules`) и передаётся в
 * `AdminSidebar`/`AdminSidebarMobileToggle` пропсом `modules`, а
 * `buildSections` принимает его параметром. Так один web-билд обслуживает
 * тенантов с разным набором модулей. Договор default-on и ключи модулей —
 * `packages/shared/src/auth.ts` (`ModuleFlags`, `isModuleEnabledValue`).
 *
 * Backend модули не гейтит: `/api/*` остаётся доступным под
 * `ADMIN`/`SHOP_MANAGER` всегда, `modules` прячут только UI-навигацию и
 * inline-блоки в карточках.
 */
function buildSections(modules: ModuleFlags): SidebarItem[] {
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
    {
      href: '/admin/payroll',
      label: 'Зарплата',
      Icon: BadgeRussianRuble,
    },
    { href: '/admin/equipment', label: 'Оборудование', Icon: Factory },
    { href: '/admin/operations', label: 'Операции', Icon: Scissors },
    { href: '/admin/routes', label: 'Маршруты', Icon: Activity },
    { href: '/admin/tech-cards', label: 'Техкарты', Icon: ClipboardList },
    {
      href: '/admin/constructor-tasks',
      label: 'Заявки конструктору',
      Icon: ClipboardList,
    },
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
  if (modules.patterns) {
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
  if (modules.workshopNeeds) {
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
  if (modules.suppliers) {
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
  if (modules.purchaseOrders) {
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
  if (modules.purchaseReceipts) {
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
  if (modules.treasury) {
    // «Казначейство» — журнал движения ДС (Фаза 0). Кладём рядом с
    // «Себестоимостью», образуя UI-кластер «Финансы». Fallback — в конец.
    const pcIdx = items.findIndex(
      (i) => i.href === '/admin/production-cost',
    );
    const insertAt = pcIdx >= 0 ? pcIdx + 1 : items.length;
    items.splice(insertAt, 0, {
      href: '/admin/treasury',
      label: 'Казначейство',
      Icon: Wallet,
    });
  }
  return items;
}

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

/**
 * Pinned-ссылка на «Настройки компании» в футере sidebar — рядом с
 * кнопкой «Выйти». Сознательно вынесена из основного списка
 * `SECTIONS`: это редко-используемая, но «всегда под рукой»
 * управленческая страница (реквизиты + подразделения), которой не
 * место в общем потоке доменных разделов.
 *
 * Подсветка активного состояния — по тому же `usePathname` шаблону,
 * что у обычных ссылок sidebar.
 */
function SidebarSettingsLink({ active }: { active: boolean }) {
  return (
    <Link
      href="/admin/company-settings"
      className={
        'admin-sidebar__link' + (active ? ' admin-sidebar__link--active' : '')
      }
      aria-current={active ? 'page' : undefined}
    >
      <span className="admin-sidebar__icon" aria-hidden>
        <Settings size={18} strokeWidth={1.6} />
      </span>
      <span className="admin-sidebar__label">Настройки</span>
    </Link>
  );
}

function isSettingsActive(pathname: string): boolean {
  return (
    pathname === '/admin/company-settings' ||
    pathname.startsWith('/admin/company-settings/')
  );
}

export function AdminSidebar({ modules }: { modules: ModuleFlags }) {
  const pathname = usePathname() ?? '/admin';
  const sections = buildSections(modules);
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
          {sections.map((item) => {
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
        <SidebarSettingsLink active={isSettingsActive(pathname)} />
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
export function AdminSidebarMobileToggle({
  modules,
}: {
  modules: ModuleFlags;
}) {
  const pathname = usePathname() ?? '/admin';
  const sections = buildSections(modules);
  return (
    <details className="admin-sidebar-mobile">
      <summary className="admin-sidebar-mobile__summary" aria-label="Открыть меню">
        <Menu size={18} strokeWidth={1.6} aria-hidden />
        <span>Меню</span>
      </summary>
      <nav className="admin-sidebar-mobile__panel" aria-label="Разделы админки">
        <ul>
          {sections.map((item) => {
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
          <SidebarSettingsLink active={isSettingsActive(pathname)} />
          <SidebarLogout />
        </div>
      </nav>
    </details>
  );
}
