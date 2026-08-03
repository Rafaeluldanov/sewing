'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { hidesMobileNav } from '@/lib/app-chrome';
import { Icon, type IconName } from './icon';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Префиксы, которые активируют этот пункт. */
  match: string[];
}

const HOME_ITEM: NavItem = {
  href: '/',
  label: 'Главная',
  icon: 'home',
  match: ['/'],
};
const WORK_ITEM: NavItem = {
  href: '/work',
  label: 'Работа',
  icon: 'work',
  match: ['/work', '/passports'],
};
const QC_ITEM: NavItem = { href: '/qc', label: 'ОТК', icon: 'qc', match: ['/qc'] };
const WTO_ITEM: NavItem = {
  href: '/wto',
  label: 'ВТО',
  icon: 'wto',
  match: ['/wto'],
};
const PACKING_ITEM: NavItem = {
  href: '/packing',
  label: 'Упаковка',
  icon: 'packing',
  match: ['/packing'],
};
const ORDERS_ITEM: NavItem = {
  href: '/orders',
  label: 'Заказы',
  icon: 'orders',
  match: ['/orders'],
};

interface Props {
  /** Видимость пункта «Главная» (рабочим ролям он не нужен). */
  showHome: boolean;
  /**
   * Видимость пункта «Работа» (рабочим ролям, у которых `/work` —
   * это и есть primary workspace, его прятать обязательно, иначе
   * получается дубль).
   */
  showWork: boolean;
  showQc: boolean;
  showWto: boolean;
  showPacking: boolean;
  showOrders: boolean;
}

/**
 * MobileNav — нижняя навигация для маленьких экранов (видна только
 * на ≤ 900 px, скрыта на десктопе через CSS). Намеренно компактная.
 *
 * ГДЕ рендерится: только там, где `hidesMobileNav` = false (см.
 * `apps/web/lib/app-chrome.ts`). Подвал всегда ведёт НАРУЖУ текущего
 * экрана, поэтому его нет:
 *   - в `/admin/*` — навигация там `AdminSidebar`, на телефоне её
 *     заменяет drawer «Меню»;
 *   - на ролевых терминалах (`/qc`, `/wto`, `/cutter`, `/constructor`,
 *     `/master`, `/shopfloor/display`) — это изолированные экраны
 *     роли, выход — «⋯ → Выйти» в `SeamstressActionsMenu`;
 *   - на `/work*` и `/packing`, которые ветвятся по роли: рабочий не
 *     должен получить снизу выход в управленческую часть, а менеджеру
 *     на том же URL остаётся верхняя шапка.
 * До этой правки проверки пути тут не было вообще, и ADMIN /
 * SHOP_MANAGER (а также любой совместитель с 2+ ролями, которого не
 * закрывает `singleWorkspace`) получали снизу меню со ссылками
 * наружу на КАЖДОМ экране приложения.
 *
 * Состав ссылок зависит от роли (см. матрицу в `apps/web/lib/rbac.ts`):
 *   - «Главная» — только для менеджеров/админов; для производственных
 *     ролей `/` редиректит в их primary workspace, поэтому отдельной
 *     вкладки «Главная» нет;
 *   - «Работа» — только для менеджеров/админов; для CUTTER /
 *     CUTTER_ASSISTANT / SEAMSTRESS / IRONING `/work` уже primary
 *     workspace и дублирующая вкладка не нужна; QC/PACKING туда не
 *     ходят;
 *   - QC / Packing / Orders — по матрице доступа;
 *
 * Если для роли все пункты скрыты (пример: SEAMSTRESS, у которой
 * primary workspace `/work` и нет других разделов), сам компонент
 * не рендерится — экран остаётся одним сфокусированным терминалом
 * (см. `isSingleWorkspaceRole`).
 */
export function MobileNav({
  showHome,
  showWork,
  showQc,
  showWto,
  showPacking,
  showOrders,
}: Props) {
  const pathname = usePathname() ?? '/';
  if (hidesMobileNav(pathname)) return null;
  const items: NavItem[] = [];
  if (showHome) items.push(HOME_ITEM);
  if (showWork) items.push(WORK_ITEM);
  if (showQc) items.push(QC_ITEM);
  if (showWto) items.push(WTO_ITEM);
  if (showPacking) items.push(PACKING_ITEM);
  if (showOrders) items.push(ORDERS_ITEM);
  if (items.length === 0) return null;
  return (
    <nav className="mobile-nav" aria-label="Основная навигация">
      <ul className="mobile-nav__list">
        {items.map((item) => {
          const isActive = item.match.some((p) =>
            p === '/' ? pathname === '/' : pathname.startsWith(p),
          );
          return (
            <li key={item.href}>
              <Link
                className="mobile-nav__link"
                href={item.href}
                style={isActive ? { color: 'var(--color-accent)' } : undefined}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="mobile-nav__icon" aria-hidden>
                  <Icon name={item.icon} size={22} />
                </span>
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
