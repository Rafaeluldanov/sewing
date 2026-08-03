'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { hasOwnAppChrome } from '@/lib/app-chrome';

interface Props {
  /**
   * Роль текущего пользователя (или undefined для анонима).
   *
   * Основное решение «рисовать шапку или нет» принимается по ПУТИ
   * (`hasOwnAppChrome`, см. `apps/web/lib/app-chrome.ts`): у админки,
   * логина и ролевых терминалов есть собственный каркас. Роль нужна
   * только для двух точечных исключений, которые по пути не
   * выражаются, — см. ниже в теле компонента.
   */
  role?: string;
  children: ReactNode;
}

/**
 * Регулярка путей выпуска паспорта: `/orders/<id>/passports/new`
 * (одиночный) и `/orders/<id>/passports/new-demo` (серийный — основной
 * для помощника раскройщика). `new[\w-]*` ловит и любой будущий
 * `/passports/new-*`-вариант, чтобы тёмный header не «протекал» на
 * сфокусированный экран помощника при добавлении новых под-флоу.
 */
const PASSPORT_NEW_RE = /^\/orders\/[^/]+\/passports\/new[\w-]*\/?$/;

/**
 * Тонкий клиентский враппер вокруг основной шапки приложения.
 *
 * Логика рендера:
 *   - у страницы есть свой каркас (`hasOwnAppChrome`) — админка,
 *     логин, ролевой терминал — шапки нет НИ У ОДНОЙ роли. Раньше
 *     терминалы прятали шапку по паре «роль + путь», из-за чего
 *     ADMIN / SHOP_MANAGER, открывшие чужой терминал, получали поверх
 *     него полное меню с ссылками в админку. Терминал — изолированный
 *     экран роли, выхода в управленческую часть на нём быть не должно;
 *   - роли `DISPLAY` и `SHOPFLOOR_MASTER` — шапки нет ни на одной
 *     странице. Обе заперты на своём экране (`middleware.ts`), и обе
 *     проверки остаются safety net'ом: если редирект когда-нибудь
 *     отвалится, шапка у них всё равно не появится;
 *   - `/work*` и `/packing` ветвятся по роли (`isRoleSplitPath`):
 *     рабочему рендерится терминал со своим каркасом, менеджеру — на
 *     том же URL управленческий вид, у которого своего каркаса нет.
 *     Поэтому шапка тут режется по роли, как и раньше: сними её у
 *     всех — и ADMIN останется на управленческом виде вообще без
 *     навигации и выхода, в том числе на десктопе. Подвал на этих
 *     путях режется у всех — см. `hidesMobileNav`;
 *   - `CUTTER_ASSISTANT` на странице выпуска паспорта
 *     (`/orders/:id/passports/new*`) — единственный сфокусированный
 *     flow внутри управленческого раздела `/orders`, поэтому
 *     исключение тоже по роли: менеджеру там навигация нужна.
 *
 * Проверка пути идёт ПЕРВОЙ (до чтения роли), чтобы шапка не «мигнула»
 * во время гидрации client-роутинга.
 *
 * Сами ссылки/кнопки навигации остаются server-rendered и
 * передаются как `children`: это сохраняет возможности RSC для
 * `<Link>` / server actions внутри `<LogoutButton />` и не ломает
 * smoke-тест на текст layout.tsx.
 */
export function AppHeader({ role, children }: Props) {
  const pathname = usePathname() ?? '';
  if (hasOwnAppChrome(pathname)) return null;
  if (role === 'DISPLAY' || role === 'SHOPFLOOR_MASTER') return null;
  const isWorkPath = pathname === '/work' || pathname.startsWith('/work/');
  if (isWorkPath && (role === 'SEAMSTRESS' || role === 'CUTTER_ASSISTANT'))
    return null;
  const isPackingPath = pathname === '/packing' || pathname === '/packing/';
  if (isPackingPath && role === 'PACKING') return null;
  if (role === 'CUTTER_ASSISTANT' && PASSPORT_NEW_RE.test(pathname)) return null;
  return <header className="app-header">{children}</header>;
}
