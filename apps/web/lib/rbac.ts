/**
 * Frontend RBAC helpers.
 *
 * Backend остаётся источником истины (см. `apps/api/src/modules/*` —
 * декораторы `@Roles(...)`). Эти хелперы нужны только UI:
 *   - спрятать пункты навигации, которые роль всё равно не сможет
 *     открыть;
 *   - на server-component страницах закрытых разделов вернуть
 *     forbidden state, не делая лишних API-запросов.
 *
 * Матрица доступности (см. `docs/api.md §1`, `docs/screens.md §1`):
 *
 *   /qc       → QC, SHOP_MANAGER, ADMIN
 *   /wto      → IRONING, SHOP_MANAGER, ADMIN
 *   /packing  → PACKING, SHOP_MANAGER, ADMIN
 *   /orders   → ADMIN, SHOP_MANAGER (+ CUTTER_ASSISTANT — read-only,
 *               чтобы помощник раскройщика мог выпустить паспорт)
 *
 * Для остальных разделов (/work, /earnings, /shopfloor, /admin/*)
 * проверки уже сделаны на местах — здесь их не дублируем.
 *
 * Видимость в навигации (header / mobile-nav) сознательно отделена
 * от технического доступа: для `CUTTER_ASSISTANT` backend оставляет
 * read-доступ к `/orders/*` (нужен для flow «Выпустить паспорт» —
 * `/work` → `/work/cut-orders` → `/orders/:id/passports/new`), но в
 * меню `/orders` и `/shopfloor` ему не показываются — у него есть
 * единственная точка входа `/work`. Это закрывают `canSeeOrdersMenu`
 * и `canSeeShopfloorMenu` ниже; технический `canSeeOrders` оставлен
 * как есть и продолжает использоваться в `app/orders/layout.tsx`.
 */

export type Role =
  | 'ADMIN'
  | 'SHOP_MANAGER'
  | 'CUTTER'
  | 'CUTTER_ASSISTANT'
  | 'SEAMSTRESS'
  | 'QC'
  | 'IRONING'
  | 'PACKING'
  /**
   * Read-only роль «Экран цеха» (shopfloor display, см.
   * `apps/web/app/shopfloor/display/page.tsx`). Используется для
   * учётки, под которой запущен большой монитор в зале: единственная
   * доступная страница — `/shopfloor/display`, никаких мутаций,
   * никакой навигации, любая попытка зайти в другой раздел
   * редиректится в display-экран (см. `apps/web/middleware.ts`).
   */
  | 'DISPLAY'
  /**
   * Мастер цеха (MVP, см. `docs/domain.md §«Мастер цеха»`,
   * `apps/web/app/master/page.tsx`). Мобильный терминал `/master`:
   * видит очередь открытых вызовов от рабочих, закрывает вызов сканом
   * QR сотрудника. Доступа к админке/ценам/маршрутам/техкартам/
   * пользователям на MVP нет — primary workspace и единственная
   * осмысленная точка входа совпадают.
   */
  | 'SHOPFLOOR_MASTER';

/**
 * Единственная страница, на которую пускают роль `DISPLAY`. Хранится
 * в одном месте, чтобы middleware и RBAC-хелперы не разъезжались.
 */
export const DISPLAY_ALLOWED_PATH = '/shopfloor/display';

/**
 * Единственная страница, на которую пускают роль `SHOPFLOOR_MASTER`.
 * Логика та же, что у `DISPLAY_ALLOWED_PATH`, чтобы middleware и
 * login redirect не разъезжались с RBAC-хелперами.
 */
export const SHOPFLOOR_MASTER_ALLOWED_PATH = '/master';

export const QC_ALLOWED_ROLES: readonly Role[] = ['QC', 'SHOP_MANAGER', 'ADMIN'];
export const WTO_ALLOWED_ROLES: readonly Role[] = [
  'IRONING',
  'SHOP_MANAGER',
  'ADMIN',
];
export const PACKING_ALLOWED_ROLES: readonly Role[] = [
  'PACKING',
  'SHOP_MANAGER',
  'ADMIN',
];
export const ORDERS_ALLOWED_ROLES: readonly Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
  'CUTTER_ASSISTANT',
];

/**
 * Роли, которым в UI-навигации (header + mobile-nav) показываем
 * пункт «Заказы». Это подмножество `ORDERS_ALLOWED_ROLES`, из
 * которого исключён `CUTTER_ASSISTANT`: технический read-доступ к
 * `/orders/*` ему остаётся (см. `canSeeOrders` и
 * `app/orders/layout.tsx`), но в меню он ходит только через `/work`.
 */
export const ORDERS_MENU_ALLOWED_ROLES: readonly Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
];

/**
 * Роли, которым НЕ показываем пункт «Цех» в навигации. Сама страница
 * `/shopfloor` остаётся доступной по прямой ссылке для всех
 * залогиненных ролей (RBAC закрывает только конкретные операции
 * внутри). Скрываем пункт у `CUTTER_ASSISTANT`, чтобы у помощника
 * раскройщика остался единственный рабочий вход — `/work`. У
 * `DISPLAY` навигации нет вовсе — он сидит на `/shopfloor/display`.
 */
export const SHOPFLOOR_MENU_HIDDEN_ROLES: readonly Role[] = [
  'CUTTER_ASSISTANT',
  'DISPLAY',
  // У мастера цеха единственная точка входа — `/master`.
  'SHOPFLOOR_MASTER',
];

/**
 * Доступ к admin/manager-разделам (`/admin/*`, в т.ч. управление
 * оборудованием — см. ADR-0017). Backend независимо защищает
 * `/api/equipment/*` и `/api/admin/*` через `@Roles('SHOP_MANAGER',
 * 'ADMIN')`.
 */
export const ADMIN_ALLOWED_ROLES: readonly Role[] = ['ADMIN', 'SHOP_MANAGER'];

/**
 * Доступ к управленческому модулю «Себестоимость выпуска»
 * (`/production-cost`, см. `docs/screens.md §17`). Backend независимо
 * защищает `/api/costs/production` через `@Roles('SHOP_MANAGER',
 * 'ADMIN')`.
 */
export const PRODUCTION_COST_ALLOWED_ROLES: readonly Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeQc(role: string | undefined | null): boolean {
  return !!role && (QC_ALLOWED_ROLES as readonly string[]).includes(role);
}

export function canSeeWto(role: string | undefined | null): boolean {
  return !!role && (WTO_ALLOWED_ROLES as readonly string[]).includes(role);
}

export function canSeePacking(role: string | undefined | null): boolean {
  return !!role && (PACKING_ALLOWED_ROLES as readonly string[]).includes(role);
}

/**
 * Видимость пунктов терминальных разделов (`/qc`, `/wto`, `/packing`)
 * в навигации (header + mobile-nav + плитки на `/`).
 *
 * Отделены от технических `canSeeQc` / `canSeeWto` / `canSeePacking`
 * по той же логике, что и `canSeeOrdersMenu` vs `canSeeOrders`:
 *
 *   - SHOP_MANAGER формально имеет read/write доступ к страницам
 *     терминалов (см. `*_ALLOWED_ROLES` выше и backend `@Roles(...)`),
 *     и должен сохранить возможность открыть их по прямой ссылке —
 *     `/qc/layout.tsx`, `/wto/layout.tsx`, `/packing/layout.tsx`
 *     продолжают пускать его, как раньше;
 *   - но в UI-меню начальник цеха работает через дашборды и
 *     admin-разделы, а пункты «Рабочее место» / «ОТК» / «ВТО» /
 *     «Упаковка» — это scan-driven терминалы операторов, в навигации
 *     менеджера они только засоряют шапку.
 *
 * ADMIN остаётся в матрице — у админа в шапке должен быть полный
 * набор разделов для отладки и поддержки.
 */
export function canSeeQcMenu(role: string | undefined | null): boolean {
  return canSeeQc(role) && role !== 'SHOP_MANAGER';
}

export function canSeeWtoMenu(role: string | undefined | null): boolean {
  return canSeeWto(role) && role !== 'SHOP_MANAGER';
}

export function canSeePackingMenu(role: string | undefined | null): boolean {
  return canSeePacking(role) && role !== 'SHOP_MANAGER';
}

export function canSeeOrders(role: string | undefined | null): boolean {
  return !!role && (ORDERS_ALLOWED_ROLES as readonly string[]).includes(role);
}

/**
 * Видимость пункта «Заказы» в навигации (header / mobile-nav).
 * Отличается от `canSeeOrders` тем, что не пускает CUTTER_ASSISTANT
 * (см. матрицу выше).
 */
export function canSeeOrdersMenu(role: string | undefined | null): boolean {
  return (
    !!role && (ORDERS_MENU_ALLOWED_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Видимость пункта «Цех» в навигации (header / mobile-nav). По
 * умолчанию доступно всем залогиненным ролям, кроме перечисленных в
 * `SHOPFLOOR_MENU_HIDDEN_ROLES`.
 */
export function canSeeShopfloorMenu(role: string | undefined | null): boolean {
  if (!role) return false;
  return !(SHOPFLOOR_MENU_HIDDEN_ROLES as readonly string[]).includes(role);
}

export function canSeeAdmin(role: string | undefined | null): boolean {
  return !!role && (ADMIN_ALLOWED_ROLES as readonly string[]).includes(role);
}

export function canSeeProductionCost(
  role: string | undefined | null,
): boolean {
  return (
    !!role &&
    (PRODUCTION_COST_ALLOWED_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Модель «одно рабочее окно на роль» (см. `docs/screens.md §1`).
 *
 * Для рабочих/производственных ролей у приложения единственная
 * осмысленная точка входа — их рабочий экран. Поэтому весь UI
 * (login redirect, корневой `/`, навигация) опирается на эту матрицу,
 * а не размазывает `if role === ...` по компонентам.
 *
 * Маппинг:
 *   SEAMSTRESS         → `/work`
 *   CUTTER_ASSISTANT   → `/work`
 *   CUTTER             → `/work` (отдельного раскройного экрана пока нет)
 *   IRONING            → `/wto` (scan-driven role-terminal,
 *                                см. `apps/web/app/wto/wto-terminal.tsx`)
 *   QC                 → `/qc`
 *   PACKING            → `/packing`
 *   SHOP_MANAGER       → `/`
 *   ADMIN              → `/`
 *
 * Для менеджерских ролей primary workspace — это домашняя плитка
 * `/`, она и есть multi-section app: им мы не редиректим и не
 * упрощаем навигацию.
 */
const PRIMARY_WORKSPACE_BY_ROLE: Record<Role, string> = {
  ADMIN: '/',
  SHOP_MANAGER: '/',
  CUTTER: '/work',
  CUTTER_ASSISTANT: '/work',
  SEAMSTRESS: '/work',
  IRONING: '/wto',
  QC: '/qc',
  PACKING: '/packing',
  // DISPLAY — учётка под большой монитор, единственная доступная
  // страница совпадает с primary workspace.
  DISPLAY: DISPLAY_ALLOWED_PATH,
  // SHOPFLOOR_MASTER — мобильный терминал `/master` (MVP).
  SHOPFLOOR_MASTER: SHOPFLOOR_MASTER_ALLOWED_PATH,
};

export function getPrimaryWorkspace(role: string | undefined | null): string {
  if (!role) return '/';
  return PRIMARY_WORKSPACE_BY_ROLE[role as Role] ?? '/';
}

/**
 * Роли, у которых единственная осмысленная точка входа — их рабочий
 * экран (терминал). Для них:
 *   - `/` редиректится на primary workspace;
 *   - login без явного `next` ведёт сразу на primary workspace;
 *   - глобальная навигация в шапке/нижнем меню скрыта (см.
 *     `canSeeHome` / `canSeeWorkTab` ниже и `MobileNav`).
 *
 * SEAMSTRESS и CUTTER_ASSISTANT — обязательный минимум. У них
 * `<AppHeader>` на `/work*` уже скрывается (см.
 * `components/app-header.tsx`), а нижняя навигация теряет смысл —
 * экран должен выглядеть как один сфокусированный терминал.
 *
 * QC попадает сюда же: `/qc` теперь scan-driven терминал по той же
 * модели (см. `apps/web/app/qc/qc-terminal.tsx`), `<AppHeader>` на
 * `/qc` тоже скрыт.
 *
 * IRONING — по той же модели: `/wto` scan-driven терминал
 * (см. `apps/web/app/wto/wto-terminal.tsx`), `<AppHeader>` скрыт.
 *
 * PACKING — `/packing` теперь scan-driven терминал упаковщика:
 * единое окно «открой смену → создай коробку → сканируй паспорта →
 * закрой коробку» (см. `apps/web/app/packing/packing-terminal.tsx`).
 * Глобальная навигация и `<AppHeader>` для него тоже скрыты.
 */
const SINGLE_WORKSPACE_ROLES: readonly Role[] = [
  'SEAMSTRESS',
  'CUTTER_ASSISTANT',
  'QC',
  'IRONING',
  'PACKING',
  // У DISPLAY вообще нет других экранов — большой монитор должен
  // выглядеть только как доска цеха, без header/mobile-nav.
  'DISPLAY',
  // У мастера цеха одна страница `/master` — мобильный терминал.
  'SHOPFLOOR_MASTER',
];

export function isSingleWorkspaceRole(
  role: string | undefined | null,
): boolean {
  return (
    !!role && (SINGLE_WORKSPACE_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Все производственные роли (рабочие). Для них «Главная» как
 * отдельная плитка не имеет смысла — primary workspace и есть их
 * домашний экран. Менеджеры/админы продолжают видеть `/` как
 * многосекционную домашнюю страницу.
 */
const WORKING_ROLES: readonly Role[] = [
  'CUTTER',
  'CUTTER_ASSISTANT',
  'SEAMSTRESS',
  'IRONING',
  'QC',
  'PACKING',
  // DISPLAY формально не «работает», но мы пользуемся тем же
  // механизмом «корневой `/` редиректит в primary workspace», чтобы
  // и аноним при логине, и попадание на `/` уводили в `/shopfloor/display`.
  'DISPLAY',
  // SHOPFLOOR_MASTER пользуется тем же механизмом: login и `/`
  // ведут в `/master` (см. `getPrimaryWorkspace`).
  'SHOPFLOOR_MASTER',
];

export function isWorkingRole(role: string | undefined | null): boolean {
  return !!role && (WORKING_ROLES as readonly string[]).includes(role);
}

/**
 * Роль «Экран цеха». Хелпер вынесен отдельно, чтобы layout/middleware
 * могли явно отличать «производственная роль с одним рабочим экраном»
 * от read-only display: у них пересекается поведение «hide nav», но
 * расходится set прав внутри API.
 */
export function isDisplayRole(role: string | undefined | null): boolean {
  return role === 'DISPLAY';
}

/**
 * Роль «Мастер цеха». Аналог `isDisplayRole` — middleware и login
 * используют этот хелпер, чтобы редиректить мастера на `/master`,
 * не пуская его на остальные разделы.
 */
export function isShopfloorMasterRole(
  role: string | undefined | null,
): boolean {
  return role === 'SHOPFLOOR_MASTER';
}

/**
 * Доступ к мобильному терминалу мастера цеха (`/master`, см.
 * `apps/web/app/master/page.tsx`). Сама роль — основной
 * пользователь; ADMIN и SHOP_MANAGER оставлены в матрице, чтобы
 * менеджер мог открыть тот же экран на своём телефоне без отдельной
 * учётки. Backend независимо защищает `/api/master-calls/*` через
 * `@Roles(...)`.
 */
export const MASTER_PAGE_ALLOWED_ROLES: readonly Role[] = [
  'SHOPFLOOR_MASTER',
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeMasterPage(role: string | undefined | null): boolean {
  return (
    !!role && (MASTER_PAGE_ALLOWED_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Доступ к экрану «Цех на большом мониторе» (`/shopfloor/display`).
 * Роли, которым разрешено его видеть:
 *   - `DISPLAY` — собственно учётка под монитор;
 *   - `ADMIN` / `SHOP_MANAGER` — менеджерам полезно открыть тот же
 *     экран на собственном устройстве, без редиректа.
 *
 * Backend пока не закрывает страницу отдельно — endpoints
 * `/api/shopfloor/state`, `/api/shopfloor/orders`,
 * `/api/dashboard/production` уже доступны нужным ролям, и
 * этого достаточно для read-only представления.
 */
export const DISPLAY_PAGE_ALLOWED_ROLES: readonly Role[] = [
  'DISPLAY',
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeDisplayPage(role: string | undefined | null): boolean {
  return (
    !!role && (DISPLAY_PAGE_ALLOWED_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Видимость кнопки «Мой QR-код» (см. компонент
 * `apps/web/components/employees/employee-qr-button.tsx` и endpoint
 * `GET /api/me/employee-qr`).
 *
 * Кого включаем:
 *   - Все производственные/терминальные роли
 *     (`CUTTER`, `CUTTER_ASSISTANT`, `SEAMSTRESS`, `QC`, `IRONING`,
 *     `PACKING`) — им QR нужен, чтобы мастер/терминал быстро
 *     идентифицировал сотрудника вместо ручного ввода логина.
 *   - `SHOPFLOOR_MASTER` — по обратной логике: мастер тоже может
 *     оказаться «сканируемым» (например, на чужом терминале), а UI
 *     в `/master` проще держит единый паттерн «у каждого рабочего
 *     экрана есть эта кнопка».
 *   - `ADMIN`, `SHOP_MANAGER` — для тестирования сканера и
 *     диагностики на пилоте: админу должно быть видно всё.
 *
 * Кого исключаем:
 *   - `DISPLAY` — это учётка под большой монитор без сотрудника;
 *     показывать на ней «мой QR» бессмысленно (сотрудника нет) и
 *     опасно (публичный экран).
 */
export const EMPLOYEE_QR_BUTTON_ALLOWED_ROLES: readonly Role[] = [
  'CUTTER',
  'CUTTER_ASSISTANT',
  'SEAMSTRESS',
  'QC',
  'IRONING',
  'PACKING',
  'SHOPFLOOR_MASTER',
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeEmployeeQrButton(
  role: string | undefined | null,
): boolean {
  return (
    !!role &&
    (EMPLOYEE_QR_BUTTON_ALLOWED_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Видимость пункта/тайла «Главная» в навигации.
 *
 * Для производственных ролей `/` либо редиректит на их primary
 * workspace, либо дублирует его — поэтому отдельный пункт «Главная»
 * не нужен. Для менеджеров/админов оставляем как есть.
 */
export function canSeeHome(role: string | undefined | null): boolean {
  if (!role) return false;
  return !isWorkingRole(role);
}

/**
 * Видимость пункта «Рабочее место» (`/work`) в навигации.
 *
 * Скрываем у тех, для кого `/work` уже является primary workspace
 * (SEAMSTRESS, CUTTER_ASSISTANT, CUTTER) — иначе получается
 * дублирующая вкладка. Скрываем и у QC/IRONING/PACKING — их рабочий
 * экран другой (`/qc`, `/wto`, `/packing`), на `/work` им заходить
 * незачем.
 *
 * SHOP_MANAGER тоже скрыт: терминал швеи начальнику цеха в меню не
 * нужен (работа идёт через дашборды и admin-разделы). Технический
 * доступ к `/work` у роли остаётся — backend и страница режут
 * операции по своим guards, а не по этому UI-флагу. Полный набор
 * пунктов сохраняем только за ADMIN — для отладки и поддержки.
 */
export function canSeeWorkTab(role: string | undefined | null): boolean {
  return role === 'ADMIN';
}
