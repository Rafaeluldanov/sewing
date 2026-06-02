'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

interface Props {
  /**
   * Роль текущего пользователя (или undefined для анонима).
   * Нужна, чтобы скрывать тяжёлый header у ролей, у которых рабочий
   * экран должен быть полностью «белым», без верхнего меню:
   *   - SEAMSTRESS на `/work*` (см. ТЗ «упрощение /work для SEAMSTRESS»);
   *   - CUTTER_ASSISTANT на `/work*` и на странице выпуска паспорта
   *     (см. ТЗ «упрощение UX помощника раскройщика»);
   *   - QC на `/qc` (scan-driven role-terminal по той же модели, что и
   *     швея, — см. `apps/web/app/qc/qc-terminal.tsx`);
   *   - IRONING на `/wto` (полный аналог `/qc` для ВТО — см.
   *     `apps/web/app/wto/wto-terminal.tsx`);
 *   - PACKING на `/packing` (scan-driven терминал упаковщика — см.
 *     `apps/web/app/packing/packing-terminal.tsx`);
 *   - DISPLAY на любой странице — это учётка под большой монитор,
 *     header только мешает; плюс на `/shopfloor/display` header
 *     прячется у любой роли, чтобы экран можно было раскрыть на весь
 *     монитор без перекрытия (см. `app/shopfloor/display/page.tsx`).
 *   - SHOPFLOOR_MASTER на любой странице — мобильный терминал
 *     `/master`, единственная доступная страница совпадает с primary
 *     workspace (см. `apps/web/lib/rbac.ts`,
 *     `apps/web/middleware.ts`); глобальный header только мешает
 *     scan-driven flow «открой вызов → сканируй QR сотрудника».
 *     Дополнительно header прячется на самом `/master` у любой роли
 *     (ADMIN/SHOP_MANAGER могут открыть тот же экран на телефоне —
 *     см. `MASTER_PAGE_ALLOWED_ROLES`), чтобы fullscreen-режим
 *     работал одинаково (см. `app/master/page.tsx` и `body:has(
 *     .master-page)` правила в `globals.css`).
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
 * Тонкий клиентский враппер вокруг основного шапки приложения.
 *
 * Логика рендера:
 *   - на `/work` для роли `SEAMSTRESS` — header полностью скрыт,
 *     чтобы экран был «белым и сфокусированным» (logout вынесен в
 *     `SeamstressActionsMenu`, информация о пользователе уже есть в
 *     RoleHeaderCard, дублировать не нужно);
 *   - на `/work*` и `/orders/:id/passports/new` /
 *     `/orders/:id/passports/new-demo` для роли
 *     `CUTTER_ASSISTANT` — то же самое: ему нужен один сфокусированный
 *     flow «Выпустить паспорт», глобальная навигация мешает (logout
 *     вынесен в три-точечное меню `SeamstressActionsMenu`, оно же
 *     используется для CUTTER_ASSISTANT);
 *   - для всех остальных страниц/ролей — рендерим как раньше.
 *
 * Сами ссылки/кнопки навигации остаются server-rendered и
 * передаются как `children`: это сохраняет возможности RSC для
 * `<Link>` / server actions внутри `<LogoutButton />` и не ломает
 * smoke-тест на текст layout.tsx.
 */
export function AppHeader({ role, children }: Props) {
  const pathname = usePathname() ?? '';
  // Admin UI 2.5 — на всех `/admin/*` верхний header полностью скрыт.
  // Sidebar (`AdminSidebar`) — единственная навигация, дублировать
  // его шапкой не нужно. Скрываем заранее (до проверок ролей), чтобы
  // header не «мигнул» во время гидрации client-роутинга.
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/');
  if (isAdminPath) return null;
  const isWorkPath = pathname === '/work' || pathname.startsWith('/work/');
  const isPassportNewPath = PASSPORT_NEW_RE.test(pathname);
  // QC «терминал» — это ровно `/qc` (без подстраниц `/qc/passports/:id`,
  // на которых остаётся обычная навигация для менеджеров/админа).
  const isQcTerminalPath = pathname === '/qc' || pathname === '/qc/';
  // ВТО role-terminal по той же логике (см. `apps/web/app/wto/page.tsx`).
  const isWtoTerminalPath = pathname === '/wto' || pathname === '/wto/';
  // Упаковщик: терминалом считается ровно `/packing`. Для менеджера/
  // админа это просто страница со списком, header им оставляем.
  const isPackingTerminalPath =
    pathname === '/packing' || pathname === '/packing/';
  // Экран цеха для большого монитора — fullscreen friendly: header
  // прячем у любой роли, потому что страница для трансляции, а не
  // для оператора. Менеджер тоже может зайти посмотреть и не должен
  // спотыкаться о навигацию (back-кнопка браузера всегда работает).
  const isShopfloorDisplayPath =
    pathname === '/shopfloor/display' || pathname === '/shopfloor/display/';
  // Мобильный терминал мастера цеха — fullscreen, по той же модели
  // что и `/shopfloor/display`: header убираем у любой роли, чтобы
  // ADMIN/SHOP_MANAGER, открывшие `/master` на своём телефоне (см.
  // `MASTER_PAGE_ALLOWED_ROLES`), получили тот же опыт без верхней
  // панели. Подстраницы `/master/*` зарезервированы под будущие
  // под-экраны мастера и тоже считаются терминалом.
  const isMasterPath = pathname === '/master' || pathname.startsWith('/master/');
  // Кабинет раскройщика — терминал по той же модели, что `/work`:
  // верхней панели нет, действия сотрудника живут в `.employee-toolbar`
  // (см. `apps/web/app/cutter/layout.tsx`).
  const isCutterPath = pathname === '/cutter' || pathname.startsWith('/cutter/');

  const hideForSeamstress = role === 'SEAMSTRESS' && isWorkPath;
  const hideForCutterAssistant =
    role === 'CUTTER_ASSISTANT' && (isWorkPath || isPassportNewPath);
  const hideForQc = role === 'QC' && isQcTerminalPath;
  const hideForIroning = role === 'IRONING' && isWtoTerminalPath;
  const hideForPacking = role === 'PACKING' && isPackingTerminalPath;
  const hideForDisplay = role === 'DISPLAY' || isShopfloorDisplayPath;
  // Сама роль SHOPFLOOR_MASTER заперта middleware'ом на `/master`
  // (см. `apps/web/middleware.ts`), но проверку по роли оставляем
  // как safety net: если когда-нибудь редирект отвалится, header
  // у мастера всё равно не появится.
  const hideForShopfloorMaster =
    role === 'SHOPFLOOR_MASTER' || isMasterPath;
  const hideForCutter = role === 'CUTTER' && isCutterPath;

  if (
    hideForSeamstress ||
    hideForCutterAssistant ||
    hideForQc ||
    hideForIroning ||
    hideForPacking ||
    hideForDisplay ||
    hideForShopfloorMaster ||
    hideForCutter
  )
    return null;
  return <header className="app-header">{children}</header>;
}
