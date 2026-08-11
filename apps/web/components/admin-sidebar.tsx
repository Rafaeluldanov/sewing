'use client';

/**
 * AdminSidebar — левая навигация админки (Admin UI 2.7).
 *
 * Структура колонки:
 *   - brand сверху;
 *   - nav (сгруппированные ссылки разделов) — flex: 1;
 *   - footer с «Настройки» + кнопкой «Выйти» (server action `logoutAction`),
 *     прижатый к низу.
 *
 * Навигация сгруппирована по доменам (Продажи / Технология / Производство /
 * Персонал / Снабжение / Финансы / Система). Группа — сворачиваемая секция
 * с заголовком-кнопкой и шевроном:
 *   - состояние «свёрнуто» запоминается в localStorage (ключ COLLAPSED_KEY);
 *   - группа, содержащая активный маршрут, всегда раскрыта принудительно
 *     (пользователь не теряет текущее место, свернуть «под собой» нельзя);
 *   - «Обзор» — headerless-группа сверху (label: null), не сворачивается.
 *
 * Sidebar — это:
 *   - фиксированная колонка ~240 px слева (только в `/admin/*`);
 *   - человекочитаемые названия (без кодов и id);
 *   - подсветка активного раздела через `--admin-primary-soft`;
 *   - кнопка «Меню» на ≤ 900 px (collapsible через `<details>`).
 *
 * Иконки строго `lucide-react`. Logout — `LogOut`, без агрессивного
 * красного: muted hover, чтобы не пугать менеджеров.
 *
 * Компонент сознательно client-only (`'use client'`): нужен `usePathname()`
 * для подсветки активного пункта и `useState`/`useEffect` для памяти
 * свёрнутых групп. Кнопка «Выйти» — `<form action={logoutAction}>`: server
 * action прокидывается как ссылка на функцию, Next.js сам построит POST.
 *
 * Десктопный sidebar и mobile drawer рендерят один и тот же `SidebarGroups`
 * (два независимых инстанса состояния, оба пишут в один ключ localStorage —
 * в каждый момент виден лишь один по media-query, live-синк между ними не
 * нужен).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BadgeRussianRuble,
  Box,
  Building2,
  ChevronDown,
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
  ShieldCheck,
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

interface NavGroup {
  /** Стабильный ключ для памяти свёрнутого состояния (localStorage). */
  key: string;
  /** Заголовок секции. `null` — headerless-группа (не сворачивается). */
  label: string | null;
  items: SidebarItem[];
}

/** Ключ localStorage со списком ключей свёрнутых групп. */
const COLLAPSED_KEY = 'admin-sidebar-collapsed-v1';

/**
 * Раньше набор пунктов зашивался в web-билд флагами `NEXT_PUBLIC_FEATURE_*`.
 * Под мультитенантность (Фаза 1) набор модулей приходит в РАНТАЙМЕ с сервера
 * (`GET /api/auth/me` → `modules`) и передаётся в `AdminSidebar`/
 * `AdminSidebarMobileToggle` пропсом `modules`, а `buildGroups` принимает его
 * параметром. Так один web-билд обслуживает тенантов с разным набором
 * модулей. Договор default-on и ключи модулей — `packages/shared/src/auth.ts`
 * (`ModuleFlags`, `isModuleEnabledValue`).
 *
 * Backend модули не гейтит: `/api/*` остаётся доступным под
 * `ADMIN`/`SHOP_MANAGER` всегда, `modules` прячут только UI-навигацию и
 * inline-блоки в карточках. Пункт под выключенным модулем просто не попадает
 * в свою группу; группа, оставшаяся без пунктов, отбрасывается целиком.
 */
function buildGroups(modules: ModuleFlags): NavGroup[] {
  const groups: NavGroup[] = [
    {
      key: 'overview',
      label: null,
      items: [
        { href: '/admin', label: 'Обзор', Icon: Home, match: ['/admin/overview'] },
      ],
    },
    {
      key: 'sales',
      label: 'Продажи',
      items: [
        { href: '/admin/orders', label: 'Заказы', Icon: Package, match: ['/orders'] },
        { href: '/admin/clients', label: 'Клиенты', Icon: Building2 },
      ],
    },
    {
      key: 'tech',
      label: 'Технология',
      items: [
        // Лекало семантически близко к техкарте — обе про «как устроено
        // изделие», потому «Номенклатура» открывает технологическую группу.
        ...(modules.patterns
          ? [{ href: '/admin/patterns', label: 'Номенклатура', Icon: Scissors }]
          : []),
        { href: '/admin/routes', label: 'Маршруты', Icon: Activity },
        { href: '/admin/operations', label: 'Операции', Icon: Scissors },
        {
          href: '/admin/constructor-tasks',
          label: 'Заявки конструктору',
          Icon: ClipboardList,
        },
      ],
    },
    {
      key: 'production',
      label: 'Производство',
      items: [
        {
          href: '/admin/display-screens',
          label: 'Цеховой монитор',
          Icon: MonitorSmartphone,
          match: ['/admin/display-screens'],
        },
        { href: '/admin/equipment', label: 'Оборудование', Icon: Factory },
        { href: '/admin/printers', label: 'Принтеры', Icon: Printer },
      ],
    },
    {
      key: 'staff',
      label: 'Персонал',
      items: [
        { href: '/admin/employees', label: 'Сотрудники', Icon: Users },
        // Справочник ролей: новую роль заводят здесь, а не правкой кода
        // (см. `apps/web/app/admin/roles`, `prisma/schema.prisma::AppRole`).
        { href: '/admin/roles', label: 'Роли', Icon: ShieldCheck },
        { href: '/admin/payroll', label: 'Зарплата', Icon: BadgeRussianRuble },
      ],
    },
    {
      key: 'supply',
      label: 'Снабжение',
      items: [
        // Цепочка закупа в порядке рабочего процесса:
        // потребность → поставщик → заказ → приёмка → склад (хранилище
        // результата в конце). Каждый шаг — под своим модулем.
        ...(modules.workshopNeeds
          ? [{ href: '/admin/workshop-needs', label: 'Потребность цеха', Icon: PackageSearch }]
          : []),
        ...(modules.suppliers
          ? [{ href: '/admin/suppliers', label: 'Поставщики', Icon: Truck }]
          : []),
        ...(modules.purchaseOrders
          ? [{ href: '/admin/purchase-orders', label: 'Заказы поставщикам', Icon: ShoppingCart }]
          : []),
        ...(modules.purchaseReceipts
          ? [{ href: '/admin/purchase-receipts', label: 'Приёмка поставок', Icon: ClipboardCheck }]
          : []),
        { href: '/admin/warehouses', label: 'Склады', Icon: Warehouse },
      ],
    },
    {
      key: 'finance',
      label: 'Финансы',
      items: [
        {
          href: '/admin/production-cost',
          label: 'Себестоимость',
          Icon: Box,
          match: ['/production-cost'],
        },
        ...(modules.treasury
          ? [{ href: '/admin/treasury', label: 'Казначейство', Icon: Wallet }]
          : []),
      ],
    },
    {
      key: 'system',
      label: 'Система',
      items: [{ href: '/admin/diagnostics', label: 'Диагностика', Icon: Search }],
    },
  ];
  // Группа без пунктов (например, тенант без снабжения) не рисует заголовок.
  return groups.filter((g) => g.items.length > 0);
}

function isActive(item: SidebarItem, pathname: string): boolean {
  if (item.href === '/admin') {
    if (pathname === '/admin') return true;
    return item.match?.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ?? false;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Память свёрнутых групп. Инициализация — пустое множество (всё раскрыто),
 * чтобы SSR и первый клиентский рендер совпадали (localStorage читается уже
 * после mount в useEffect). Свёрнутые группы «схлопнутся» после гидрации —
 * незаметный флэш только у того, кто их явно сворачивал.
 */
function useCollapsedGroups(): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      if (raw) {
        const arr: unknown = JSON.parse(raw);
        if (Array.isArray(arr)) {
          setCollapsed(new Set(arr.filter((x): x is string => typeof x === 'string')));
        }
      }
    } catch {
      /* localStorage недоступен — работаем «всё раскрыто» */
    }
  }, []);
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* persist необязателен — игнорируем */
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

function NavLinks({ items, pathname }: { items: SidebarItem[]; pathname: string }) {
  return (
    <ul>
      {items.map((item) => {
        const active = isActive(item, pathname);
        const Icon = item.Icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              className={
                'admin-sidebar__link' + (active ? ' admin-sidebar__link--active' : '')
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
  );
}

/**
 * Тело навигации: последовательность headerless-группы (Обзор) и
 * сворачиваемых секций. Используется и десктопным sidebar, и mobile drawer.
 */
function SidebarGroups({ groups, pathname }: { groups: NavGroup[]; pathname: string }) {
  const [collapsed, toggle] = useCollapsedGroups();
  return (
    <>
      {groups.map((group) => {
        if (!group.label) {
          return <NavLinks key={group.key} items={group.items} pathname={pathname} />;
        }
        const containsActive = group.items.some((i) => isActive(i, pathname));
        // Активную группу не сворачиваем — иначе активный пункт спрячется.
        const open = containsActive || !collapsed.has(group.key);
        return (
          <div className="admin-sidebar__group" key={group.key}>
            <button
              type="button"
              className="admin-sidebar__group-header"
              aria-expanded={open}
              onClick={() => toggle(group.key)}
            >
              <span className="admin-sidebar__group-title">{group.label}</span>
              <ChevronDown
                className={
                  'admin-sidebar__group-chevron' +
                  (open ? ' admin-sidebar__group-chevron--open' : '')
                }
                size={14}
                strokeWidth={1.8}
                aria-hidden
              />
            </button>
            {open ? <NavLinks items={group.items} pathname={pathname} /> : null}
          </div>
        );
      })}
    </>
  );
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
 * кнопкой «Выйти». Сознательно вынесена из основного списка групп: это
 * редко-используемая, но «всегда под рукой» управленческая страница
 * (реквизиты + подразделения), которой не место в потоке доменных секций.
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
  const groups = buildGroups(modules);
  return (
    <aside className="admin-sidebar" aria-label="Разделы админки">
      <div className="admin-sidebar__brand">
        <span className="admin-sidebar__brand-mark" aria-hidden>
          <Factory size={18} strokeWidth={1.6} />
        </span>
        <span className="admin-sidebar__brand-text">Админка</span>
      </div>
      <nav className="admin-sidebar__nav" aria-label="Навигация">
        <SidebarGroups groups={groups} pathname={pathname} />
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
 * без портала. Внутри лежит тот же `SidebarGroups` плюс «Настройки» +
 * «Выйти» внизу. Десктопный sidebar и mobile drawer — два разных DOM-узла,
 * которые прячутся друг от друга через CSS (`@media (max-width: 900px)`).
 */
export function AdminSidebarMobileToggle({ modules }: { modules: ModuleFlags }) {
  const pathname = usePathname() ?? '/admin';
  const groups = buildGroups(modules);
  return (
    <details className="admin-sidebar-mobile">
      <summary className="admin-sidebar-mobile__summary" aria-label="Открыть меню">
        <Menu size={18} strokeWidth={1.6} aria-hidden />
        <span>Меню</span>
      </summary>
      <nav className="admin-sidebar-mobile__panel" aria-label="Разделы админки">
        <SidebarGroups groups={groups} pathname={pathname} />
        <div className="admin-sidebar-mobile__footer">
          <SidebarSettingsLink active={isSettingsActive(pathname)} />
          <SidebarLogout />
        </div>
      </nav>
    </details>
  );
}
