/**
 * Единый источник истины: у каких путей есть СОБСТВЕННЫЙ каркас и
 * глобальные шапка/подвал из `apps/web/app/layout.tsx` там не нужны.
 *
 * Зачем один список. Раньше `AppHeader` прятал верхнюю шапку по паре
 * «роль + путь» (`role === 'CUTTER' && isCutterPath`), а `MobileNav`
 * не проверял путь вообще — только роль. В итоге на ролевом терминале,
 * открытом ADMIN'ом, SHOP_MANAGER'ом или совместителем с телефона,
 * оказывалось три навигации сразу: старая шапка со всеми admin-
 * ссылками, новый `.employee-toolbar` и старый нижний подвал.
 * Терминалы — изолированные экраны роли, выхода в управленческую
 * часть на них быть не должно, поэтому проверка теперь по ПУТИ.
 *
 * Правило: страница со своим каркасом сама отвечает за выход
 * (в терминалах это `SeamstressActionsMenu` «⋯ → Выйти», в админке —
 * `admin-sidebar-mobile` с полным списком разделов).
 *
 * Потребители: `components/app-header.tsx`, `components/mobile-nav.tsx`.
 */

/**
 * Терминалы, у которых свой каркас у ВСЕГО раздела, включая
 * подстраницы: `/cutter/lays/:id`, `/master/...`.
 */
const TERMINAL_SECTIONS = ['/cutter', '/constructor', '/master'] as const;

/**
 * Терминалы, у которых терминал — РОВНО корневой путь. Подстраницы
 * (`/qc/passports/:id`, `/wto/...`) — обычные экраны для менеджера,
 * там глобальная навигация остаётся, как и была до этой правки.
 * `/shopfloor/display` — зальной монитор: fullscreen у любой роли.
 */
const TERMINAL_PAGES = ['/qc', '/wto', '/shopfloor/display'] as const;

/**
 * Страницы, которые ВЕТВЯТСЯ ПО РОЛИ: рабочему рендерят терминал,
 * менеджеру — управленческий вид на том же URL.
 *
 *   - `/work*` — швея / помощник раскройщика получают «mobile clean»
 *     экран, ADMIN — легаси-экран работы (`app/work/page.tsx`);
 *   - `/packing` — упаковщик получает scan-driven `PackingTerminal`,
 *     ADMIN — «Управленческий вид: список коробок»
 *     (`app/packing/page.tsx`).
 *
 * Подвал режем тут у ВСЕХ: рабочий (и особенно совместитель с 2+
 * ролями, которого не спасает `singleWorkspace`) не должен получать
 * снизу выход в управленческую часть. А вот шапку менеджеру
 * оставляем — на управленческом виде своего каркаса нет, и без неё
 * страница осталась бы вообще без навигации и выхода, в том числе на
 * десктопе. Точечные исключения по роли — в `app-header.tsx`.
 */
const ROLE_SPLIT_SECTIONS = ['/work'] as const;
const ROLE_SPLIT_PAGES = ['/packing'] as const;

/** Убирает хвостовой слэш, чтобы `/qc/` считался тем же, что `/qc`. */
function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
}

function matches(
  pathname: string,
  pages: readonly string[],
  sections: readonly string[],
): boolean {
  const p = normalize(pathname);
  return (
    pages.includes(p) ||
    sections.some((section) => p === section || p.startsWith(`${section}/`))
  );
}

/**
 * Админка. Навигация — `AdminSidebar`, на ≤ 900 px её заменяет
 * `<details>`-drawer «Меню» (см. `components/admin-sidebar.tsx`).
 */
export function isAdminChromePath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === '/admin' || p.startsWith('/admin/');
}

/** Страница логина — собственная вёрстка `AuthShell` с кнопкой «Войти». */
export function isLoginChromePath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === '/login' || p.startsWith('/login/');
}

/**
 * Ролевой терминал у ЛЮБОЙ роли: `/qc`, `/wto`, `/cutter`,
 * `/constructor`, `/master`, `/shopfloor/display`.
 */
export function isRoleTerminalPath(pathname: string): boolean {
  return matches(pathname, TERMINAL_PAGES, TERMINAL_SECTIONS);
}

/** Страница, которая ветвится по роли: `/work*`, `/packing`. */
export function isRoleSplitPath(pathname: string): boolean {
  return matches(pathname, ROLE_SPLIT_PAGES, ROLE_SPLIT_SECTIONS);
}

/**
 * У страницы есть свой каркас — глобальной ШАПКИ не рисуем ни одной
 * роли.
 */
export function hasOwnAppChrome(pathname: string): boolean {
  return (
    isAdminChromePath(pathname) ||
    isLoginChromePath(pathname) ||
    isRoleTerminalPath(pathname)
  );
}

/**
 * Нижний ПОДВАЛ не рисуем: он всегда ведёт наружу, поэтому режется и
 * на страницах, которые ветвятся по роли (там менеджеру остаётся
 * шапка, а рабочему — его собственный каркас).
 */
export function hidesMobileNav(pathname: string): boolean {
  return hasOwnAppChrome(pathname) || isRoleSplitPath(pathname);
}
